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

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | AppPort implementation inspected | VERIFIED | Phase A matrix in `architecture/APPORT-CAPABILITY-MAP.md` §5, with package versions and source symbols |
| 2 | Capability model understood and documented | VERIFIED | `APPORT-CAPABILITY-MAP.md` (contract, permissions, projections, gaps) |
| 3 | Real capability via AppPort contracts | VERIFIED | `defineCapability` + `s.object`; T-cap manifest assertions; MANIFEST |
| 4 | Reads durable application state | VERIFIED | T-cap inserts rows through Drizzle and asserts they are returned; new application instance returns the same rows; restart evidence below |
| 5 | Authorization at the capability boundary | VERIFIED | T-cap: anonymous `UNAUTHORIZED`, empty permissions `FORBIDDEN`; T-mcp same through MCP |
| 6 | Tenant isolation proven | VERIFIED | T-cap + T-mcp: tenant A with `{tenantId: B}` → `FORBIDDEN`; tenant B sees only B's row |
| 7 | Discoverable through native MCP | VERIFIED | T-mcp `tools/list` → `integrations_list` with the AppPort schema; HTTP log `tools/list` |
| 8 | Real MCP client invokes it | VERIFIED | T-mcp uses `@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport` over HTTP; HTTP log shows persisted rows |
| 9 | UI invokes the same capability | VERIFIED | E2E navigates `/app/integrations`; the page uses `@appport/client` + `@appport/transport-http` against `/appport` (no REST listing route) |
| 10 | UI and MCP produce equivalent results | VERIFIED | Same `handleRequest` path; T-mcp structuredContent equals the serialized business object; E2E row contains the same display name/lifecycle |
| 11 | Automated persistence/invocation/authorization tests | VERIFIED | T-cap 10 tests · T-mcp 9 tests (see run log) |
| 12 | Runs locally with documented commands | VERIFIED | `make up`; `curl` checks in `docs/operations/OPERATIONS.md`; HTTP log |
| 13 | Docs distinguish implemented/limitations/future | VERIFIED | capability map §8, KNOWN-LIMITATIONS "AppPort layer", ROADMAP row 8 |
| 14 | No parallel capability/authorization framework | VERIFIED | One `createApplication`, one authorizer composition; transport adapter contains no business logic or auth; see `ARCHITECTURE.md` |

State survives restart: the stack was restarted via `make reset`/`make up` and `integrations.list`
returned the seeded rows from PostgreSQL with no in-memory cache (`HTTP` log; T-cap "fresh application
instance" test). Migrations run from `packages/database/migrations` on a clean database
(`0000_initial.sql`, `0001_sharp_angel.sql`).

Known deviations from "all green at once": see KNOWN-LIMITATIONS item 10 (the pre-existing unmapped-SKU
browser test is stateful and requires `make reset`; the suite also expects the first scheduled sync to
have run). The AppPort-specific tests are independent of that state.
