# Slice 7 — three-sided change resilience, provider-centric

Starting point: `e2bdcc9` (end of slice 6). Everything below is **fixture-backed**: no live Stripe account,
QuickBooks company, Shopify store or NetSuite account was used.

## 1. Inventory at the start (code-grounded)

| Concern                         | At `e2bdcc9`                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What is managed                 | Pipelines only. `IntegrationDescriptor` had exactly one `source` and one `destination` (`packages/managed/src/descriptor.ts`). Onboarding required both to be connected.              |
| Which side changed              | Not represented. A maintenance event had a `kind` (`input_contract_change`, `dependency_contract_change`) but no boundary; a correction had no boundary or provider.                   |
| Contract history                | Shopify input contract checked per delivery (slice 4); Stripe/QuickBooks dependency checked against provider docs (slice 6). No durable record of contract variants seen over time. |
| Correction kinds                | `adapter`, `patch`, `unsupported`. No configuration change and no human decision as a correction.                                                                                     |
| Target-side changes             | QuickBooks refusals were `failed`/`rejected`; NetSuite OneWorld refusals were `rejected` (documented gap: the adopted code sends no subsidiary).                                       |
| Wrong data despite a 200        | Not detected for Stripe → QuickBooks (no read-back of what was written).                                                                                                                |
| Combined changes                | Each event released held work on its own; nothing prevented releasing on a half-corrected path.                                                                                       |
| Provider connections            | Credentials, OAuth refresh/rotation and Stripe signature checks lived inside the ledgerly package.                                                                                    |
| Adopted code                    | Commit-pinned git dependencies; artifacts = pinned files + reviewed patches. No deployment bindings, no pinned dependency set, no per-customer instance.                              |

## 2. The model after slice 7

### Providers and roles (provider-centric)

`IntegrationDescriptor.providers[]` is the single source of truth for every provider connection the executed
code uses: `role` (`source` · `target` · `both` · `dependency`), API and the version the code actually uses,
auth, client implementation (the dependency that provides it), operations with their effects, business
semantics, idempotency, recovery and verification criteria. `shape` is `pipeline` or `application`.
`source`/`destination` are no longer fields; `sourceOf`/`targetOf` are role look-ups. Onboarding requires
every listed provider (`systemsReady`), so a single-provider application asks for one connection.

| Managed thing                         | shape       | providers (role)                       |
| ------------------------------------- | ----------- | -------------------------------------- |
| Shopify → NetSuite (adopted)          | pipeline    | Shopify (source), NetSuite (target)    |
| Stripe → QuickBooks (adopted ledgerly) | pipeline    | Stripe (source), QuickBooks (target)   |
| Subscriptions app (Stripe)            | application | Stripe (both)                          |
| QuickBooks tools (quickbooks-mcp)     | application | QuickBooks (both)                      |

Provider connections are shared by every integration and application of a tenant
(`@mi/provider-connections`: encrypted credentials bound to their row, QuickBooks refresh under a row lock with
rotating tokens, `invalid_grant` → revoked, Stripe webhook signatures).

### Boundaries

`source` · `target` (provider roles in a pipeline) · `provider` (a provider an application depends on in any
other role) · `integration` (the adopted code: artifact, patches, dependency set, configuration) · `combined`.
Every maintenance event, correction and contract observation records its boundary and, for provider-side
facts, its provider.

`contract_observations` keeps every variant of a contract by fingerprint: the first is the `baseline`, a later
different one is `observed` (drift, with first/last sighting and a sample), and a correction that answers it
marks it `accepted`. Contracts observed today: the Stripe object representations an application receives
(`stripe.subscription`, `stripe.invoice`, …), ledgerly's source events, QuickBooks journal-entry acceptance
classes, the client a QuickBooks application uses, and the artifact that ran.

### Corrections (one lifecycle, five kinds)

`proposed → validating → validated → active → rolled_back` (or `rejected`, `unsupported`), each step with
actor, time and note in `history`; nothing is overwritten. Each correction records its event, boundary,
provider, artifact provenance, dependency it addresses, code path, impact, spec, rationale and validation;
the event records finding, impact assessment, correction, validation, accounting and verification.

| Kind            | Example (slice 7)                                                    | Who activates            |
| --------------- | -------------------------------------------------------------------- | ------------------------ |
| `adapter`       | Shopify field moved (slice 4)                                        | maintenance (validated)  |
| `patch`         | p0002 NetSuite subsidiary; app p0001 basil fields; d0001 dependency  | an operator              |
| `configuration` | QuickBooks account mapping; NetSuite subsidiary                      | maintenance, after the customer's decision; applied/reverted by hooks with a conflict guard |
| `decision`      | which account / which subsidiary                                     | the customer (`maintenance.decide`); operator questions by operators |
| `unsupported`   | wrong data in the destination despite a 200; no reviewed correction | nobody: escalated        |

