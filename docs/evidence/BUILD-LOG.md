# Build log

## 2026-11-23 — session 1 (first vertical slice)

Environment: empty git repo; Node 22.23, pnpm 10.28, PostgreSQL 16 (local), Docker 29 (daemon started
manually; Docker Hub rate-limited → `mirror.gcr.io`), TLS-intercepting egress proxy. No Shopify, NetSuite,
Anthropic or Sentry credentials.

1. **Research**: official Shopify/NetSuite docs (subagent, cited) → `architecture/PROVIDER-RESEARCH.md`.
   Decisions: Shopify GraphQL 2026-10 + expiring offline tokens; NetSuite M2M client credentials + eid upsert.
2. **Foundation**: monorepo, Drizzle schema (20 tables), migration applied to local PostgreSQL.
3. **Fixtures**: Shopify (graphql-js executed schema, cost bucket, OAuth, faults) and NetSuite (JWT
   verification, eid upsert, SuiteQL subset, governance, faults).
4. **Engine + acceptance suite**: first run 25/27 — two failures exposed a real bug (pagination anomalies
   recorded as `error` instead of `anomaly`, case-sensitive regex); fixed → 27/27.
5. **Reliability**: reconciliation, incident state machine, detection rules → 17/17.
6. **Sandbox spike**: offline pnpm install into a worktree + tests in a Docker `--internal` network with a
   throwaway Postgres; network isolation confirmed (`EAI_AGAIN`); 1 failure from fixture keep-alive
   sockets under CPU limits → `forceCloseConnections` → 27/27 in sandbox (13 s).
7. **Maintenance + release**: toolbox, playbook, validation, release. Pipeline test iterations exposed:
   escaped quotes in observation matching; acceptance output lacking the provider error text →
   switched to a reproduction-first regression test (spec §16); stale read in the test. Final: passes (79 s).
8. **API + UI**: 9/9 API tests first run; web build 360 KB.
9. **Docker**: build failures from the TLS proxy (npm, apt) → optional BuildKit CA secret + HTTPS apt with
   explicit proxy; apt's `_apt` user could not read the 0400 secret → readable temp copy. Stack up; first
   scheduled backfill 30/30 from the checksum-verified artifact.
10. **Demo in Docker**: first attempt produced invalid evidence (fixtures restarted → auth failure; step 1
    counted a pre-existing run) → demo now requires fresh runs and baseline fixture state; `make reset`.
    Maintenance container install failures: store missing packages (`pnpm fetch` added) and pnpm choosing a
    store on the mounted filesystem (`npm_config_store_dir`). Final: 19 steps in 93 s
    (`runs/demo-failure-docker.log`).
11. **Crash test**: SIGKILL mid-run → interrupted → resumed; 90/90 unique (`runs/crash-test-docker.log`).
12. **Browser tests**: Playwright 4/4 against the stack (incl. unmapped-SKU action loop).
13. **Backup/restore**: identical row counts (`runs/backup-restore-docker.log`).
14. **Quality gates**: ESLint (6 real findings fixed), Prettier, typecheck (node + web), full suite
    9 files / 76 tests (122 s); release tests (auto + operator rollback) 2/2 added after.

Commands: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `make up`, `make reset`,
`make demo-failure ARGS=--auto-approve`, `./scripts/crash-test.sh`, `pnpm exec playwright test`.
