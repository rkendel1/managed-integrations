# Slice 6 — Integration portability and repeatable maintenance

The product test: adding an integration means implementing its provider-specific behaviour and business
semantics — not rebuilding onboarding, maintenance events, monitoring, the correction lifecycle, evidence, the
customer product or operator tooling. Proven by a second adopted integration, Stripe → QuickBooks
(`ledgerly`, docs/adoption/SECOND-INTEGRATION.md), running on the same mechanisms as Shopify → NetSuite.

## 1. Inventory before this slice (at `c8e2cce`, inspected in the code)

| Area                                                                                            | What it was                                                                                                       | Verdict                                                        |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Schema (`deliveries`, `webhook_receipts`, `reconciliation_*`, `incidents` facts, `adaptations`) | provider-neutral columns, some Shopify-named (`source_order_id`, `order_name`, `shop_domain`)                     | **generic tables**, Shopify-flavoured names (kept; documented) |
| `onboardings`                                                                                   | one row per tenant (assumed one integration)                                                                      | **hardcoded**: one integration per customer                    |
| `adopted-order-sync/onboarding.ts`                                                              | state machine + Shopify discovery + Shopify activation steps in one module                                        | generic machine **mixed with** Shopify specifics               |
| `adopted-order-sync/adaptation.ts`                                                              | lifecycle (history, audit, guards, rollback) + field-moved adapters + Shopify validation                          | generic lifecycle **mixed with** Shopify specifics             |
| `adopted-order-sync/artifact.ts`                                                                | pinning, reviewed patch application, content addressing                                                           | generic, but hardwired to one package                          |
| `adopted-order-sync/maintenance.ts`                                                             | fact helpers, accounting rule, input-contract driver                                                              | rule and helpers generic; driver Shopify-specific              |
| `adopted-order-sync/execute.ts`                                                                 | claim, retry scheduling + Shopify execution                                                                       | claim/retry generic                                            |
| Worker                                                                                          | queue handlers called Shopify functions directly; tick hardcoded to the Shopify flow type                         | **hardcoded**                                                  |
| Capabilities                                                                                    | onboarding/adaptations/reconciliation import Shopify functions; presenter wording "orders", "Shopify", "NetSuite" | **hardcoded**                                                  |
| Monitoring                                                                                      | none as such (slice-1 reliability checks for the native engine; scheduled reconciliation)                         | missing                                                        |
| Reliability (`incidents.ts`)                                                                    | generic lifecycle + resolution guard                                                                              | generic                                                        |
| NetSuite / Shopify clients, input contract, discovery signature, reconciliation scan            | provider/integration-specific                                                                                     | specific (correctly)                                           |

## 2. The integration maintenance contract (`packages/managed`)

**Descriptor** (`descriptor.ts`, data): identity (flow type), business process, source/destination, transaction
nouns and what "same business data" means, adopted provenance, execution trigger and idempotency, provider
dependencies, capabilities — discovery, monitoring signals (with how), recovery, verification, correction
patterns (`implemented` / `not_supported`) — limitations, versioned responsibilities. Only implemented
capabilities are declared; the operator view shows the contract per integration.

**Runtime** (`runtime.ts`, behaviour; every hook optional = explicitly unsupported): `onboarding`
(discover, activation steps), `execute`, `scan`, `recover`, `reconciliation` (start, request recovery),
`maintain`, `adaptations` (propose/validate/activate/rollback/reject), `inspect` (what code runs), `probe`
(monitoring), `sweep` (periodic work). `IntegrationRegistry` resolves the runtime owning any durable work
(delivery, run, item, event, adaptation) by its integration's flow type. `@mi/integrations` is the only place
listing integrations.

## 3. Patterns (generic mechanism · integration-specific · evidence · authority · failure · tests)

