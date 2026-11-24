# Acceptance checklist — first slice (spec §29)

Status legend: **VERIFIED** (implemented and demonstrated by the referenced evidence) · **IMPLEMENTED**
(code exists, exercised only partially or indirectly) · **PARTIAL** · **NOT IMPLEMENTED** · **BLOCKED**
(external dependency).

All provider behaviour below was exercised against **deterministic fixtures** (`packages/test-fixtures`),
not real Shopify/NetSuite. "VERIFIED" means verified against those fixtures and real PostgreSQL/Docker.

Evidence keys: **T-acc** `packages/integration-shopify-netsuite/test/acceptance/*` · **T-unit**
`…/test/unit/*` · **T-rel** `packages/reliability/test/*` · **T-api** `apps/api/test/api.test.ts` ·
**T-pipe** `packages/maintenance/test/pipeline.test.ts` · **T-pol** `packages/maintenance/test/policy.test.ts` ·
**E2E** `e2e/app.spec.ts` (Playwright against the Docker stack) · **DEMO** `docs/evidence/runs/demo-failure-docker.{log,json}` ·
**CRASH** `docs/evidence/runs/crash-test-docker.log` · **BACKUP** `docs/evidence/runs/backup-restore-docker.log`.
Latest full run: `pnpm test` → 9 files, 76 tests passed (2026-11-23), plus `release.test.ts` (2 tests) added afterwards; Playwright 4/4 passed.

