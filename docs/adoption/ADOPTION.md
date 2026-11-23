# Slice 2 — Existing repository adoption

**Outcome:** `Milo-ai-HQ/shopify-erp-order-sync` (MIT) is attached, unmodified, as the executor of the
Shopify `orders/create` → NetSuite sales order flow for tenant _Bluewave Supply_. It is operated by
Managed Integrations and governed through AppPort capabilities exposed to the UI and to MCP clients.
Everything below was verified against **deterministic provider fixtures**, not real Shopify/NetSuite.

Starting point: the remote's default branch `HEAD` (there is no `main`; `origin/HEAD` →
`claude/wizardly-fermat-x6gekb`), commit `315396a` ("appport"), which already contained the AppPort
capability layer (`packages/capabilities`, `integrations.list@1`, MCP at `/mcp`).

---

## A. Discovery (search order as specified)

| #   | Source      | Repository                                                                                                                            | License                             | Lang                  | Last activity         | What it actually is                                                                                 |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------- | --------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | workspace   | `rkendel1/managed-integrations` (our slice-1 engine)                                                                                  | ours                                | TS                    | 2026-11-23            | Polling GraphQL→NetSuite engine built from scratch in slice 1; fixture-verified only. Not adoption. |
| 2   | your GitHub | `rkendel1/opencreds` (= OOMOL **OpenConnector**, `@oomol-lab/open-connector`)                                                         | Apache-2.0                          | TS                    | 2026-07-12            | Agent action gateway, 1,070 providers.                                                              |
| 3   | public      | **`Milo-ai-HQ/shopify-erp-order-sync`**                                                                                               | MIT                                 | JS (Node ≥20, 0 deps) | 2026-09-28 (1 commit) | Shopify `orders/create` webhook → sales order in Priority / NetSuite / Business Central / Odoo.     |
| 4   | public      | `NangoHQ/nango`                                                                                                                       | **Elastic License 2.0**             | TS                    | 2026-11-23            | Integration platform (auth + syncs), Shopify and NetSuite supported.                                |
| 5   | public      | `airbytehq/airbyte`                                                                                                                   | NOASSERTION via API (not inspected) | Py/Java               | 2026-11-23            | ELT into warehouses; Shopify/NetSuite _sources_ (read-only). Wrong shape: no ERP writes.            |
| 6   | public      | `activepieces/activepieces`                                                                                                           | NOASSERTION via API (not inspected) | TS                    | 2026-11-23            | Workflow automation builder — a stated non-goal.                                                    |
| 7   | public      | `singer-io/tap-shopify`                                                                                                               | AGPL-3.0                            | Py                    | 2026-11-23            | Shopify extractor only; no NetSuite write; copyleft for a hosted service.                           |
| 8   | public      | `hotgluexyz/target-netsuite-v2`                                                                                                       | none                                | Py                    | 2026-11-16            | NetSuite loader; **no license → cannot be used**.                                                   |
| 9   | public      | `michel-adelino/shopify-netsuite`                                                                                                     | none                                | TS                    | 2026-10-15            | No license → cannot be used.                                                                        |
| 10  | public      | `HafizSalmanHabib/Shopify-NetSuite-Integration`                                                                                       | none                                | JS                    | 2024-10-01            | Inventory/customers; no license.                                                                    |
| 11  | public      | `kenput3r/shopify-plugins`                                                                                                            | 0BSD                                | TS                    | 2021-10-28            | Product preparation, not orders; stale.                                                             |
| 12  | public      | `brepre109/commerce-order-sync-lab`, `krunalp2801/inventory-sync-engine`, `rajachanna/NextGen-CommerceSync`                           | MIT                                 | Py/TS                 | 2026-09/10            | Labs/simulators; generic ERP or ERP→storefront stock; no NetSuite client.                           |
| 13  | public      | `fatihdemirtc/Shopify2erp`, `rkd453003-wq/maple-sync`, `TigBay/shopify-order-integration-hub`, `mohamednabil248/shopify-erpnext-sync` | none                                | C#/TS/PHP/Py          | 2026                  | No license (and/or other ERPs).                                                                     |
| 14  | public      | `ballerina-platform/module-ballerinax-netsuite`, `MichaelEPope/nsrestlet`, `unstackedapps/opensuitemcp`                               | Apache/MIT/NOASSERTION              | Ballerina/JS/TS       | 2026                  | NetSuite client libraries / MCP client — no synchronization behaviour.                              |