| Pattern                  | Generic (`@mi/managed`)                                                                                                                 | Shopify → NetSuite                              | Stripe → QuickBooks                                                                   | Evidence                                                | Authority                                                                            | Failure behaviour                                                             | Tests                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------- |
| Adoption                 | pinned source, drift check, reviewed patch application, content-addressed artifacts (`artifact.ts`)                                     | 7 files of shopify-erp-order-sync               | 35 files of ledgerly                                                                  | file sha256 vs independent clone                        | operators (patches)                                                                  | drift → nothing runs/loads; patch base mismatch refuses                       | adaptation.test, golden.test                          |
| Discovery                | outcome + confidence rules, per-integration onboarding record, confirmation, resumable activation, managed transition (`onboarding.ts`) | orders ↔ NetSuite `shopify-<id>` + order number | events ↔ QuickBooks DocNumber + memo; account map read from history                   | candidates with matched/sampled, examples               | customer confirms (versioned responsibilities)                                       | unreadable systems → blocked with reason; unsupported candidate refused       | onboarding.test, stripe-quickbooks.test               |
| Observation / monitoring | 12 declared signals from durable facts + probe; facts persisted on change; lost authorization → one event (`monitoring.ts`)             | probe: Admin API + SuiteQL                      | probe: Stripe account/events + QuickBooks CompanyInfo                                 | `observations` (kind monitoring), `integrations.health` | read-only                                                                            | probe failure → attention, never "healthy"                                    | managed.test, stripe-quickbooks.test                  |
| Change detection         | maintenance events with facts (`events.ts`)                                                                                             | input contract on every webhook                 | MissingExpansion → input-contract event; pinned-code dependency check (minor version) | finding with code path file:line                        | system                                                                               | change held, never written                                                    | maintenance.test, stripe-quickbooks.test              |
| Adaptation               | lifecycle, history, audit, verdict, activation guards, rollback refusal (`adaptations.ts`)                                              | field-moved adapter, precision patch            | reviewed patch p0001 (minor version)                                                  | validation checks (7–8), postActivation                 | maintenance proposes; adapters auto only with full validation; patches operator-only | failed validation rejects; rollback refused if previous runtime does not load | managed.test, adaptation.test, stripe-quickbooks.test |
| Recovery                 | claim, retries, release of held work (`deliveries.ts`)                                                                                  | rebuild from Admin API                          | replay from Events API                                                                | attempts with artifact id                               | system; customer/operator via AppPort                                                | duplicates impossible (one delivery per source id; destination guards)        | reconciliation tests, stripe-quickbooks.test          |
| Verification             | zero-loss rule over a population (`accounting.ts`)                                                                                      | lines = Shopify items/qty/price                 | once, balanced, accounts/amounts = Stripe                                             | reconciliation run + item verification                  | system                                                                               | empty/partial/unverified/duplicate → no claim                                 | managed.test                                          |
| Customer communication   | presenter from facts, worded by descriptor (`capabilities/product.ts`)                                                                  | "orders", "sales order"                         | "transactions", "journal entry"                                                       | persisted facts only                                    | customer reads own tenant                                                            | no claim without proof                                                        | product-appport.test, stripe-quickbooks.test          |

## 4. Shared versus integration-specific code

|                                                   | Lines | What                                                                                                                                                                                                                                   |
| ------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/managed` (generic)                      | 1,804 | contract, artifacts, lifecycle, accounting, events, onboarding, monitoring, deliveries, registry                                                                                                                                       |
| `packages/integrations`                           | 102   | the list of integrations + native descriptor                                                                                                                                                                                           |
| `packages/adopted-ledgerly` (Stripe → QuickBooks) | 3,698 | provenance, providers (Stripe SDK, Intuit OAuth), ingest, execute, discovery/activation, reconciliation/verification, 3 maintenance drivers, descriptor, runtime                                                                       |
| Stripe + QuickBooks fixtures                      | 1,027 | test-only                                                                                                                                                                                                                              |
| API routes for Stripe/QuickBooks                  | 175   | webhook ingress, key connection, OAuth                                                                                                                                                                                                 |
| Reused unchanged for Stripe → QuickBooks          | —     | queues and worker dispatch, onboarding engine and capabilities, correction lifecycle and capabilities, maintenance event storage and resolution guard, accounting rule, monitoring, customer presenter, portfolio, operator views, MCP |

## 5. Adding the next integration

1. Package with provenance (pinned files), provider clients, ingest, executor, discovery + activation steps,
   reconciliation/verification, drivers for the repairs it supports, descriptor and runtime (≈ 2.5–4k lines,
   most of it provider semantics; Stripe → QuickBooks took ≈ 3.7k).
2. One line in `@mi/integrations`; provider rows in its bootstrap.
3. Connection routes for its providers (≈ 150 lines) and their cards on the welcome page (≈ 40 lines of JSX).
4. Fixtures from the providers' documentation and an end-to-end test using `test/support` (drainer, harness).

Not needed: onboarding pages, queues, worker handlers, maintenance event model, correction lifecycle,
accounting rule, monitoring, customer presenter, operator views, AppPort/MCP capabilities.