| #   | Criterion                        | Status                                  | Evidence / notes                                                                                                                                                                                                  |
| --- | -------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Real supported connection flow   | **BLOCKED** (real) / VERIFIED (fixture) | Shopify OAuth code grant (`expiring=1`), HMAC, state, code exchange: T-api. NetSuite M2M JWT signing verified by fixture signature check. No real store/account available.                                        |
| 2   | Connection authorization         | VERIFIED (fixture)                      | T-api OAuth round trip; scope enforcement; verify endpoint; revocation → incident (T-acc, T-rel).                                                                                                                 |
| 3   | Durable configuration            | VERIFIED                                | `integrations.config` validated by contract schema; T-api config PATCH; E2E SKU mapping.                                                                                                                          |
| 4   | Historical backfill              | VERIFIED                                | T-acc backfill (3 pages, cursor, completion); Docker stack backfill 30/30 (DEMO step 2).                                                                                                                          |
| 5   | Incremental sync                 | VERIFIED                                | T-acc incremental; scheduled syncs in Docker stack.                                                                                                                                                               |
| 6   | Pagination completeness          | VERIFIED                                | T-acc: page counts, termination via `hasNextPage`, page limit, repeated page, missing cursor.                                                                                                                     |
| 7   | Cursor persistence               | VERIFIED                                | T-acc: cursor only after page durable, never backwards, not advanced on failure; CRASH resume from cursor.                                                                                                        |
| 8   | Idempotency                      | VERIFIED                                | T-acc re-run + crash-after-write; CRASH: 90 orders / 90 unique externalIds; DEMO: 35/35 unique.                                                                                                                   |
| 9   | Retry                            | VERIFIED                                | T-acc NetSuite 500/503, Shopify 500 + timeout; T-unit backoff/jitter.                                                                                                                                             |
| 10  | Rate-limit handling              | VERIFIED (fixture)                      | T-acc NetSuite 429 + Retry-After floor, Shopify THROTTLED + 429, concurrency cap ≤ 2. Real throttle response format unverified.                                                                                   |
| 11  | Partial failure handling         | VERIFIED                                | T-acc: rejected records recorded, others delivered, run `partial`, destination rejection as invalid data.                                                                                                         |
| 12  | Record delivery evidence         | VERIFIED                                | deliveries + delivery_attempts (T-acc); customer run detail (E2E).                                                                                                                                                |
| 13  | Freshness monitoring             | VERIFIED                                | T-rel freshness breach open/resolve; overview freshness card.                                                                                                                                                     |
| 14  | Incident detection               | VERIFIED                                | T-rel: schema drift, auth, transient threshold, interrupted runs, rejected records; DEMO steps 5–7.                                                                                                               |
| 15  | Independent reconciliation       | VERIFIED                                | T-rel (identity query works while implementation broken); DEMO step 17.                                                                                                                                           |
| 16  | Missing record detection         | VERIFIED                                | T-rel deleted-in-NetSuite → missing → recoverable ids.                                                                                                                                                            |
| 17  | Duplicate detection              | VERIFIED                                | T-rel foreign duplicate; classification unit test.                                                                                                                                                                |
| 18  | Recovery                         | VERIFIED                                | Redelivery of missing/rejected (T-acc, T-rel, E2E SKU flow); transient recovery verified by reconciliation (T-rel).                                                                                               |
| 19  | Restart / resume                 | VERIFIED                                | CRASH: SIGKILL mid-run → `interrupted` → resumed, 0 duplicates.                                                                                                                                                   |
| 20  | Customer status interface        | VERIFIED                                | E2E customer flows; customer-safe views (T-api no secrets).                                                                                                                                                       |
| 21  | Operator exception interface     | VERIFIED                                | E2E operator; inbox/candidate/approve/rollback API (T-api).                                                                                                                                                       |
| 22  | Failure reproduction             | VERIFIED (fixture)                      | Agent writes a reproduction test that fails only on the drift profile (T-pipe, DEMO step 10). The drift is fictional.                                                                                             |
| 23  | Agent investigation              | VERIFIED (deterministic playbook)       | 17 restricted tool calls logged (DEMO). Claude planner IMPLEMENTED but not run (no API key).                                                                                                                      |
| 24  | Repair candidate                 | VERIFIED                                | Worktree branch, commit, diff, hypothesis (T-pipe, DEMO step 11).                                                                                                                                                 |
| 25  | Unchanged acceptance contract    | VERIFIED                                | Path policy (T-pol), suite sha256 base vs validation tree (T-pipe, DEMO step 13).                                                                                                                                 |
| 26  | Independent validation           | VERIFIED                                | Fresh tree + editable diff only, Docker `--internal` sandbox: typecheck, unit, acceptance (repro profile), regression (T-pipe, DEMO).                                                                             |
| 27  | Human approval                   | VERIFIED (mechanism)                    | Approval only via operator API; refused unless validated (T-api 409). DEMO used `--auto-approve` (scripted stand-in, labelled); interactive path waits for the UI.                                                |
| 28  | Canary / release                 | VERIFIED                                | Canary of N deliveries + canary reconciliation → promote (T-pipe, DEMO step 15).                                                                                                                                  |
| 29  | Rollback capability              | VERIFIED                                | `packages/maintenance/test/release.test.ts`: failed canary → automatic rollback (previous version stays pinned, nothing delivered); operator rollback after release restores the previous version and is audited. |
| 30  | Post-release reconciliation      | VERIFIED                                | `postReleaseReconciliationId`; DEMO step 17 (35/35 matched).                                                                                                                                                      |
| 31  | End-to-end failure demonstration | VERIFIED                                | DEMO against Docker stack, 19 steps, 93 s.                                                                                                                                                                        |
| 32  | Security review                  | PARTIAL                                 | `docs/operations/SECURITY.md` self-review with evidence; no external review or penetration test.                                                                                                                  |
| 33  | Backup/restore verification      | VERIFIED                                | BACKUP (dump → restore → identical row counts).                                                                                                                                                                   |
| 34  | Operational runbook              | IMPLEMENTED                             | `docs/operations/RUNBOOK.md` (not yet exercised by a second person).                                                                                                                                              |
| 35  | Pilot readiness report           | IMPLEMENTED                             | `docs/evidence/PILOT-READINESS.md`.                                                                                                                                                                               |

**The first slice is NOT complete per §29:** criterion 1 is blocked on real provider access (and every
"VERIFIED (fixture)" item still needs confirmation against real sandboxes), and 32 is partial.

---

# SLICE 1 acceptance — AppPort-native foundation

Scope: one real capability (`integrations.list@1`) over durable PostgreSQL state, authorized at the
capability boundary, consumed by the UI and by a real MCP client. Provider/OAuth/sync/maintenance work
was explicitly out of scope for this slice.

Evidence keys:
**T-cap** `packages/capabilities/test/integrations-list.test.ts` ·
**T-mcp** `apps/api/test/appport-mcp.test.ts` ·
**E2E** `e2e/app.spec.ts` (3 new `/app/integrations` tests) ·
**MANIFEST** `docs/evidence/runs/appport-manifest.log` ·
**HTTP** `docs/evidence/runs/appport-http.log`.

