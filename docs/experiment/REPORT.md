# Dual-system comparative experiment — report and decision

**System A** (control) is the existing implementation, unchanged:
- Fastify, pg-boss, Drizzle/Postgres and React;
- its own Dockerfile and Compose stack.

**System B** is the same product on FeltKit 0.4.0, with the Boundry products that applied:
- FeltDB, AppPort and AppPort Services through FeltKit;
- EVE (`@appport/eve` 1.1.0) as the repair agent.

Branch: `claude/wizardly-fermat-x6gekb`. B lives in `systems/b`; the harness, which belongs to neither system, is in `experiment/`.

Every number below links to its evidence. Where a comparison is not like-for-like, this report says so next to the number.

## A. Inventory and baseline

**Stack used by System B.** Versions as installed (`npm view`, packages read):

| Product | Version | Used for |
|---|---|---|
| `@feltdb/feltkit` | 0.4.0 | Everything listed below |
| `@feltdb/core` | 0.23.0 | Through FeltKit |
| `@appport/services` | 0.21.0 | Through FeltKit |
| AppPort | 1.13 | Through FeltKit |
| `@appport/eve` | 1.1.0 | The repair agent |

FeltKit provides:
- tenancy (workspaces), accounts, sessions and CSRF;
- the sign-in, invitation and workspace screens;
- the schema-enforced store;
- durable work and outbox retries;
- the AppPort and MCP surfaces;
- the activity log;
- the deploy artifact.

**Products not used:**
- **AppBoundry 1.13.0:** managed hosting needs a deploy token, and its docs say execution is gated.
- **AuthBoundry (`@authboundry/local` 0.1.1) and Resolver 0.4.1:** no feature of this product needed per-person delegation or model references.
- **Foundry:** dropped at the user's instruction.