Searches: `gh api search/code` over your account (shopify, netsuite, webhook, reconcil, idempotency) and
`search/repositories` (shopify netsuite, netsuite connector, shopify order sync erp, shopify orders webhook erp,
named platforms). Rows 5–14 were screened on license/shape from metadata; rows 2–4 at source level.

## B. Source-level evaluations

### `Milo-ai-HQ/shopify-erp-order-sync` @ `d01b51d` (selected)

- **Tree:** `src/{server,webhook,mapping,sync,http,errors,cli}.js`, `src/adapters/{netsuite,priority,business-central,odoo}.js`, `mock-erp-api/server.js`, `test/sync.test.js`; 772 LOC, zero dependencies.
- **Inherited tests:** `node --test test/*.test.js` → **20/20 pass** (all four adapters against the in-process mock).
- **Execution path traced** (with our NetSuite fixture and an M2M token minted by Managed Integrations):
  `verifyShopifyHmac(raw)` → `toCanonicalOrder(payload)` → `createNetSuiteAdapter` → `syncOrder` → SuiteQL
  `customer.entityid` + `item.itemid` lookups (inline, quote-escaped literals) → `PUT salesOrder/eid:shopify-<id>`.
  Results: create → `created` (NetSuite 9001); resend → `created` again, **same record updated, no duplicate**;
  unknown SKU → `rejected` "Items not found in NetSuite: SKU-NOPE"; NetSuite 503 → `failed` after 1+3 calls.
- **Works:** HMAC on raw body; idempotent NetSuite upsert; business vs transient error classification; retry
  with exponential backoff (3 retries, 300 ms base) for network/429/5xx.
- **Incomplete / mock-only:** verified only against its own in-process mock; the mock treats a repeated eid PUT
  as a no-op (real NetSuite updates) — same result for identical payloads. `duplicate` status can never occur for
  NetSuite (`findExisting` returns null), so "first delivery" cannot be inferred from its result.
- **Hardcoded / unsafe for a managed service:** single tenant via process env; static bearer token
  (`NETSUITE_TOKEN`, no OAuth/refresh); no subsidiary (OneWorld accounts reject every order); `orders/create`
  only (no updates, no backfill, no reconciliation); **no persistence at all** — durability depends entirely on
  Shopify's webhook retry, and the webhook server answers synchronously (risk of Shopify's response deadline).
- **License:** MIT — suitable.

### `rkendel1/opencreds` (OpenConnector) — rejected

Shopify provider has exactly 11 actions, all blogs/pages/articles — **no orders**. NetSuite provider is generic
record CRUD over **TBA** (closed to new integrations from NetSuite 2027.1). Migrations define `connections`,
`oauth_*`, `runtime_tokens`, `runs` (action run log); no cursor, watermark, schedule or reconciliation. It is a
credential/action gateway, not synchronization software. Apache-2.0 would permit use; function does not fit.

### `NangoHQ/nango` — rejected on license

`LICENSE`: Elastic License 2.0 — "You may not provide the software to third parties as a hosted or managed
service…". That is this product. Not evaluated further.

### Slice-1 native engine (workspace) — not adoption

Strongest on durability (lease, cursor, reconciliation, 97 tests) but it is software we wrote, verified only
against fixtures. It remains the executor for tenant _Acme Outdoor_; it was not modified in this slice except
that its scheduler now selects only native-flow integrations (see D).

## C. Selection