| #   | Criterion                                            | Status   | Evidence                                                                                                                                   |
| --- | ---------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | AppPort implementation inspected                     | VERIFIED | Phase A matrix in `architecture/APPORT-CAPABILITY-MAP.md` §5, with package versions and source symbols                                     |
| 2   | Capability model understood and documented           | VERIFIED | `APPORT-CAPABILITY-MAP.md` (contract, permissions, projections, gaps)                                                                      |
| 3   | Real capability via AppPort contracts                | VERIFIED | `defineCapability` + `s.object`; T-cap manifest assertions; MANIFEST                                                                       |
| 4   | Reads durable application state                      | VERIFIED | T-cap inserts rows through Drizzle and asserts they are returned; new application instance returns the same rows; restart evidence below   |
| 5   | Authorization at the capability boundary             | VERIFIED | T-cap: anonymous `UNAUTHORIZED`, empty permissions `FORBIDDEN`; T-mcp same through MCP                                                     |
| 6   | Tenant isolation proven                              | VERIFIED | T-cap + T-mcp: tenant A with `{tenantId: B}` → `FORBIDDEN`; tenant B sees only B's row                                                     |
| 7   | Discoverable through native MCP                      | VERIFIED | T-mcp `tools/list` → `integrations_list` with the AppPort schema; HTTP log `tools/list`                                                    |
| 8   | Real MCP client invokes it                           | VERIFIED | T-mcp uses `@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport` over HTTP; HTTP log shows persisted rows                 |
| 9   | UI invokes the same capability                       | VERIFIED | E2E navigates `/app/integrations`; the page uses `@appport/client` + `@appport/transport-http` against `/appport` (no REST listing route)  |
| 10  | UI and MCP produce equivalent results                | VERIFIED | Same `handleRequest` path; T-mcp structuredContent equals the serialized business object; E2E row contains the same display name/lifecycle |
| 11  | Automated persistence/invocation/authorization tests | VERIFIED | T-cap 10 tests · T-mcp 9 tests (see run log)                                                                                               |
| 12  | Runs locally with documented commands                | VERIFIED | `make up`; `curl` checks in `docs/operations/OPERATIONS.md`; HTTP log                                                                      |
| 13  | Docs distinguish implemented/limitations/future      | VERIFIED | capability map §8, KNOWN-LIMITATIONS "AppPort layer", ROADMAP row 8                                                                        |
| 14  | No parallel capability/authorization framework       | VERIFIED | One `createApplication`, one authorizer composition; transport adapter contains no business logic or auth; see `ARCHITECTURE.md`           |

