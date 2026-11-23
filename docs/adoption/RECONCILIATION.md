# Slice 3 — Reconciliation and missing-delivery recovery (adopted flow)

Scope: the **adopted** Shopify → NetSuite flow (`adopted.shopify_erp_order_sync.netsuite`, executed by
`Milo-ai-HQ/shopify-erp-order-sync` @ `d01b51d`, unmodified). The slice-1 native engine keeps its own
reconciliation; each refuses the other's integrations.

All demonstrations and tests run against the **deterministic fixtures** in `packages/test-fixtures`
(a Shopify Admin GraphQL fixture and a NetSuite REST/SuiteQL fixture). Nothing here has been run
against a real Shopify store or a real NetSuite account. See "Gaps".

## 1. Contract

|                                 |                                                                                                                                                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authoritative source population | Shopify orders, read through the documented Admin GraphQL `orders` connection (`sortKey: CREATED_AT`, `query: created_at:>=… created_at:<…`), 50 per page                                                                     |
| Window                          | `config.reconcileFrom` (or the integration's creation time) → `now − reconcileGraceMinutes` (default 10; the grace leaves time for webhooks in flight)                                                                        |
| Destination identity            | NetSuite sales order with `externalId = shopify-<legacy order id>` — what the adopted code writes (`PUT salesOrder/eid:shopify-<id>`) — also matched by `otherRefNum = <order name>` to catch records created by someone else |
| Local evidence                  | `webhook_receipts` + `deliveries` (+ `delivery_attempts`) written by the slice-2 ingest/executor path. **Receipt history is not assumed complete**: the scan never infers "delivered" from local rows alone                   |
| Eligible                        | not cancelled; at least one line with a SKU (the adopted mapping refuses otherwise); ≤ 100 lines (the input must be reconstructable from one read)                                                                            |

### Classification (per order, per run)

| Classification                 | Rule (code: `classify()` in `packages/adopted-order-sync/src/reconcile.ts`)                                                                  | Recoverable                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `delivered`                    | local delivery `delivered` **and** exactly one NetSuite order with our externalId                                                            | —                                         |
| `missing_delivery`             | no local delivery, no NetSuite order by externalId or order name                                                                             | **yes**                                   |
| `pending_delivery`             | local delivery pending/running and not stuck                                                                                                 | no (in flight)                            |
| `failed_delivery`              | local delivery failed/rejected, or pending/running but stuck                                                                                 | yes (as a retry of the existing delivery) |
| `destination_exists_untracked` | NetSuite has our externalId but there is no local delivery                                                                                   | no (nothing to write)                     |
| `ambiguous`                    | more than one match, a match without our externalId, local "delivered" but NetSuite empty, or NetSuite has it while local says not delivered | no — review                               |
| `excluded`                     | ineligible (reason recorded)                                                                                                                 | no                                        |
| `undetermined`                 | NetSuite could not be read for this order; the run is `partial`                                                                              | no                                        |

## 2. Detection — durable, paginated, resumable, repeatable

- `reconciliation.start@1` inserts a `reconciliation_runs` row (existing table, new columns `cursor`,
  `pages_scanned`, `lease_owner`, `lease_expires_at`, `requested_by`). Start is serialized by
  `SELECT … FOR UPDATE` on the integration row; a run already in progress is joined (`deduplicated: true`).
- The scan is a pg-boss job (`adopted.reconcile`, singletonKey per run). Each page is committed in
  one transaction together with the cursor, fenced on `lease_owner` (2-minute lease, renewed per page).
  A worker that dies mid-scan leaves the cursor at the last committed page; the worker's tick sweep
  (`findOrphanedWork`) re-enqueues it and another worker resumes from the cursor.
- Items are upserted on `(run_id, source_order_id)`, so a re-delivered page cannot duplicate them.
- A Shopify failure ends the run `failed` with `outcome: partial` and the page reached; the next run
  starts over. A NetSuite failure marks only the affected items `undetermined` (run `partial`).
- Runs are repeatable and scheduled by the existing worker tick (`RECONCILE_INTERVAL_MINUTES`).

## 3. Recovery — through the adopted code, never by upsert alone

`reconciliation.recover@1` (≤ 50 orders; more than one requires `confirm: true`):

1. **Intent before execution** — per order, in one transaction: lock the item, accept only
   `missing_delivery` with no recovery yet (or a failed recovery → retry of the same delivery), insert
   the `deliveries` row with `ON CONFLICT DO NOTHING` on the idempotency key `shopify-<id>`, set the item
   `requested` with actor, AppPort request id and reason, and write `reconciliation.recovery_requested`
   to the audit log. Then enqueue `adopted.recover` (singletonKey per item).
2. **Job** (`executeRecovery`): atomically claim the item (`requested → executing`), then
   - **re-check the destination** in NetSuite: exactly one record with our externalId and the same
     name → record it, **no write**; any other match → `skipped`, classified `ambiguous`;
   - **re-read the order from Shopify** and re-check eligibility (e.g. cancelled since discovery → `skipped`/`excluded`);
   - build the execution input (`toUpstreamOrderInput`: the REST `orders/create` fields that upstream
     `src/mapping.js` reads) and store it as a `webhook_receipts` row (`origin: reconciliation`,
     disposition `recovery_input`). A real webhook that arrived meanwhile keeps precedence;
   - run `executeDelivery` — the **unmodified upstream** `syncOrder` with the slice-2 adapter, same
     claim/attempt/evidence path as webhooks (trigger `reconciliation_recovery`);
   - **verify**: `GET salesOrder/eid:shopify-<id>` and compare `otherRefNum` with the order name.
     `recovered` only if verified; an executor success that cannot be read back is `unverified`.
3. Transient provider failures put the item back to `requested` and throw, so pg-boss retries.
   Business rejections (e.g. SKU not in NetSuite) end `failed` with the upstream message, and can be
   recovered again after the cause is fixed.

### Duplicate and concurrency safety (all exercised by tests)

| Race                                     | Guard                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| two `start` calls                        | row lock on the integration; second joins the run                                                        |
| two scans of one run                     | lease fencing; page commits by a non-owner are rejected                                                  |
| two recover requests                     | item row lock + state check; one accepted, one refused                                                   |
| two recovery jobs                        | atomic `requested → executing` claim                                                                     |
| webhook arrives during recovery          | conflict-safe delivery insert; ingest **joins** the pending recovery (`joined_recovery`) — one execution |
| recovery after the webhook delivered     | refused at request (delivery already exists)                                                             |
| NetSuite gains the order after discovery | destination re-check: recorded as delivered, 0 attempts                                                  |
| foreign record appears                   | destination re-check: `skipped`/`ambiguous`, no write                                                    |
| worker crash mid-scan / mid-recovery     | lease expiry + tick sweep re-enqueues; resume from cursor / claim                                        |

## 4. AppPort capabilities (same for UI and MCP)

| Capability                 | Effect        | Notes                                                                                                   |
| -------------------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `reconciliation.start@1`   | consequential | `integrations.operate`; refuses non-adopted integrations (`CONFLICT`); audit `reconciliation.requested` |
| `reconciliation.runs@1`    | observation   | runs with counts, recovery progress, pages scanned                                                      |
| `reconciliation.items@1`   | observation   | exceptions first, filter by classification, `recoverable` flag                                          |
| `reconciliation.recover@1` | consequential | per-order accepted/refused; bulk needs `confirm`                                                        |

Tenant boundary: the existing `resourceTenantAuthorizer` resolves `integrationId` and now `runId`
(run → integration → tenant). Customers act on their own tenant; operators on any. Every invocation,
including denials, is recorded by the existing `auditLogTelemetrySink` (`appport.invocation`).

UI: the reconciliation panel is part of the existing deliveries page (`/app/…/deliveries` and
`/ops/…/deliveries`), rendered from these capabilities only.

## 5. Running it

```bash
make reset
```

```bash
make demo-reconcile
```

Evidence JSON is written to `/data/artifacts/evidence` in the container; copies of the runs used for
this slice are in `docs/evidence/runs/`.

## 6. Gaps

- **Fixtures only.** Shopify GraphQL behaviour (search syntax, `legacyResourceId`, price fields) is
  implemented from Shopify's documentation in the fixture; it has not been checked against a real store.
- **Input reconstruction is a documented mapping**, not Shopify's webhook body. Fields upstream does not
  read are not reconstructed. If upstream starts reading more fields, `toUpstreamOrderInput` must follow.
- **Verification is identity-level**: externalId + order name. Line items and amounts written by the
  adopted code are not compared.
- Orders with > 100 lines are `excluded`, not recovered.
- Only `orders/create` semantics. Edits, cancellations after delivery and refunds are not reconciled.
- `ambiguous` and `destination_exists_untracked` have no resolution action yet; they are listed for review.
- The scan window is by creation time; an order back-dated outside the window is not seen.

* In the demo stack both tenants use **one** NetSuite fixture account (and are kept apart only by distinct
  Shopify order-id ranges). Real tenants have separate NetSuite accounts. Two shops that write to one
  NetSuite account with the same `shopify-<id>` scheme would collide; reconciliation reports that as
  `destination_exists_untracked`/`ambiguous` and does not write.