| Criterion (importance)                     | shopify-erp-order-sync                  | opencreds             | nango      | native engine      |
| ------------------------------------------ | --------------------------------------- | --------------------- | ---------- | ------------------ |
| Working integration behaviour (critical)   | **Yes** — traced; fixture/mock only     | No orders             | n/a        | Yes — fixture only |
| Durable execution & persistence (critical) | **None**                                | Action log only       | —          | Yes                |
| Idempotency & retry safety (critical)      | Yes (eid upsert; retry classes)         | Generic               | —          | Yes                |
| License (critical)                         | MIT ✔                                   | Apache ✔              | **ELv2 ✘** | ours               |
| Maintainability                            | 772 LOC, 0 deps, readable               | 1,070 providers       | large      | ours               |
| Provider API correctness                   | Plausible (SuiteQL fields unverified)   | TBA (deprecated path) | —          | Plausible          |
| Isolate & operate                          | Pure functions; easy                    | service               | —          | —                  |
| AppPort compatibility                      | Called as a library behind capabilities | —                     | —          | —                  |
| Tests / reproducibility                    | 20 inherited tests                      | yes                   | —          | 97                 |
| Adoption effort                            | Small                                   | —                     | —          | n/a                |

**Selected: `shopify-erp-order-sync`.** It is the only candidate that is licensable _and_ actually implements
the candidate flow. It **fails the critical durability criterion on its own**; it was selected because that gap
is exactly a managed-service responsibility (durable receipt, outcome evidence, retry scheduling) that can be
added _at the boundary_ without modifying or replacing its execution. **Decision for you to confirm:** if you
would rather require durability inside the adopted software itself, no candidate qualifies and the finding is
"none suitable" (the native engine being our own code).

## D. Adoption boundary — responsibility matrix (one authoritative owner each)

| Responsibility                                                    | Adopted repository                            | Managed Integrations                                              | AppPort                          |
| ----------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------- | -------------------------------- |
| Provider API interaction (NetSuite lookups + upsert, its retries) | **Owner** (`adapters/netsuite.js`, `http.js`) | —                                                                 | —                                |
| Webhook authenticity                                              | **Owner** (`verifyShopifyHmac`)               | invokes it; checks shop ↔ tenant                                  | —                                |
| Data mapping                                                      | **Owner** (`mapping.js`)                      | supplies config (`customerByEmail`, `defaultCustomer`)            | —                                |
| Synchronization execution                                         | **Owner** (`syncOrder`)                       | hosts & schedules (pg-boss job)                                   | —                                |
| Retry: within one execution                                       | **Owner** (3 retries)                         | —                                                                 | —                                |
| Retry: across executions / after rejection                        | —                                             | **Owner** (backoff ≤5, manual retry)                              | authorizes manual retry          |
| Idempotency: destination                                          | **Owner** (eid upsert)                        | —                                                                 | —                                |
| Idempotency: receipt & duplicate invocations                      | —                                             | **Owner** (webhook-id dedupe, atomic claim/retry guard)           | —                                |
| Durable execution state                                           | — (has none)                                  | **Owner** (`webhook_receipts`, `deliveries`, `delivery_attempts`) | —                                |
| Customer identity / tenancy                                       | —                                             | **Owner** (users, sessions, tenants)                              | —                                |
| Provider authorization (NetSuite M2M tokens)                      | consumes a bearer token                       | **Owner** (connections, encrypted keys)                           | —                                |
| Capability authorization                                          | —                                             | supplies trusted identity + policy                                | **Owner** (authorizer pipeline)  |
| Capability discovery                                              | —                                             | —                                                                 | **Owner** (manifest)             |
| MCP exposure                                                      | —                                             | —                                                                 | **Owner** (`@appport/mcp`)       |
| Operational evidence: execution                                   | upstream result (recorded verbatim)           | **Owner** of the record                                           | —                                |
| Operational evidence: invocation                                  | —                                             | persists AppPort telemetry to `audit_log`                         | **Owner** of the record contents |
| Incident management                                               | —                                             | **Owner** (existing reliability rules, e.g. `records_rejected`)   | —                                |
| Customer experience                                               | —                                             | **Owner** (UI renders capabilities)                               | contract                         |

