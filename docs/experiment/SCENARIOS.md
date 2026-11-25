# Shared scenario specification (both systems)

One specification, two independent implementations. Each scenario states the starting conditions, the
external events (driven only through the provider simulators), and the outcomes that must hold. Each
system has its own driver, which reaches the system only through its public surfaces:
- **System A:** `apps/api/scripts/demo-*.ts`, using REST, MCP and the provider simulators.
- **System B:** `systems/b/scenarios/*.ts`, using FeltKit's client, B's runtime routes and the provider simulators.

Neither driver reads the other system's state, and neither system's code calls the other.

**Simulators.** The provider simulators (`packages/test-fixtures`) model the external world: Shopify,
NetSuite, Stripe and QuickBooks. They contain no business logic of either system. Each system runs its own
instance with its own in-memory state:
- **A:** ports 40xx, in its compose stack.
- **B:** ports 50xx, started by `systems/b/scripts/reset.sh`.

Controls added for B's scenarios; System A never calls them:
- Shopify `drop-webhooks`.
- Stripe `drop-webhooks` made per-event. With one endpoint, this behaves the same as before.
- NetSuite `/__fixture/subsidiaries`; QuickBooks `/__fixture/accounts`, `…/deactivate`, `…/activate`; Stripe
  `DELETE /v1/webhook_endpoints/{id}` (Stripe's own API); two more shops, started only when
  `FIXTURE_SHOPIFY4_PORT`/`FIXTURE_SHOPIFY5_PORT` are set (S8, S9 each need a shop no other company subscribes to).

System A's full Vitest suite still passes with them (229 passed, 1 skipped: the Docker sandbox test).

**Shared world.** NetSuite, Stripe and QuickBooks are one account each per reset. S8–S10 restore what they change
(OneWorld off, accounts active, their Stripe endpoint removed), and `systems/b/scripts/scenarios.sh` runs S10
before S6/S7 so no other ledgerly company receives its Stripe events.

**Reset.** A runs `make reset` (Docker volumes and simulators). B runs `systems/b/scripts/reset.sh`
(its state directory and simulators). Every scenario starts from a reset and creates its own companies, with
one simulated shop per scenario, as A's demos use.

**Identities.** A: seeded accounts plus sign-up. B: FeltKit accounts and workspaces. Staff join a customer's
workspace by invitation as `operator`: as declared dev identities in development, and as verified accounts in
production (see FINDINGS F14).

| ID | Scenario | A driver | B driver | Outcomes both must show |
|---|---|---|---|---|
| S1 | Native sync failure → agent repair → approval → canary release | `scripts/demo-failure.ts` | `scenarios/failure.ts` (EVE agent via `scripts/reset.sh` with `MI_REPAIR_AGENT=1`) | Detects drift, fails safe with the cursor held, opens an incident, generates a candidate, validates it, gets an operator's approval, releases it, then resumes, reconciles and resolves |
| S2 | Adopted order sync | `demo-adopted.ts` | `scenarios/adopted.ts` | Signed `orders/create` → the upstream code writes the NetSuite sales order once; a rejection is represented as it is; another company is refused; a retry recovers once; a duplicate retry is refused (CONFLICT) |
| S3 | Missed webhook reconciliation | `demo-reconcile.ts` | `scenarios/reconcile.ts` | Reconciliation classifies the lost order `missing_delivery`; recovery runs once and is verified in NetSuite; a second run shows it delivered; duplicate recoveries are refused; another company is refused |
| S4 | Source format change with a lost webhook | `demo-maintenance.ts` | `scenarios/maintenance.ts` | One event for one change; investigation names the line of adopted code; an adapter is corrected, validated and activated; held orders and the lost order are each delivered once with Shopify's prices; accounting shows 0 unresolved and 0 duplicates; no customer action; the customer view has no internals; another company is refused; new orders flow |
| S5 | Onboarding of an existing deployment | `demo-onboarding.ts` | `scenarios/onboarding.ts` | Sign-up → connect → discovery from the customer's own writes → versioned confirmation → baseline (credits the earlier deployment, 0 missing) → a new order flows → a later format change is absorbed → another company sees only its own |
| S6 | Stripe → QuickBooks with ledgerly | `demo-stripe.ts` | `scenarios/stripe.ts` | The earlier deployment's history is discovered; baseline 0 missing; a payment is booked once and balanced; an independent check passes; minorversion 70 is found in the running code, patched, validated, activated by an operator and proven on a real posting; after a revoke, held and lost transactions are each booked exactly once after reconnect |
| S7 | Hosted applications (one provider each) | `demo-applications.ts` | `scenarios/applications.ts` | Stripe app: hosted, records rebuilt and verified; a basil change is detected; a patch is validated by replay and activated by an operator; zero loss. QuickBooks tools: an invoice is created once, a replay does nothing, a revoke holds the request and it runs once after reconnect, an upstream release is validated by replay, activated, verified and rolled back |
| S8 | Target change: NetSuite becomes OneWorld | `packages/adopted-order-sync/test/three-sided.test.ts` (target-only) | `scenarios/target.ts` | Orders held, not rejected; one event; the customer (only) chooses the subsidiary from their NetSuite's own list; configuration validated and active; a reviewed patch validated over the whole path and activated by an operator; held orders released once and verified (subsidiary, prices); earlier orders untouched; another company refused; rollback restores the pinned code |
| S9 | Combined source + target change | `three-sided.test.ts` (combined) | `scenarios/combined.ts` | Neither change releases held orders on part of the path; corrected together, every order exactly once with Shopify's prices in the chosen subsidiary |
| S10 | Target change: QuickBooks account made inactive (610) | `apps/api/test/stripe-quickbooks.test.ts` (target-only) | `scenarios/inactive-account.ts` | Held, not rejected; confirmed from QuickBooks' chart; same-type options; a choice made invalid meanwhile is rejected and the customer asked again; booked once on the new account; history untouched; rollback restores the mapping |

Results of each run are in `docs/evidence/runs/` (A: `*-slice*.log` and the demo evidence files; B:
`system-b/*.json`, one file per scenario run, every step with its time and data).
