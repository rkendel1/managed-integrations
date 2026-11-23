# Slice 4 — Customer product and verified maintenance lifecycle

What the customer buys is the transfer of responsibility for keeping an integration working. This slice
makes that tangible: a customer product that shows what we maintain and whether it is protected, and one
real maintenance lifecycle, from a provider change through detection, correction, validation, recovery and
verification to an outcome the customer can read.

Everything here runs against the **deterministic fixtures**. The provider change is **fictional** and made
at the fixture boundary (`docs/provider-docs/shopify/FIXTURE-webhook-changelog.md`). Nothing has been run
against a real Shopify store or a real NetSuite account.

## 1. The customer product

| Before (slices 1–3)                                          | Now                                                                                                                                                                                |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview with health, last sync, freshness, "Sync now"       | **Portfolio**: each maintained integration, its status with the rule that defines it, the reason, what we need from you                                                            |
| Delivery history (sync runs), Reliability metrics, Incidents | Removed from the customer app (operators keep them)                                                                                                                                |
| Deliveries page with retries and the reconciliation panel    | Operator only                                                                                                                                                                      |
| —                                                            | **Integration detail**: business process, what we are responsible for, last verified outcome, maintenance history                                                                  |
| —                                                            | **Maintenance event**: what changed, why it mattered, what we did, transactions affected and recovered, final outcome, "Zero transactions lost." only when proven, customer action |
| Connections, Integration settings                            | Kept: credentials and SKU mappings are genuinely the customer's decisions                                                                                                          |

Customer statuses (`STATUS_DEFINITIONS`, published with every status):

| Status               | Rule                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------- |
| Your input needed    | an open issue in `requires_action` (e.g. a SKU only the customer can map)                    |
| Maintaining          | any other open issue (we are handling it)                                                    |
| Verified             | no open issue; maintenance resolved **with verification evidence** in the last 7 days        |
| Protected            | no open issue; a reconciliation run **completed in the last 24 h with outcome `consistent`** |
| Verification pending | none of the above: no fresh evidence, so we do not claim protection                          |

A status is never derived from worker activity or a successful API call. Successful deliveries alone leave
an integration at "Verification pending" (tested).

## 2. The maintenance event

The maintenance event **is the incident row** (kind `input_contract_change`). It is not a second record.
Its status is the lifecycle state (`investigating → recovery → verification → resolved`, existing state
machine). Its fact columns, added in migration `0004`, hold the evidence. `incident_events` is the timeline
(actor, customer-visible flag). One authoritative record serves the customer story, the operator evidence
and the state machine.

| Fact            | Written by                   | Contents                                                                                                                                                                                                                                 |
| --------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `finding`       | detector (first held order)  | provider/topic, dependency (integration, upstream commit), expected (contract fields, baseline receipt + API version + key-path shape), observed (receipt, API version, violations, shape), shape diff, relevance, affected-window start |
| `investigation` | lifecycle                    | upstream code path (file, line, code, sha256, matches pinned commit), dry run of the **real** upstream mapping on the held input, risk                                                                                                   |
| `correction`    | lifecycle                    | rules, derivation evidence (changelog entry + sha256, baseline equivalence counts), `upstreamModified: false`, activation time, configuration version                                                                                    |
| `validation`    | lifecycle, before activation | four checks (below), passed/failed                                                                                                                                                                                                       |
| `accounting`    | lifecycle                    | per-order categories for the affected window, counts, `populationComplete`, `zeroLoss`                                                                                                                                                   |
| `verification`  | resolution                   | passed, verification run, method                                                                                                                                                                                                         |

The customer story (`presentEvent`) is a function of these facts. No sentence is stored as text and no
narrative is generated by a model.

## 3. The scenario (real, at the fixture boundary)

- **Change.** The Shopify fixture's `orders/create` webhook payload moves from version `2026-10` (with
  `line_items[].price` and `price_set`, as real Shopify sends) to `2027-01`, which no longer sends
  `line_items[].price` (`POST /__fixture/webhook-version`). The version travels in `X-Shopify-API-Version`
  and is now stored on each receipt.
- **Effect on the adopted code.** Upstream `src/mapping.js:11` computes
  `unitPrice: round2(Number(l.price))`, so a missing price becomes `NaN` and is sent as a `null` NetSuite
  rate. The fixture rejects that. Real NetSuite might instead price the line itself: the wrong amount,
  silently.

## 4. Detection

- **Input contract.** `UPSTREAM_INPUT_CONTRACT` (`packages/adopted-order-sync/src/input-contract.ts`) lists
  every payload field upstream reads, with its expected type and the upstream expression that reads it.
  `locateUpstreamRead` finds that expression in the installed, hash-pinned file, so the contract cannot
  drift from the code unnoticed.
