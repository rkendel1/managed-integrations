# Managed Integrations

> Your application stays connected. We keep the integrations working.

A managed service that takes operational responsibility for customers' integrations — adopted open-source
integration code (Shopify → NetSuite order sync, Stripe → QuickBooks bookkeeping, provider-dependent
applications) — and keeps them correct, complete, current and recoverable when the source, the target, the
provider or the code changes. Customers buy the reliability outcome; the runtime, the maintenance driver and
the repair agent are internal delivery mechanisms.

## The application: [`systems/b`](systems/b) (FeltKit)

**The primary application is System B**, built on FeltKit (FeltDB, AppPort, AppPort Services). It is the code
to run, change and extend. Start with [`systems/b/README.md`](systems/b/README.md).

```bash
make app-install
```

```bash
make app-test        # function and unit tests (a fresh FeltDB per test; no servers)
```

```bash
make app-scenarios   # reset, then all ten shared scenarios S1–S10 against the provider simulators
```

```bash
make app-dev         # run it: http://127.0.0.1:3100 (simulators on ports 50xx)
```

`make app-e2e` runs the browser journeys; `make app-check` the typecheck, the prebuilt-artifact check and
FeltKit's code classification. Requirements: Node ≥ 22.12 with npm, pnpm 10 (for the shared simulators), openssl.

**Status:** every shared scenario passes on B, including the target-side and combined changes; parity with
System A, and what is still not at parity, is in [`docs/experiment/PARITY.md`](docs/experiment/PARITY.md).
Everything runs against **deterministic provider simulators**, never real Shopify, NetSuite, Stripe or
QuickBooks accounts.

## The reference implementation: System A (PostgreSQL, Docker)

Everything below this line describes **System A**, the original implementation (Fastify, pg-boss,
Drizzle/PostgreSQL, React, its own Docker stack) in `apps/` and `packages/`. It is kept **only as a
reference**: the control in the comparison ([`docs/experiment/REPORT.md`](docs/experiment/REPORT.md)), the
record of behaviour B was built to match, and the source of the shared provider simulators
(`packages/test-fixtures`, which B also uses). New work goes into `systems/b`. A is not deleted because its
deeper test suite and its demos remain the most detailed specification of the behaviour.

A's own status: first vertical slice built and verified against deterministic provider fixtures, never real
accounts — see [`docs/evidence/KNOWN-LIMITATIONS.md`](docs/evidence/KNOWN-LIMITATIONS.md) and
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

### Slice 2: an adopted integration operated through AppPort

Tenant **Bluewave Supply** runs the unmodified open-source
[`shopify-erp-order-sync`](https://github.com/Milo-ai-HQ/shopify-erp-order-sync) (MIT, commit `d01b51d`) as its
executor; Managed Integrations owns receipt, durability, retry, evidence and access through AppPort
(`deliveries.list/get/retry`, also as MCP tools). Login `ops@bluewave.test` / `bluewave-demo-password`.

```bash
make reset && make demo-adopted
```

Record of discovery, selection, boundary and provenance: [`docs/adoption/ADOPTION.md`](docs/adoption/ADOPTION.md).

### Slice 3: reconciliation and missing-delivery recovery

Bluewave's orders are read from Shopify independently of webhooks, classified against delivery evidence
and NetSuite, and missed orders are recovered through the same adopted code and then verified in NetSuite
(`reconciliation.start/runs/items/recover`, also as MCP tools; panel on the deliveries page). Bluewave's
store is a second fixture shop on port 4011.

```bash
make reset
```

```bash
make demo-reconcile
```

Contract, guarantees and gaps: [`docs/adoption/RECONCILIATION.md`](docs/adoption/RECONCILIATION.md).

### Slice 4: the customer product and a verified maintenance lifecycle

Customers now see the product: the integrations we maintain, an evidence-based status with the rule that
defines it, and maintenance events told as outcomes ("We resolved a compatibility issue … Zero transactions
lost.", only when proven). Operators see the same story plus the evidence behind it. The demo changes the
Shopify fixture's webhook format (fictional, documented); the running worker detects it, holds the affected
orders, corrects the integration at the adoption boundary (upstream unmodified), validates the correction,
recovers delayed and missing orders, verifies them line by line in NetSuite and accounts for every order.

```bash
make reset
```

```bash
make demo-maintenance
```

Then sign in as `ops@bluewave.test` / `bluewave-demo-password`. How it works, and what we can and cannot
claim: [`docs/product/MAINTENANCE.md`](docs/product/MAINTENANCE.md).

### Slice 5: frictionless onboarding and managed adaptation

A new customer signs up, connects Shopify and NetSuite, and we discover their existing integration from
what actually reached NetSuite; they confirm once and we take over (order notification registered,
baseline checked twice). Every change to how the adopted code behaves — an adapter, a reviewed patch, or an
unsupported change routed to a person — lives in one registry with provenance, validation, activation and
rollback, and operators can see exactly what code runs and why.

```bash
make reset
```

```bash
make demo-onboarding
```

Records: [`docs/product/ONBOARDING.md`](docs/product/ONBOARDING.md), [`docs/product/ADAPTATION.md`](docs/product/ADAPTATION.md).

### Slice 6: a second integration on the same mechanisms (Stripe → QuickBooks)

```bash
make reset && make demo-stripe
```

The adopted open-source [ledgerly](https://github.com/jakethehoffer/ledgerly) (Apache-2.0, commit-pinned) books
Stripe payments, refunds and payouts as balanced QuickBooks journal entries. The demo onboards a customer whose
own ledgerly deployment already writes to QuickBooks (discovered from their books, account mapping included),
books a new payment, has an operator switch on a reviewed patch for a QuickBooks API version Intuit retired, and
recovers from lost QuickBooks authorization with zero loss proven. Fixtures: Stripe on :4030, QuickBooks on
:4040. Design: [docs/architecture/PORTABILITY.md](docs/architecture/PORTABILITY.md); selection and provenance:
[docs/adoption/SECOND-INTEGRATION.md](docs/adoption/SECOND-INTEGRATION.md).

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