Not created: no sidecar, no second scheduler (pg-boss only), no parallel execution database, no capability
framework, no event registry. The upstream `server.js` is not run (MI hosts the endpoint so receipt is durable
and tenant-routed) — the only upstream behaviour intentionally replaced.

## E. Provenance

| Field                       | Value                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original repository         | https://github.com/Milo-ai-HQ/shopify-erp-order-sync                                                                                                                                                                                                                                                                  |
| License                     | MIT, © 2026 Milo (`LICENSE` shipped in the installed package)                                                                                                                                                                                                                                                         |
| Adopted commit              | `d01b51d95993598580cdcffda6537a6f20a10a3a` (branch `main`)                                                                                                                                                                                                                                                            |
| Attachment                  | pnpm dependency `shopify-sync: github:Milo-ai-HQ/shopify-erp-order-sync#d01b51d…`; lockfile `resolution: {commit: d01b51d…}`                                                                                                                                                                                          |
| Local modifications         | **None.** sha256 of every executed upstream file is recorded in `packages/adopted-order-sync/src/provenance.ts` and verified by test against the installed package.                                                                                                                                                   |
| Entry points used           | `webhook.js#verifyShopifyHmac`, `mapping.js#toCanonicalOrder`, `adapters/netsuite.js#createNetSuiteAdapter`, `sync.js#syncOrder`                                                                                                                                                                                      |
| Patch/fork strategy         | None needed. If a change becomes necessary (e.g. subsidiary), propose it upstream; fork only if refused, keeping history.                                                                                                                                                                                             |
| Upgrade strategy            | Change the commit in `package.json`, regenerate the lockfile, update `fileSha256` from an independent clone, run the inherited suite + adoption tests + `make demo-adopted`.                                                                                                                                          |
| Security / dependency risks | Zero runtime deps. Lockfile records the SSH-form repo id, so builds need `git` and an `insteadOf` HTTPS rewrite (done in the Dockerfile). Upstream builds SuiteQL with quote-escaped literals (SKU/customer codes) — escaping verified by reading; not fuzzed. Single-commit, single-author repository: bus factor 1. |

## F. AppPort integration (actual)

| Capability           | Effect            | Permission             | MCP tool           |
| -------------------- | ----------------- | ---------------------- | ------------------ |
| `deliveries.list@1`  | observation       | `integrations.read`    | `deliveries_list`  |
| `deliveries.get@1`   | observation       | `integrations.read`    | `deliveries_get`   |
| `deliveries.retry@1` | **consequential** | `integrations.operate` | `deliveries_retry` |

- Defined with `defineCapability` + `@appport/schema` in `packages/capabilities/src/capabilities/deliveries.ts`;
  registered in the existing application next to `integrations.list@1`.
- **Who:** customers get `integrations.read` + `integrations.operate` for their tenant; operators also
  `read:any` / `operate:any`. **Which tenant/resources:** `resourceTenantAuthorizer` (async, composed into the
  application authorizer) resolves `integrationId`/`deliveryId` to its tenant at the boundary.
  **Read-only vs mutating:** declared effect. **Evidence:** AppPort `TelemetrySink` → `audit_log`
  (`appport.invocation`, incl. refusals); retry also writes `delivery.retry_requested` with reason and AppPort
  request id; the resulting execution attempt carries `trigger {kind: manual_retry, principalId, appportRequestId, reason}`.
- UI (`/app/integrations/:id/deliveries`, `/ops/integrations/:id/deliveries`) and MCP call the same capabilities;
  a test asserts byte-equal results through `@appport/client` and an MCP client.

## G. Working vertical slice (reproducible)

```bash
make reset && make demo-adopted
```