- **Guard.** `executeDelivery` checks the contract **before** upstream runs. An order that violates it is
  `held`: no NetSuite call is made, and the attempt is recorded with its violations.
- **Finding.** The worker calls `recordInputContractFinding`, which opens one event per integration (dedupe)
  and records the finding against the last conforming receipt (the baseline).
- **Reproducibility.** The finding is computed only from stored receipts; recording it again yields the same
  event (tested).
- **Crash safety.** A tick sweep records held orders whose finding was lost and re-drives open events.

## 5. Correction (adoption boundary, upstream unmodified)

Upstream stays byte-identical to `d01b51d`. The correction is a per-integration **input compatibility rule**
in the integration configuration (`inputCompat`), applied in our wrapper before upstream mapping: copy a
value to the path upstream reads, never overwrite. It is derived, not pre-written:

1. **Documented replacement.** The provider changelog must name a replacement for the removed field at the
   observed version. This is the same mechanism as slice 1's playbook, which reads provider docs. Otherwise
   the event **escalates** to an operator and nothing changes (tested).
2. **Baseline equivalence.** In stored pre-change payloads, the old and replacement fields must carry equal
   values on every line where both appear. Otherwise it escalates.

## 6. Validation (separate from activation)

These checks use the real upstream code, before the rule is switched on:

1. upstream files byte-identical to the pinned commit;
2. regression: every stored baseline order maps to exactly the same canonical order with and without the rule;
3. every held order now satisfies the contract and maps without error;
4. the mapped quantities and unit prices equal Shopify's own record of each order (Admin GraphQL, an
   independent source).

Activation (configuration version +1) happens only if all four pass, and is recorded on the event.

## 7. Recovery, verification, transaction accounting

- **Held orders** are released (`held → pending`) and executed through the normal execution path (trigger
  `maintenance_recovery`). Attempt history shows `held → delivered`.
- **Missing orders.** A reconciliation of the affected window (explicit window, never joined with a
  scheduled run) finds orders whose webhooks never arrived. They are recovered through the slice-3
  recovery path.
- **Independent verification.** A second reconciliation run covers the same window. Then, for every order,
  a line-level NetSuite check against Shopify's own order record: exactly one sales order, same items,
  quantities and prices.
- **Accounting.** The affected window starts at the creation time of the last order delivered under the old
  contract. Each order is classified as delivered before the change, delayed, failed, discovered, delivered,
  excluded or unresolved. The population is complete only if the scan completed and **every held order is
  in it**. `zeroLoss` requires a complete population, nothing unresolved, no duplicates, and every
  non-excluded order verified.
- **Resolution guard.** `transitionIncident` refuses `resolved` for a maintenance event unless the
  persisted finding, validation, activated correction and accounting allow it, whoever calls it (tested).
  No AppPort capability writes event state at all.

## 8. Capabilities (AppPort; UI and MCP)

| Capability                      | Who                                     |                                                                                       |
| ------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------- |
| `portfolio.list@1`              | customer (own tenant), operator         | integrations with status, definition, reason, last verified outcome, customer actions |
| `portfolio.integration@1`       | same                                    | process, responsibilities, status, maintenance history                                |
| `maintenance.events.get@1`      | same                                    | the customer story; operators get the identical projection                            |
| `maintenance.events.evidence@1` | operator only (`integrations.read:any`) | the facts, reconciliation runs, full timeline, plus the same story                    |

There is no new authorization infrastructure; the existing tenant authorizer now also resolves `eventId`.

## 9. What we can truthfully claim today

- For one fictional but mechanically real provider change, the running system detects it, refuses to write
  wrong data, finds the affected code, applies a validated correction without modifying adopted code,
  recovers every affected and missing order, verifies them line by line, and tells the customer, with
  "Zero transactions lost" only when proven.

## 10. What we cannot claim yet

- Anything against real Shopify or NetSuite.
- Detection of changes that keep the payload shape valid but change meaning, for example a price that
  starts to include tax. The contract checks presence and type only.
- Corrections beyond "a field moved". Anything else escalates to an operator, and there is no operator
  action yet to resume an escalated event.
- Detection on the NetSuite side for the adopted flow, or changes in reconciliation's own GraphQL reads (the
  native flow's slice-1 schema-drift path covers its own reads).
- Customer notifications (email/Slack): the customer sees the story when they open the product.
- The "Verified" status window (7 days) and evidence freshness (24 h) are product decisions, not
  customer-configurable.