State survives restart: the stack was restarted via `make reset`/`make up` and `integrations.list`
returned the seeded rows from PostgreSQL with no in-memory cache (`HTTP` log; T-cap "fresh application
instance" test). Migrations run from `packages/database/migrations` on a clean database
(`0000_initial.sql`, `0001_sharp_angel.sql`).

Known deviations from "all green at once": see KNOWN-LIMITATIONS item 10 (the pre-existing unmapped-SKU
browser test is stateful and requires `make reset`; the suite also expects the first scheduled sync to
have run). The AppPort-specific tests are independent of that state.

## Slice 2 — existing repository adoption (2026-11-23)

Adopted: `Milo-ai-HQ/shopify-erp-order-sync` @ `d01b51d` (MIT), unmodified. Record: `docs/adoption/ADOPTION.md`.
Inherited tests are the upstream repository's own suite; adoption tests are new.

| Required evidence (§10)                                  | Status             | Evidence                                                                                                                                                       |
| -------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing repository tests pass                           | VERIFIED           | inherited `test/sync.test.js` 20/20, run unmodified from the installed package (`packages/adopted-order-sync/test/adoption.test.ts`)                           |
| Existing execution path still works                      | VERIFIED (fixture) | traced path; adoption tests; Docker demo (`runs/demo-adopted-docker.log`)                                                                                      |
| Existing provider behaviour preserved                    | VERIFIED           | installed upstream files byte-identical to the adopted commit (sha256 test); upstream result recorded verbatim per attempt                                     |
| AppPort authorization cannot be bypassed                 | VERIFIED           | anonymous refused (UI client at load, MCP per call); missing permission / other tenant FORBIDDEN on both projections (`apps/api/test/adopted-appport.test.ts`) |
| Tenant isolation enforced                                | VERIFIED           | resource-tenant authorizer; webhook for a foreign shop refused; native integration id not an adopted endpoint; e2e                                             |
| Duplicate invocations do not cause unsafe duplicate work | VERIFIED           | webhook-id dedupe; delivered order never re-executed; concurrent retry → one accepted, one CONFLICT; concurrent execution → one claim                          |
| Failure state remains visible                            | VERIFIED           | rejected/failed with upstream message via `deliveries.get`; UI detail; `stuck` flag                                                                            |
| Durable evidence survives process restart                | VERIFIED           | adoption test (new pool executes pending work); Docker: worker stopped → webhook accepted → restarted → delivered once (`runs/adopted-restart-docker.log`)     |
| UI and MCP report consistent results                     | VERIFIED           | `deliveries.list` via `@appport/client` (UI path) deep-equals MCP `deliveries_list`                                                                            |
| Upstream provenance preserved                            | VERIFIED           | lockfile commit + file hashes + LICENSE test; `provenance.ts`                                                                                                  |
| Vertical slice steps 1–10 (§7)                           | VERIFIED (fixture) | `make demo-adopted` (all 12 steps, MCP-driven)                                                                                                                 |
| Real Shopify / NetSuite                                  | BLOCKED            | no credentials; fixtures only                                                                                                                                  |

Full suite after slice 2: 14 files, 115 tests passed; Playwright 10/10 against the Docker stack (3 new).

## Slice 3 — reconciliation and missing-delivery recovery (2026-11-23)

Contract, mechanisms and gaps: `docs/adoption/RECONCILIATION.md`. Providers are the deterministic fixtures
throughout. Nothing below was run against a real Shopify store or a real NetSuite account.

| Required test (§8)                                              | Status             | Where                                                                                                                                     |
| --------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1–4 classify delivered / missing / untracked / ambiguous        | VERIFIED           | `packages/adopted-order-sync/test/reconciliation.test.ts` (classification against real fixture destination state; pending and failed too) |
| 2–3 recover a never-webhooked order; next run shows delivered   | VERIFIED           | same file; Docker demo steps 2–10                                                                                                         |
| 5 unknown SKU fails recovery with the upstream message          | VERIFIED           | same file                                                                                                                                 |
| 6–7 transient NetSuite failure, then recovery after the outage  | VERIFIED           | same file                                                                                                                                 |
| 8 duplicate starts / concurrent scans → one run, one scanner    | VERIFIED           | same file; `apps/api/test/reconciliation-appport.test.ts` (two concurrent `start` via AppPort)                                            |
| 9 webhook concurrent with recovery → one execution              | VERIFIED           | same file (`joined_recovery`); recovery after webhook delivery refused                                                                    |
| 10 concurrent recovery requests and executions → once           | VERIFIED           | same file                                                                                                                                 |
| 11–12 worker dies mid-scan → resumed from cursor, no duplicates | VERIFIED           | same file                                                                                                                                 |
| 13 provider failure mid-scan → partial run, next run completes  | VERIFIED           | same file (Shopify side and NetSuite side)                                                                                                |
| 14 cross-tenant reconciliation denied                           | VERIFIED           | API test (UI client + MCP); Docker demo step 12                                                                                           |
| 15 cross-tenant recovery denied                                 | VERIFIED           | API test (UI client + MCP); Docker demo step 12                                                                                           |
| 16–17 excluded / ineligible orders not recovered                | VERIFIED           | same file; order cancelled between discovery and execution is not executed                                                                |
| 18 executed but unverifiable → `unverified`, not recovered      | VERIFIED           | same file                                                                                                                                 |
| destination re-check before execution                           | VERIFIED           | two state-change tests; both fail when the re-check is removed (mutation checked)                                                         |
| bulk recovery requires confirmation                             | VERIFIED           | API test (MCP); e2e (UI button disabled until confirmed)                                                                                  |
| UI and MCP report the same result                               | VERIFIED           | API test: `reconciliation.runs` via `@appport/client` deep-equals MCP `reconciliation_runs`                                               |
| invocation and actor evidence                                   | VERIFIED           | API test: `reconciliation.requested`, `reconciliation.recovery_requested`, denied `appport.invocation` rows                               |
| 12-step Docker demonstration                                    | VERIFIED (fixture) | `make demo-reconcile`; `runs/demo-reconcile-docker.{log,json}`                                                                            |
| Real Shopify / NetSuite                                         | BLOCKED            | no credentials; fixtures only                                                                                                             |

Fresh-stack verification (`make reset`, then `demo-reconcile`, `demo-adopted`, `demo-failure --auto-approve`,
then Playwright): all three demos passed; Playwright 12/12 (`runs/playwright-slice3-docker.log`).
Vitest: 16 files, 141 tests passed.

Found and fixed during slice 3 verification:

- `createAppPortRuntime` did not pass the reconciliation enqueue functions to the application, so `start`
  and `recover` failed in the API process. The new API test caught it.
- **Slice 1 lost update.** Re-evaluating an open incident replaced its `affectedScope` and dropped the
  backlog's `affectedOrderCount`, which made `demo-failure` time-dependent. Both writers now merge in SQL
  (`jsonb ||`). A regression test fails without the fix.
- **Fixture order-id collision.** Both fixture shops numbered orders from the same sequence while both
  tenants share one NetSuite fixture account. Bluewave's new orders could match Acme's
  `shopify-<id>` records. Reconciliation classified them `destination_exists_untracked` and wrote nothing,
  which is the correct behaviour. The second shop now uses its own id range, as real Shopify ids are
  globally unique. The first demo pass in this slice ran before the collision occurred, so its evidence was
  regenerated.
- **e2e and the login rate limit.** The suite needs more logins than the product's 10/min login limit
  allows. Login helpers now pace themselves (`e2e/support/pace-login.ts`); the limit itself is unchanged.
  `app.spec.ts` "unmapped SKU" still needs a fresh stack, because it adds the mapping it tests (pre-existing).

## Slice 4 — customer product and verified maintenance lifecycle (2026-11-23)

Record: `docs/product/MAINTENANCE.md`. The provider change is fictional and made at the fixture boundary.
Nothing was run against real Shopify or NetSuite.

Test files referenced below:

- `packages/adopted-order-sync/test/maintenance.test.ts` (**lifecycle**)
- `apps/api/test/product-appport.test.ts` (**API**: UI client + MCP)
- `packages/capabilities/test/product.test.ts` (**rules**)
- `e2e/maintenance.spec.ts`, `e2e/app.spec.ts` (**e2e**)

| #   | Required test                                   | Status             | Where                                                                                                                     |
| --- | ----------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | no event without a change                       | VERIFIED           | lifecycle                                                                                                                 |
| 2   | change detected                                 | VERIFIED           | lifecycle; demo step 3                                                                                                    |
| 3   | detection evidence persisted                    | VERIFIED           | lifecycle (`finding`: baseline vs observed, API versions, shape diff; reproducible)                                       |
| 4   | affected integration identified                 | VERIFIED           | lifecycle; demo step 4                                                                                                    |
| 5   | adopted execution at risk under the change      | VERIFIED           | lifecycle (dry run of the real upstream mapping: null rate); fixture rejects null rates                                   |
| 6   | investigation identifies the code path          | VERIFIED           | lifecycle (`src/mapping.js` line, sha matches pinned commit)                                                              |
| 7   | correction applied                              | VERIFIED           | lifecycle (`inputCompat` rule with provenance; upstream sha unchanged)                                                    |
| 8   | regression tests pass                           | VERIFIED           | validation check 2 (stored pre-change orders map identically); full suites                                                |
| 9   | changed fixture handled after correction        | VERIFIED           | lifecycle (new 2027-01 order delivered, correct rate); demo                                                               |
| 10  | delayed transactions identified                 | VERIFIED           | accounting `delayed`; attempt history `held → delivered`                                                                  |
| 11  | reconciliation discovers missing operations     | VERIFIED           | accounting `discoveredByReconciliation` (lost webhook)                                                                    |
| 12  | recovery through the existing execution path    | VERIFIED           | released orders via `executeDelivery`; missing via slice-3 recovery                                                       |
| 13  | destination verification                        | VERIFIED           | second reconciliation run + line-level NetSuite vs Shopify                                                                |
| 14  | no duplicate records                            | VERIFIED           | lifecycle (one record per order, after re-running the driver); demo step 11                                               |
| 15  | cannot be marked resolved without evidence      | VERIFIED           | lifecycle (legal transitions refused by the evidence guard); API (no write capability exists)                             |
| 16  | customer claims derived from persisted evidence | VERIFIED           | API (facts and numbers equal persisted accounting); rules                                                                 |
| 17  | unresolved/unverified prevents zero-loss        | VERIFIED           | lifecycle (unrecoverable order → not resolved, `zeroLoss: false`); rules                                                  |
| 18  | tenant isolation                                | VERIFIED           | API (UI client + MCP); demo; e2e                                                                                          |
| 19  | customer and operator agree                     | VERIFIED           | API (customer UI-client view deep-equals operator MCP view and the evidence's embedded view); demo                        |
| 20  | existing native and adopted demos still work    | VERIFIED (fixture) | fresh stack: `demo-maintenance`, `demo-reconcile`, `demo-adopted`, `demo-failure` all passed (`runs/*-slice4-docker.log`) |

Also verified:

- **Status is not optimistic.** Successful deliveries leave "Verification pending"; "Protected" requires a
  completed consistent check (API, rules).
- **Escalation without a documented replacement** changes nothing and claims nothing (lifecycle).
- **Vacuous claims are blocked.** An empty or incomplete population cannot yield zero loss (found by a
  failing test during development; fixed).

Found and fixed during slice 4:

- **Vacuous zero-loss claim.** With an empty population it said `zeroLoss: true`. The claim now requires a
  non-empty population containing every held order.
- **Wrong window basis.** The affected window used webhook receipt time, but reconciliation selects by
  order creation time.
- **`deliveries.list`/`get` output schema lacked `held`.** Operators' views would have failed while orders
  were held.
- **Customer timeline exposed internals and duplicated an entry.** Caught by reviewing the CX screens.
- **`demo-failure.ts` took the first `integrations` row without a filter.** Once maintenance updated a row,
  it picked the adopted integration.
- **The customer-facing integration name exposed the executor.**

Fresh-stack verification (`make build`, `make reset`, then `demo-maintenance` → `demo-reconcile` →
`demo-adopted` → `demo-failure --auto-approve` → Playwright):

- All four demos passed.
- Playwright: 16/16 (`runs/playwright-slice4-docker.log`).
- Vitest: 19 files, 163 tests.
- Typecheck and lint clean.
- The AppPort packages were upgraded to the latest published versions before this slice. The upgrade was
  committed separately, and the suite stayed green.

## Slice 5 — frictionless onboarding and managed integration adaptation (2026-11-23)

Records: `docs/product/ONBOARDING.md`, `docs/product/ADAPTATION.md`. Starting commit `17f1f79`. Every
result is **fixture-backed** (Shopify and NetSuite fixtures); nothing was run against a live provider.

Test files: `apps/api/test/onboarding.test.ts` (**onboarding**), `packages/adopted-order-sync/test/adaptation.test.ts`
(**adaptation**), `packages/adopted-order-sync/test/maintenance.test.ts` (**lifecycle**),
`apps/api/test/product-appport.test.ts` (**API**), `e2e/onboarding.spec.ts`, `e2e/maintenance.spec.ts` (**e2e**),
`make demo-onboarding` (**demo**, `runs/demo-onboarding-slice5-docker.log`, `runs/demo-onboarding-docker.json`).

### Onboarding

| #   | Required                                 | Status             | Where                                                                                       |
| --- | ---------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| 1   | new customer enters the product          | VERIFIED           | onboarding (signup); e2e (signup → `/app/welcome`, Connect); demo A1                        |
| 2   | connects supported systems               | VERIFIED (fixture) | onboarding (Shopify OAuth, NetSuite M2M); demo A2–A3                                        |
| 3   | discovery finds the existing integration | VERIFIED (fixture) | onboarding; demo A4 (6/6 orders written by the customer's own upstream deployment)          |
| 4   | customer confirms and authorizes         | VERIFIED           | onboarding (versioned responsibilities, user, time); demo A5                                |
| 5   | baseline established                     | VERIFIED (fixture) | onboarding; demo A6 (6 checked, 6 present, recorded as history with `origin: baseline`)     |
| 6   | genuinely managed state                  | VERIFIED (fixture) | onboarding (new order via our registered subscription, exactly once); demo A7–A8            |
| —   | ambiguous discovery                      | VERIFIED           | onboarding (choices offered; unrecognized scheme not adopted)                               |
| —   | unsupported integration                  | VERIFIED           | onboarding (ambiguous/unsupported candidates)                                               |
| —   | denied permissions                       | VERIFIED           | onboarding (missing order scope → not connected, nothing proceeds)                          |
| —   | partial onboarding                       | VERIFIED           | onboarding (NetSuite missing → discovery waits; interrupted activation resumes, no repeats) |
| —   | existing management                      | VERIFIED           | onboarding (managed tenant: discovery does not restart); e2e                                |
| —   | cross-tenant access                      | VERIFIED           | onboarding (cannot read or confirm another tenant's onboarding); demo C1                    |

Happy path: 7 customer actions, 3 genuine decisions (authorize Shopify, authorize NetSuite, confirm).

### Adaptation

| #   | Required                                    | Status             | Where                                                                                           |
| --- | ------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------- |
| 1   | pinned adopted integration                  | VERIFIED           | adaptation (artifacts); demo B2 (`adopted:d01b51d95993`, files match the pin)                   |
| 2   | documented provider change introduced       | VERIFIED (fixture) | lifecycle; demo B1 (fictional webhook version `2027-01`)                                        |
| 3   | affected dependency detected                | VERIFIED           | lifecycle (input contract violation: `line_items[].price` absent)                               |
| 4   | exact adopted code path                     | VERIFIED           | lifecycle; demo B2 (`src/mapping.js:11`)                                                        |
| 5   | adapter proposed                            | VERIFIED           | lifecycle; demo B3 (registry `proposed`, with changelog hash and baseline equivalence)          |
| 6   | old and new behaviour validated             | VERIFIED           | adaptation (pure cases); demo B3 (7 checks passed; patch path 8 checks)                         |
| 7   | correction activated                        | VERIFIED           | lifecycle; adaptation (patch: operator activation only)                                         |
| 8   | affected orders executed                    | VERIFIED (fixture) | lifecycle; demo B4 (price 7.25 from Shopify)                                                    |
| 9   | reconcile and verify destination            | VERIFIED (fixture) | lifecycle (second run + line-level NetSuite vs Shopify); `postActivation` on the adaptation     |
| 10  | transaction accounting                      | VERIFIED           | lifecycle; demo B3/B5 (2/2, zero loss, 0 duplicates)                                            |
| 11  | rollback (separate test)                    | VERIFIED           | adaptation (adapter and patch rollback; previous runtime runs; not re-applied automatically)    |
| 12  | unsafe or ambiguous correction refused      | VERIFIED           | adaptation (conflict held and escalated; activation guards; non-matching patch refuses to load) |
| —   | customers cannot create or activate patches | VERIFIED           | API (UI client and MCP refused; operator inspect/rollback allowed)                              |
| —   | operator sees what code runs and why        | VERIFIED           | e2e (running artifact, contract, adaptation with validation and Roll back)                      |

Adapter cases (pure): old shape, new shape, both present equal, both present conflicting, missing, wrong
type, null/empty, unexpected nesting, repeated execution; stored orders via the regression check.

Found and fixed during slice 5:

- **jsonb key order** defeated the "previously rolled back" check, so maintenance re-applied a rolled-back adapter. Now compared canonically.
- **Operator evidence page read slice-4's `passed`**, showing every slice-5 check as failed and "configuration version undefined". It now renders `status`; e2e asserts no failed check on a resolved event.
- **Already-managed tenants** would have been shown the Connect step. They now start as `managed`.
- **NetSuite account domain** was built from the account id, against Oracle's guidance. The domain is now asked for.
- **A single Shopify override URL** made a new store unreachable in the fixtures. Added `SHOPIFY_FIXTURE_SHOPS` (refused in production).

Fresh-stack verification (`make build`, `make reset`, then `demo-maintenance` → `demo-onboarding` →
`demo-reconcile` → `demo-adopted` → `demo-failure --auto-approve` → Playwright):

- All five demos passed (`runs/*-slice5-docker.log`).
- Playwright: 19/19 (`runs/playwright-slice5-docker.log`).
- Vitest: 21 files, 187 tests (`runs/vitest-slice5.log`).
- Typecheck and lint clean.

## Slice 6 — integration portability and repeatable maintenance (2026-11-24)

Records: `docs/architecture/PORTABILITY.md` (inventory, contract, patterns, shared vs specific code),
`docs/adoption/SECOND-INTEGRATION.md` (selection and provenance). Starting commit `c8e2cce`. Every result is
**fixture-backed**; nothing was run against live Stripe, QuickBooks, Shopify or NetSuite.

Test files: `apps/api/test/stripe-quickbooks.test.ts` (**sq**, 7 end-to-end scenarios through the API and the
real worker handlers), `packages/managed/test/managed.test.ts` (**generic**, 12),
`packages/adopted-ledgerly/test/golden.test.ts` (**golden**), the slice 2–5 suites (**regression**),
`make demo-stripe` (**demo**, `runs/demo-stripe-slice6-docker.log`, `runs/demo-stripe-docker.json`).

| Requirement                                                                                                                                              | Status             | Where                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| A. Shopify → NetSuite regression (onboarding, discovery, activation, delivery, reconciliation, change detection, adapter, patch, verification, rollback) | VERIFIED (fixture) | regression suites; `demo-onboarding`, `demo-maintenance`, `demo-reconcile`, `demo-adopted`, `demo-failure` on a fresh stack |
| B1–B2 adoption, pinned source and provenance                                                                                                             | VERIFIED           | golden (35 files match the pin; 29/29 upstream golden outputs through our loader); demo B1                                  |
| B3–B6 connection, discovery, baseline, management                                                                                                        | VERIFIED (fixture) | sq (happy path); demo B3–B6 (5 actions, discovered 5/5 established, baseline 5/5)                                           |
| B7 transaction execution                                                                                                                                 | VERIFIED (fixture) | sq; demo B7 (one balanced entry)                                                                                            |
| B8 independent destination verification                                                                                                                  | VERIFIED (fixture) | sq; demo B8 (Stripe Events API vs QuickBooks: once, balanced, amounts)                                                      |
| B9–B10 failure scenario with evidence-backed recovery                                                                                                    | VERIFIED (fixture) | sq (lost authorization); demo B9–B10 (held + lost transaction recovered; zero loss proven)                                  |
| B. reviewed patch path (detection → proposal → validation → operator activation → verification → rollback)                                               | VERIFIED (fixture) | sq (dependency); demo P1–P3 (operator via MCP)                                                                              |
| C. reuse proof (onboarding state, managed lifecycle, events, evidence, adaptation lifecycle, customer status, operator inspection)                       | VERIFIED           | sq (two integrations in one organization; same capabilities); PORTABILITY.md §4                                             |
| D. cross-tenant isolation                                                                                                                                | VERIFIED           | sq (isolation and authority)                                                                                                |
| D. duplicate activation                                                                                                                                  | VERIFIED           | sq (second confirm refused); generic (one correction per scope)                                                             |
| D. repeated events                                                                                                                                       | VERIFIED           | sq (one delivery, one entry; unsigned replay refused)                                                                       |
| D. partial provider outage                                                                                                                               | VERIFIED           | sq (QuickBooks 503 → failed → retry → one entry)                                                                            |
| D. expired credentials                                                                                                                                   | VERIFIED (fixture) | sq (invalid_grant → held → reconnect); generic monitoring test                                                              |
| D. missing and ambiguous transactions                                                                                                                    | VERIFIED           | sq (missing found by reconciliation); onboarding.test (ambiguous discovery)                                                 |
| D. unsupported provider changes                                                                                                                          | VERIFIED           | sq (no balance transaction → held, unsupported correction, escalated; cross-currency payout refused)                        |
| D. unsafe adaptations                                                                                                                                    | VERIFIED           | sq (non-catalog patch refused, customers forbidden); generic (runtime must load)                                            |
| D. failed validation                                                                                                                                     | VERIFIED           | generic (failed check → rejected, not activatable)                                                                          |
| D. failed rollback                                                                                                                                       | VERIFIED           | generic (previous runtime does not load → refused, stays active)                                                            |
| D. incomplete evidence                                                                                                                                   | VERIFIED           | generic (empty, partial, uncovered, unverified, duplicate, only-excluded → no zero-loss claim)                              |
| D. duplicate recovery attempts                                                                                                                           | VERIFIED           | sq (two concurrent recoveries → one delivery, one entry)                                                                    |
| E. fresh-stack acceptance                                                                                                                                | VERIFIED (fixture) | below                                                                                                                       |

Found and fixed during slice 6:

- **Reconciliation window ended one second early** in the Stripe driver (Stripe timestamps are whole seconds), so a
  transaction from the same second was outside the population; the zero-loss rule then correctly refused to resolve.
  Intermittent in tests; fixed, and the test now reports the event's facts and runs when it fails.
- **A dependency correction could be "verified" on an empty population.** It now waits until a transaction has run
  through the patched code.
- **Duplicate Authorization header** (upstream dispatcher + our wrapper merged into one invalid header).
- **Revoked status rolled back** with the failed refresh transaction; now recorded outside it.
- **Fixture fidelity:** expanding `charge.balance_transaction` must also expand `charge` (as Stripe does).
- **GitHub push protection** flagged a key-shaped fixture string in the demo; the demo now reads the fixture key
  from the fixture instead (no bypass).

Fresh-stack verification at `2c72053` (`make build`, `make reset`, then `demo-maintenance` → `demo-onboarding`
→ `demo-stripe` → `demo-reconcile` → `demo-adopted` → `demo-failure --auto-approve` → Playwright):

- All six demos passed (`runs/*-slice6-docker.log`).
- Playwright: 19/19 (`runs/playwright-slice6-docker.log`).
- Vitest: 24 files, 208 tests (`runs/vitest-slice6.log`).
- Typecheck and lint clean.
