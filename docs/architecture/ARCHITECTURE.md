# Architecture (as implemented)

```
             ┌──────────── browser ────────────┐
             │ /app (customer)    /ops (operator) │
             └───────────────┬───────────────────┘
                             │ HTTPS (Caddy in prod)
                    ┌────────▼────────┐        pg-boss jobs (PostgreSQL)
                    │ api (Fastify)   │──────────────┐
                    │ auth, CSRF, UI  │              │
                    └────────┬────────┘              ▼
                             │            ┌───────────────────┐  decrypts credentials
          PostgreSQL ◄───────┼────────────│ worker (runtime)  │──► Shopify GraphQL / NetSuite REST
      (authoritative state)  │            │ tick, sync,       │    (fixtures in demo)
                             │            │ reconcile, release│
                             │            └───────────────────┘
                             │            ┌───────────────────┐  NO encryption keys
                             └────────────│ worker            │──► git worktrees of OUR source
                                          │ (maintenance)     │──► docker: --internal network sandbox
                                          └───────────────────┘     (node + throwaway postgres)
```

## Components

- **AppPort capability layer** (`packages/capabilities`, mounted in `apps/api`): one
  `@appport/core` application (`io.managedintegrations.app`) owns the capability contract and the
  authorization boundary. Today it registers `integrations.list@1`; the browser UI and MCP are two
  projections of the same `AppPortApplication.handleRequest` pipeline
  (`validate → authorize → execute → serialize`). See
  [`APPORT-CAPABILITY-MAP.md`](APPORT-CAPABILITY-MAP.md).
- **API** (`apps/api`): session auth (scrypt, httpOnly cookie, per-session CSRF), customer routes (status,
  connections, Shopify OAuth, NetSuite M2M setup, integration config, history, reliability, incidents),
  operator routes (exception inbox, incidents, candidates, approve/reject, releases/rollback, metrics,
  audit). Serves the built UI and the AppPort HTTP binding (`/.well-known/appport`, `/appport`,
  `/appport/manifest`, `/appport/public`, `/appport/events`) and MCP (`POST /mcp`). Internal errors
  return only a request id.
- **Runtime worker** (`apps/worker`, `WORKER_ROLE=runtime`): `reliability.tick` every minute (recover
  interrupted runs → schedule due syncs/reconciliations → evaluate → execute actions), `sync.run`,
  `reconcile.run`, `backlog.assess`, `release.run`.
- **Maintenance worker** (`WORKER_ROLE=maintenance`): `maintenance.run` (agent) and `validation.run`
  (independent validation). Configuration refuses encryption keys, so it cannot read credentials.
- **Sync engine** (`integration-shopify-netsuite/src/engine.ts`, stable): leases, cursor, idempotency,
  retries, evidence. Executes a **versioned implementation** (`src/implementation/**`: GraphQL documents,
  parsing, mapping) loaded from an immutable, checksum-verified artifact (`integration_versions`).
- **Reliability** (`packages/reliability`): deterministic rules → incidents (strict state machine) and
  actions; independent reconciliation using its own stable identity query (works while the
  implementation is broken).
- **Maintenance** (`packages/maintenance`): restricted toolbox, planners (deterministic playbook; Claude
  via Messages API when configured), Docker sandbox, validation, artifacts, release/canary/rollback.

## Key decisions

- **AppPort is the capability boundary**: capabilities are defined once with `defineCapability` and
  registered in one `createApplication`; UI, MCP and tests consume the same `handleRequest` path.
  Authorization is declared on the capability and enforced before the handler, never in a transport.
  There is no second capability registry, permission engine or MCP router.
- **Trusted identity is host-owned**: AppPort does not authenticate. The API resolves the existing
  `mi_session` cookie against the durable `sessions` table and hands AppPort a `Session`/`Principal`
  whose permissions are derived from role and tenant. Capability input (including `tenantId`) is never
  accepted as proof of authority.
- **Decision vs execution**: reliability rules return actions; workers execute them as durable jobs.
- **Durable authority**: PostgreSQL holds every lifecycle state; pg-boss jobs carry only ids. Agent tool
  logs are evidence, never the lifecycle record.
- **Engine/implementation split**: only provider-facing code is versioned and agent-editable, so a repair
  can be canaried and rolled back without redeploying the engine, and the agent cannot touch cursor,
  retry or idempotency logic.
- **Independence of validation**: constructed (fresh tree at base + editable-path diff only, suite hash
  check), not trusted.
- **Deterministic first**: the shipped demo repair uses a deterministic playbook; an LLM planner is
  optional and replaceable (`MAINTENANCE_PLANNER`).

## Capability path (implemented)

```
browser /app/integrations ── @appport/client + @appport/transport-http ─┐
MCP client POST /mcp ── @appport/mcp createMcpHandler ──────────────────┤
direct tests ── application.handleRequest ──────────────────────────────┘
        → validate input → authorize (permission + tenant boundary)
        → integrations.list handler → PostgreSQL → validate output
```

`apps/api/src/appport-routes.ts` is a Fastify ↔ WHATWG `Request`/`Response` adapter only. It forwards
to the AppPort HTTP binding and MCP handler; it contains no business logic and no authorization.
Identity for both projections comes from the same cookie → `loadSession` resolver in
`apps/api/src/appport-runtime.ts`.

## Observability

Pino JSON logs with correlation id, trace id (W3C-format), tenant/integration/run ids via
AsyncLocalStorage; deep redaction of secrets by key and value shape. OpenTelemetry export and Sentry are
**not** wired (no collector/DSN available) — see KNOWN-LIMITATIONS.
