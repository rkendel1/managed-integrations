# Managed Integrations

> Your application stays connected. We keep the integrations working.

A managed service that takes operational responsibility for one data flow — **Shopify orders → NetSuite
sales orders** — and keeps it correct, complete, current and recoverable. Customers buy the reliability
outcome; the engine, workers, reliability system and maintenance agent are internal delivery mechanisms.

**Status:** first vertical slice built and verified against **deterministic provider fixtures**. It has
**not** been run against real Shopify or NetSuite accounts (no credentials were available) — see
[`docs/evidence/KNOWN-LIMITATIONS.md`](docs/evidence/KNOWN-LIMITATIONS.md) and
[`docs/evidence/ACCEPTANCE.md`](docs/evidence/ACCEPTANCE.md).

**SLICE 1 (AppPort-native foundation):** the application is now an AppPort application
(`io.managedintegrations.app`). One real capability, `integrations.list@1`, is backed by PostgreSQL,
authorized at the capability boundary, and consumed by both the browser UI (`/app/integrations`) and
MCP clients (`POST /mcp`). Contract, permissions, verified/unverified areas and platform gaps:
[`docs/architecture/APPORT-CAPABILITY-MAP.md`](docs/architecture/APPORT-CAPABILITY-MAP.md).

## Run it (Docker)

Requirements: Docker with Compose v2, git, make, openssl.

```bash
make up
```

This creates `.env` with a fresh credential-encryption key (first run only), builds the images and starts
the full stack with the deterministic fixtures. Then open http://localhost:3000:

| Role     | Email                                | Password (demo only)     |
| -------- | ------------------------------------ | ------------------------ |
| Customer | `customer@acme.test`                 | `customer-demo-password` |
| Operator | `operator@managed-integrations.test` | `operator-demo-password` |

Other commands:

```bash
make ps        # service status
make logs      # follow logs
make down      # stop (keeps data)
make reset     # DESTROY demo data and start fresh (fixtures keep state in memory only)
```

End-to-end failure demonstration (spec §21) against the running stack — it waits for you to approve
the repair in the operator UI:

```bash
make demo-failure
```

Unattended variant (the approval is a scripted stand-in for the human click and is labelled as such):

```bash
make reset && make demo-failure ARGS=--auto-approve
```

Worker crash/restart check (SIGKILL mid-sync, resume, no duplicates):

```bash
make reset && ./scripts/crash-test.sh
```

Browser tests against the running stack (the unmapped-SKU test adds a SKU mapping, so start from a
fresh stack; allow the first scheduled sync to run so `last-sync` is populated):

```bash
make reset
pnpm install && pnpm exec playwright test
```

The AppPort capability and MCP tests do not need the Docker stack:

```bash
pnpm exec vitest run packages/capabilities/test/integrations-list.test.ts apps/api/test/appport-mcp.test.ts
```

Behind a TLS-intercepting proxy or Docker Hub rate limits, set the build/image overrides documented in
`.env.example` (`EXTRA_CA_FILE`, `BUILD_NETWORK`, `BUILD_HTTPS_PROXY`, `*_IMAGE`).

### Production (single VPS)

```bash
make prod-up
```

This adds Caddy (HTTPS, automatic certificates for `MI_DOMAIN`) and nightly verified `pg_dump` backups,
and refuses fixture overrides. See [`docs/operations/OPERATIONS.md`](docs/operations/OPERATIONS.md) for the
required environment.

## Develop locally (without Docker for the app)

Requirements: Node ≥ 22.12, pnpm 10, PostgreSQL 16, Docker (only for the maintenance sandbox).

```bash
pnpm install
```

```bash
DATABASE_URL=postgres://mi:mi_dev_password@localhost:5432/managed_integrations pnpm db:migrate
```

```bash
pnpm typecheck && pnpm lint && pnpm test
```

`pnpm test` needs a test database (`DATABASE_URL_TEST`, default
`postgres://mi:mi_dev_password@localhost:5432/managed_integrations_test`) and Docker for the
maintenance pipeline test (skipped with a message when Docker is unavailable).

## Repository map

```
apps/api        Fastify API (customer + operator), serves the web UI, AppPort HTTP binding and MCP
apps/worker     pg-boss workers: runtime role (sync, reconcile, release) and maintenance role (agent, validation)
apps/web        React + Vite + Tailwind + TanStack Query UI (customer /app, operator /ops)
packages/capabilities               AppPort application: capability contracts, authorizer, identity mapping, read model, HTTP/MCP runtime
packages/contracts                  reliability contract v1, config schema, error classes, queues
packages/database                   Drizzle schema + migrations (PostgreSQL is the authority)
packages/integration-shopify-netsuite  provider clients, OAuth/M2M, sync engine; src/implementation = versioned code
packages/reliability                reconciliation, incidents, deterministic detection rules
packages/maintenance                agent toolbox/planners, Docker sandbox, independent validation, release/canary/rollback
packages/observability              pino logging, redaction, correlation/trace ids
packages/test-fixtures              DETERMINISTIC Shopify + NetSuite fixtures (not the real providers)
docs/                               product, architecture, operations, roadmap, evidence
```