**System A baseline at HEAD (fresh build):**
- image build: 110 s;
- images: 1.12 GB (app) and 1.17 GB (maintenance);
- cold start to `/healthz`: 12.9 s;
- demos: 7/7 pass;
- idle memory: about 572 MiB across 4 containers, plus the simulators (`docs/evidence/runs/` and this session's logs).

## B. Parity

The matrix is in `PARITY.md`. All seven shared scenarios (`SCENARIOS.md`) pass in both systems.

B runs them in sequence after one reset in **32 s** (`docs/evidence/runs/system-b/*.json`).

B's browser journeys: **8/8** pass (`docs/evidence/runs/system-b/playwright.log`). A's Playwright suite has 19 journeys; B covers the subset whose features both systems have.

Remaining gaps, stated in `PARITY.md`:
- **S1's repair surface is narrower in B:** a declared engine specification, not arbitrary code.
- **Configuration and decision corrections, and A's slice-7 target scenarios:** not exercised in B.
- **Slice-8 analysis tooling:** not re-implemented.
- **Production staff path:** not run.
- **B's container image:** not built here.

## C. Same-workload benchmark

Harness: `experiment/bench/workload.ts`, outside both systems. Each system received the same signed Shopify webhooks at its own endpoint and wrote to its own NetSuite simulator, from a fresh reset. The run was 100 sequential orders, then a 200-order burst at concurrency 20.

Evidence: `docs/evidence/runs/bench/`.

| Measure | System A (Compose) | System B (FeltKit production build) |
|---|--:|--:|
| Webhook acknowledgement p50 / p95 / p99 (sequential) | 9.5 / 13.7 / 219.6 ms | 7.5 / 10.2 / 11.8 ms |
| End-to-end to NetSuite p50 / p95 / p99 (sequential) | 1,977 / 2,006 / 2,031 ms | 244 / 261 / 264 ms |
| Burst: all 200 acknowledged | 0.63 s | 1.84 s |
| Burst: all 200 in NetSuite | 399.8 s (0.5 orders/s) | 3.8 s (53 orders/s) |
| Burst end-to-end p50 / p99 | 199 s / 395 s | 2.05 s / 3.42 s |
| CPU consumed during the run | 34.7 s over ~10 min | 5.25 s over ~1 min |
| Memory before → after | 539 → 588 MiB (4 containers) | 169 → 207 MiB (1 process) |
| Cold start to healthy | 12.9 s (5 containers incl. Postgres, migrate, seed) | 0.57 s (one process, local FeltDB) |
| Deployable artifact | 1.12 GB + 1.17 GB images | 183 MB `node_modules` + 1.3 MB build (image not built here, F7) |

**How to read it (no tuning was applied to either system):**
- **A's throughput** is its queue configuration as built: one adopted job per poll (`batchSize: 1`) with pg-boss's 2 s polling. A's end-to-end p50 of ~2 s is that poll.
- **B's latency** has the same kind of artifact: B's component sleeps 250 ms when its work queue is empty, and its end-to-end p50 is mostly that sleep.
- **Both are one-line tunings.** This benchmark compares the systems as delivered, not their ceilings.
- **Acknowledgement:** A is faster under concurrency (0.63 s vs 1.84 s for 200). B does a FeltDB transaction per webhook in the request path.
- **CPU:** A's figure includes ~10 minutes of idle polling by four containers, so it is not a per-order cost.
- **Memory:** compares four containers against one process. A's Postgres is a separate database server; B's FeltDB is embedded local state.
- **Correctness:** all 200 orders were delivered exactly once in both systems.

## D. Code economics

`experiment/economics/loc.ts` applies one line-counting rule to both systems (not blank, not comment-only) and explicit path rules. Results: `docs/evidence/runs/economics/loc.json`.

B also passes `feltkit measure --check`, with every file classified and each classification justified in `systems/b/feltkit.measure.json`.

| Category | A | B | Notes |
|---|--:|--:|---|
| **A: platform-owned** (FeltKit's generated Dockerfile, compose, DEPLOY.md, runtime, auth screens) | — | not counted | A has no platform layer: its equivalents are its own code (C, D) |
| **B: product** | 26,857 (incl. 2,609 S1) | 4,151 | A's product also covers what B lacks (PARITY.md): configuration/decision corrections, the OneWorld and inactive-account target paths, monitoring signals, economics metrics, a larger UI (3,711 vs 422 lines) |
| **C: residual glue** | 1,559 | 268 | A: HTTP server, sessions/CSRF, rate limits, queue wiring, keyring, logging. B: the component's routes and work loop |
| **D: manual assembly** | 957 | 266 | A: Dockerfiles, Compose, Caddy, Makefile, backup, seed. B: reset script, config, the EVE agent's package |
| **E: platform gaps** | 0 | 70 | B only: per-workspace secret custody (F4); shipping prebuilt artifacts (F10) |
| Generated | 28,111 | 258 | A: drizzle-kit migrations and snapshots. B: FeltKit codegen, prebuilt artifacts |
| Tests | 15,568 | 837 | A's test suite is far deeper (Vitest unit and integration, 230 tests) |
| Third-party (vendored) | 2,967 | 12,459 | B vendors two adopted applications in full; A vendors only the executed files |

**Supported conclusion:** for the shared scenarios, B carries roughly an order of magnitude less authored code.

The largest single reason is that FeltKit takes over what A wrote itself:
- auth, sessions and tenancy;
- the store, its schema and migrations;
- durable work and retries;
- the API surfaces;
- the deploy artifact;
- the sign-in and workspace UI.

**Not supported:** "B does the same product in 15% of the code". A's product code is broader and its tests are deeper; the ratio is not like-for-like.

## E. Assembly and ownership

| Concern | A owns | B owns | FeltKit owns (in B) |
|---|---|---|---|
| Accounts, sessions, CSRF, invitations, workspaces | ✓ (hand-built) | — | ✓ incl. screens |
| Data store, schema, migrations | ✓ Postgres + Drizzle | data model only | ✓ FeltDB, enforced schema |
| Background work, retries, leases, recovery | ✓ pg-boss + own delivery retries | work handlers | ✓ outbox, `afterCommit.work`, `ctx.work` |
| API / MCP surface | ✓ AppPort host wiring | declarations | ✓ AppPort + MCP with output contracts |
| Provider-signed webhooks | ✓ | ✓ component routes | — (F5: AppPort signatures only) |
| Customer secrets per tenant | ✓ keyring | ✓ sealing in the component | keyring custody only (F4) |
| Deploy artifact, health, boot verification | ✓ own Dockerfile/Compose/Caddy | — | ✓ `feltkit deploy` (8 targets) |
| Base image / CA / proxy in build | ✓ (`NODE_IMAGE`, `EXTRA_CA_FILE`) | blocked here (F7) | not offered |
| Agent runtime | ✓ planner in worker | ✓ EVE agent: own package, Node 24, own server (F15, F16, F18) | — |
| Backups | ✓ scripts | — | ✓ `feltkit backup` (not exercised here) |

B operates two runtimes, the FeltKit app on Node 22 and the EVE agent on Node 24. That is a real operational cost, and nothing in the stack removes it.

## F. Platform findings

`FINDINGS.md` records 18 findings, each with evidence:
- 2 retracted after your correction and a test (tenancy and roles);
- confirmed gaps: F4 per-tenant secrets, F5 provider webhook signatures, F7 Dockerfile hooks, F10 build-time artifacts, F15–F18 the EVE/FeltKit seams;
- several observations that are guarantees, not gaps: F12 refusing ambient FeltDB settings, F13 output contracts.

Candidates for upstream work, in order of value to this product:
1. **Workspace-owned credentials** (F4): a customer's provider keys held by the platform per workspace, usable by components.
2. **Provider signature schemes for inbound webhooks** (F5): HMAC-over-body (Shopify) and timestamped HMAC (Stripe) as declared verifiers.
3. **Deploy-time hooks** (F7): base image and extra CA in the generated Dockerfile.
4. **An EVE agent as a FeltKit deploy component** (F18), or at least a shared Node baseline (F16) and peer ranges that coexist (F15).
5. **Component hot reload in development** (F8).

## G. Anti-bias record

- **Separate systems:** separate code, state, ports, credentials and simulators (40xx vs 50xx).
- **No reuse of A's code:** B imports none of A's packages. Adopted third-party code was installed or vendored by B from its own pins. B's reviewed patches are its own.
- **Harness changes:** two harness-only simulator controls were added. System A's simulator tests still pass (15/15), and A never calls them.
- **Claims corrected when evidence contradicted them,** in both directions:
  - my two tenancy "gaps" in FeltKit (retracted);
  - my own bugs in B: the accounting undercount, the stale artifact manifest, the concurrency collision, the unchecked `runtime/`;
  - harness bugs that made A look worse: id collisions, negative quantities, cgroup paths. Those runs were discarded and re-run.
- **Benchmark conditions:** both systems were measured as delivered, untuned. Each system's dominant latency knob is named.

## H. Decision

**Recommendation: build new managed integrations on the FeltKit stack (System B's architecture), and keep System A as the reference until B reaches the remaining parity items.**

Evidence for:
- **All seven shared scenarios pass on B,** including the AI-assisted repair. EVE proposes; System B validates deterministically; a person approves; a canary is verified.
- **About an order of magnitude less authored code** for that scope. The difference comes from platform-owned concerns, not from cutting corners in the product logic.
- **Faster as delivered on this workload:** end-to-end 244 ms vs 1,977 ms at p50. Burst drain 3.8 s vs 400 s. About a third of the memory.
- **Platform guarantees caught real defects** in my code: output contracts, an enforced schema, durable work that survived restarts.

Evidence against, or open:
- **A's tests are far deeper** (230 Vitest tests vs B's scenario and browser suite).
- **A's product covers more** (PARITY.md).
- **B depends on four seams the stack does not yet close:**
  - per-workspace secrets;
  - provider-signed webhooks;
  - Dockerfile hooks;
  - EVE's separate runtime.
- **Two parts of B were not proven in production:** the container image (blocked in this environment) and the verified-e-mail staff path.

What would change this decision:
- a failure of B under a production-like deployment (real image, real Mailerport, real AppBoundry hosting when its execution gate opens);
- or upstream refusing F4 and F5, which would leave B carrying its own secrets and signature code permanently. That is still smaller than A's equivalent.