Output (`docs/evidence/runs/demo-adopted-docker.log`): tenant identified via AppPort → adopted executor shown
with commit/license → signed webhook accepted → upstream creates NetSuite SO 9001 → unknown SKU rejected with the
NetSuite message → other tenant's MCP client refused (FORBIDDEN) → fixture stand-in creates the item →
`deliveries_retry` via MCP (duplicate refused with CONFLICT) → recovered as SO 9002 → evidence counts. 7 s.
Restart durability: `docs/evidence/runs/adopted-restart-docker.log`.

## H. New code

| Area                                         | Lines (+/−)                                     | Purpose                                                                       |
| -------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/adopted-order-sync/src`            | +631                                            | glue: provenance, contract, ingest, execute/retry, upstream type declarations |
| `packages/capabilities/src`                  | +449 / −17                                      | 3 capabilities, resource-tenant authorizer, permissions, telemetry→audit sink |
| `apps/api/src`                               | +100 / −29                                      | webhook route (raw body), runtime wiring                                      |
| `apps/worker/src`                            | +74 / −2                                        | `adopted.execute` handler, outbox sweep, native-only tick filter              |
| `packages/database`                          | ~30 hand-written + generated migration snapshot | `webhook_receipts`, `deliveries.receipt_id`                                   |
| `packages/reliability`, `packages/contracts` | +12                                             | freshness not applicable when commitment is 0; queue schema                   |
| `apps/web/src`                               | +230 / −15                                      | one deliveries page (customer + operator), links                              |
| `packages/test-fixtures`                     | +47 / −11                                       | upstream SuiteQL lookups, multi-certificate support, items/config controls    |
| tests                                        | +718                                            | adoption (10), boundary (8), e2e (3)                                          |
| scripts                                      | +342                                            | seed for the adopted tenant, MCP-driven demo                                  |
| Dockerfile/Makefile                          | +20 / −12                                       | git + HTTPS rewrite for the git dependency; `make demo-adopted`               |
| **Adopted repository**                       | **0**                                           | unmodified                                                                    |

## I. Gaps

- **Unverified against real Shopify and NetSuite.** Upstream SuiteQL fields (`customer.entityid`, `item.itemid`) and the REST webhook payload shape are plausible but unverified.
- **OneWorld:** upstream sends no subsidiary; every order on a OneWorld account is rejected. Needs an upstream change.
- **Scope of upstream:** `orders/create` only; no updates/cancellations, no backfill, no reconciliation for the adopted flow — a missed webhook is not detected.
- **Payload retention:** raw webhook bodies (contain customer PII) are stored encrypted indefinitely; no retention job yet.
- **Webhook secret:** one app-level `SHOPIFY_CLIENT_SECRET`; per-store custom-app secrets are not supported.
- **Invocation evidence** is written asynchronously (AppPort's sink contract is synchronous); a crash can lose the last records. Reads are now evidenced too, which grows `audit_log`.
- **Automatic retry** reschedules only `failed`; repeated identical webhooks for a `rejected` order re-execute it (as upstream would on a Shopify retry).
- No reliability incident is opened for transient adopted failures (only `records_rejected` via the existing rule); stuck work is visible (`stuck` flag) but not alerted.

## J. Next slice (recommended)

**Detect missed webhooks for the adopted flow using code that already exists.** The independent
reconciliation (`packages/reliability/src/reconciliation.ts`) reads Shopify order identities with its own
stable GraphQL query and finds NetSuite records by externalId — the same `shopify-<id>` the adopted code
writes. Running it on a schedule against the adopted integration turns the adopted executor's largest risk
(a webhook that never arrived is silently lost) into a visible `missing` finding and an incident.

Recovery of such an order is a **separate prerequisite**: `deliveries.retry` replays a stored webhook receipt,
and a missed order has none. Recovering it would need the order in the REST webhook shape the upstream mapping
consumes — either Shopify's webhook re-delivery or a fetch-and-shape step. Decide that only after detection
shows how often it happens.