A reviewed **dependency change** (`ReviewedDependencyChangeSchema`) is a `patch`-kind correction that selects a
different version of one dependency in the artifact's dependency set.

### Artifacts

Generic (`@mi/managed/artifact.ts`): pinned files (sha256) + reviewed patches + **deployment bindings**
(whole-file substitutions the host provides — an application's database client, its environment loader —
recorded by sha; the upstream file stays pinned) + a **pinned dependency set** linked into the artifact's own
`node_modules` + reviewed dependency changes + an optional **per-customer instance** (applications keep module
state). The artifact id names every patch and dependency change (`stripe-subscriptions-app:4812d259e7e8+p0001`,
`quickbooks-mcp:ce1317e51d43+d0001`). Pinned files are never modified; `pinnedDrift` refuses to run otherwise.

### Coordination: the whole path or nothing

`blockingEvents(db, integrationId, except)`: open source/target/provider change events of the same integration
without an activated correction and not escalated. Both Shopify → NetSuite drivers consult it **before
validating** (the target patch is validated with held orders through the source adapters, so it waits for
them) and **before releasing** held work. Held orders are released once, when every open change is corrected.

## 3. Generic vs specific

| Generic (`@mi/managed`, `@mi/provider-connections`, `@mi/capabilities`)                                      | Specific (each integration / application package)                                          |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| descriptor with providers and roles; boundaries; contract observations; blockingEvents                       | which contracts to observe and what their shape is                                         |
| correction lifecycle, decisions with authority, configuration apply/revert hooks, rollback                   | what a configuration means (account map, subsidiary) and how to apply it                   |
| artifacts: pins, patches, bindings, dependency sets, dependency changes, instances, app host registry       | which files run, what is bound, which dependencies                                          |
| zero-loss accounting; resolution guard; reauthorization event; maintenance events and notes                 | the population and the provider verification (what "correct" means for that data)          |
| AppPort: `maintenance.decide`, `applications.invoke`, evidence with boundary/provider/corrections           | replay validation (recording doubles, before/after artifacts)                               |
| shared provider ingress (`receive` hook), `invoke` hook; app_records (an application's own database)        | detection rules (e.g. NetSuite "Please enter value(s) for", QuickBooks 610, Stripe drift)  |

## 4. Scenarios and their invariants

| Scenario                                    | Where                                                       | Invariant (checked)                                                                                                                        |
| ------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Source-only (Shopify field moved)           | slice-4 suites; event now `boundary: source`                | every order once, Shopify's items/quantities/prices                                                                                        |
| Target-only (QuickBooks account inactive)   | `stripe-quickbooks.test.ts`                                 | every transaction once, balanced, same amounts/sides, account of the same type; history not rewritten                                     |
| Target + integration (NetSuite OneWorld)    | `adopted-order-sync/test/three-sided.test.ts` target-only   | every order once, Shopify's lines, in the chosen subsidiary; earlier orders untouched; pinned files unchanged                             |
| Integration code (app patch p0001)          | `provider-applications.test.ts` Stripe-side                 | each application record equals Stripe; webhook handler (signature, idempotency) unchanged                                                  |
| Integration dependency (d0001)              | `provider-applications.test.ts` application-side            | every request identical apart from User-Agent/Request-Id; executed files unchanged                                                         |
| Combined source + target                    | `three-sided.test.ts` combined                              | no validation or release on part of the path; every order once with Shopify's prices and the chosen subsidiary                           |
| Correction validation failure               | QuickBooks account test (second choice made inactive)       | rejected correction stays in history; nothing activated; held work stays held                                                             |
| Rollback                                    | all four maintenance scenarios                              | previous artifact/setting restored; event evidence and accounting remain                                                                  |
| Unsupported change                          | wrong destination data (QuickBooks)                         | escalated, nothing edited in the books, no zero-loss claim                                                                                 |
| Replay / recovery                           | Stripe app (own processor; Events API), QBO held requests   | recovered once; verified at the provider                                                                                                   |
| Duplicate delivery                          | Stripe app (same event twice), QBO (same request id)        | the application runs once; one invoice / one record                                                                                       |
| Incomplete source population                | Stripe → QuickBooks partial run                             | no completeness claim                                                                                                                      |
| Incorrect data despite success              | Stripe app (200, wrong record), QuickBooks (200, rewritten) | detected by provider verification, not by the response                                                                                     |
| Provider auth (QuickBooks app)              | `provider-applications.test.ts` QuickBooks                  | QuickBooks processed nothing (401 / invalid_grant); held request runs once after reconnect                                                |
