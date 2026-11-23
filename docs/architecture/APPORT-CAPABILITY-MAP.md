# AppPort capability map

**As implemented in SLICE 1.** This document records the application's actual AppPort contract, the
authorization enforced at the capability boundary, the projections that consume it, and the platform
gaps that remain. It does not describe future capabilities as implemented.

AppPort is the capability and authority boundary of this product. The integration engine, workers and
operator console that predate this slice remain consumers of PostgreSQL; the capability layer is the
shared contract for humans (UI), software (HTTP) and agents (MCP).

## 1. Application identity

| Field          | Value                        | Source                                     |
| -------------- | ---------------------------- | ------------------------------------------ |
| Application id | `io.managedintegrations.app` | `packages/capabilities/src/application.ts` |
| Name           | Managed Integrations         | same                                       |
| Version        | `0.1.0`                      | same                                       |
| Protocol       | `appport/1`                  | published by `@appport/core` manifest      |

Pinned AppPort packages (versions match the local AppPort source tree inspected in Phase A):

| Package                     | Version                  | Role                                                                     |
| --------------------------- | ------------------------ | ------------------------------------------------------------------------ |
| `@appport/protocol`         | 1.7.0                    | wire types, envelopes, errors, manifest types                            |
| `@appport/schema`           | 1.2.1                    | input/output schema builder and JSON Schema publication                  |
| `@appport/core`             | 1.11.0                   | `createApplication`, `defineCapability`, dispatch pipeline               |
| `@appport/authorization`    | 1.2.2                    | `permissionAuthorizer`, `authorizerFrom`, `combineAuthorizers`           |
| `@appport/server`           | 1.3.6                    | HTTP binding (`createServer`, `createHttpBinding`, `createFetchHandler`) |
| `@appport/mcp`              | 1.3.12                   | MCP projection (`createMcpHandler`)                                      |
| `@appport/client`           | 1.1.10                   | browser capability client                                                |
| `@appport/transport-http`   | 1.1.10                   | browser HTTP transport                                                   |
| `@modelcontextprotocol/sdk` | 1.32.2 (range `^1.31.0`) | MCP JSON-RPC, negotiation and Streamable HTTP                            |

## 2. Registered capabilities

### Slice 2 additions (adopted executor)

`deliveries.list@1` (observation, `integrations.read`), `deliveries.get@1` (observation,
`integrations.read`) and `deliveries.retry@1` (consequential, `integrations.operate`) — MCP tools
`deliveries_list`, `deliveries_get`, `deliveries_retry`. Resource-level tenant policy:
`resourceTenantAuthorizer` (composed after `integrationsAuthorizer`). Invocation evidence: AppPort
`TelemetrySink` persisted to `audit_log` (`appport.invocation`). Details, schemas and evidence:
`docs/adoption/ADOPTION.md` §F. Permissions added: `integrations.operate`, `integrations.operate:any`.

### Slice 3 additions (reconciliation of the adopted flow)

`reconciliation.start@1` (consequential, `integrations.operate`), `reconciliation.runs@1` and
`reconciliation.items@1` (observation, `integrations.read`), `reconciliation.recover@1` (consequential,
`integrations.operate`; more than one order requires `confirm: true`) — MCP tools `reconciliation_start`,
`reconciliation_runs`, `reconciliation_items`, `reconciliation_recover`. No new authorization
infrastructure: `resourceTenantAuthorizer` additionally resolves `runId` → integration → tenant. They apply
to adopted integrations only (`CONFLICT` otherwise). Contract and evidence: `docs/adoption/RECONCILIATION.md`.

### Slice 4 additions (customer product)

`portfolio.list@1`, `portfolio.integration@1` and `maintenance.events.get@1` (observation,
`integrations.read`), and `maintenance.events.evidence@1` (observation, `integrations.read:any`: operators
only). MCP tools: `portfolio_list`, `portfolio_integration`, `maintenance_events_get`,
`maintenance_events_evidence`. None of them writes: maintenance event state is advanced only by the backend
lifecycle, and `transitionIncident` enforces the evidence required to resolve. The resource-tenant authorizer
also resolves `eventId` → incident → tenant. Contract and rules: `docs/product/MAINTENANCE.md`.

### Slice 5 additions (onboarding, adaptation)

Customer (own tenant from identity; no tenant ids in input): `onboarding.status@1` (observation,
`integrations.read`), `onboarding.discover@1` and `onboarding.confirm@1` (consequential,
`integrations.operate`). Operators only: `adaptations.inspect@1` (`integrations.read:any`),
`adaptations.propose@1`, `adaptations.validate@1`, `adaptations.activate@1`, `adaptations.rollback@1`,
`adaptations.reject@1` (`integrations.operate:any`). Only reviewed catalog patches can be proposed. No new
authorization infrastructure. Records: `docs/product/ONBOARDING.md`, `docs/product/ADAPTATION.md`.

### `integrations.list@1`

The first registered business capability (slice 1).

| Property       | Value                                                                               |
| -------------- | ----------------------------------------------------------------------------------- |
| Kind           | `request` (not a stream)                                                            |
| Effect         | `observation`                                                                       |
| Authorization  | `integrations.read`                                                                 |
| MCP tool       | `integrations_list` (deterministic projection: `.` → `_`)                           |
| Consumers      | web UI (`/app/integrations`), MCP clients (`POST /mcp`), direct invocation in tests |
| Durable state  | PostgreSQL `integrations` joined to `tenants`                                       |
| Implementation | `packages/capabilities/src/capabilities/integrations-list.ts`                       |
| Read model     | `packages/capabilities/src/repository.ts`                                           |

**Input schema** (as published in the manifest):

```json
{
  "type": "object",
  "properties": {
    "tenantId": {
      "type": "string",
      "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
      "description": "Optional tenant scope. A caller without integrations.read:any may only name its own tenant."
    }
  },
  "additionalProperties": false
}
```

`tenantId` is an optional **narrowing** scope, not proof of access. The authorizer refuses a tenant
that differs from the trusted principal's tenant unless the principal holds `integrations.read:any`.
The handler always derives the effective tenant from the trusted principal first and falls back to
the input only when the principal has no tenant.

**Output schema:**

```json
{
  "type": "object",
  "properties": {
    "tenant": {
      "type": "object",
      "properties": { "id": { "type": "string" }, "name": { "type": "string" } },
      "additionalProperties": false,
      "required": ["id", "name"]
    },
    "integrations": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "tenantId": { "type": "string" },
          "flowId": { "type": "string" },
          "displayName": { "type": "string" },
          "lifecycle": { "type": "string", "enum": ["setup", "active", "paused"] },
          "configVersion": { "type": "integer", "minimum": 1 },
          "createdAt": { "type": "string" },
          "updatedAt": { "type": "string" }
        },
        "additionalProperties": false,
        "required": [
          "id",
          "tenantId",
          "flowId",
          "displayName",
          "lifecycle",
          "configVersion",
          "createdAt",
          "updatedAt"
        ]
      }
    }
  },
  "additionalProperties": false,
  "required": ["tenant", "integrations"]
}
```

The output deliberately excludes `config`, credentials, cursor position, leases and provider
payloads. A leak test asserts that stored configuration never appears in the response.

**Predictable errors:**

| Condition                                                       | Code            | Where enforced                                  |
| --------------------------------------------------------------- | --------------- | ----------------------------------------------- |
| No authenticated session                                        | `UNAUTHORIZED`  | authorizer (`permissionAuthorizer`)             |
| Authenticated but missing `integrations.read`                   | `FORBIDDEN`     | authorizer                                      |
| Principal has no tenant and no `read:any`                       | `FORBIDDEN`     | tenant-boundary authorizer                      |
| `tenantId` differs from the principal tenant without `read:any` | `FORBIDDEN`     | tenant-boundary authorizer                      |
| Malformed or unknown input property                             | `INVALID_INPUT` | AppPort input validation (before authorization) |
| Tenant row does not exist                                       | `NOT_FOUND`     | capability handler                              |

## 3. Authorization model

Authorization is declared on the capability and enforced by `AppPortApplication.handleRequest`
before the handler runs. Transports never authorize.

Permissions (`packages/capabilities/src/identity.ts`):

| Permission              | Granted to                       | Meaning                                      |
| ----------------------- | -------------------------------- | -------------------------------------------- |
| `integrations.read`     | customer with a tenant; operator | read the caller's own tenant                 |
| `integrations.read:any` | operator                         | read any tenant, with an explicit `tenantId` |

Trusted identity is resolved from the existing `mi_session` httpOnly cookie by
`apps/api/src/appport-runtime.ts` → `loadSession` (PostgreSQL `sessions` row) → `toAppPortIdentity`:

```
session.id          = durable application session id (sha256 of the opaque token)
session.permissions = derived from role + tenant, never from request input
principal.id        = user id
principal.type      = "user"
principal.attributes = { role, tenantId? }
```

The authorizer (`packages/capabilities/src/authorization.ts`) composes:

1. `permissionAuthorizer()` — the session must hold every permission the capability declares.
2. `authorizerFrom("tenant-boundary", …)` — authentication, tenant presence, and cross-tenant input
   refusal.

Denial semantics are AppPort's own: `UNAUTHORIZED` means "authenticate", `FORBIDDEN` means "you
cannot". Both are distinguishable by UI and agent consumers.

**Isolation proof:** a customer of tenant A sending `{ "tenantId": "<tenant B>" }` receives
`FORBIDDEN` before any database read. The same holds through MCP. The direct capability test and the
MCP test both assert this.

## 4. One capability, two projections

```
                 ┌───────────────────────────────┐
   browser UI ───┤ @appport/client + HTTP        │──┐
   (/app/         │ (same-origin, mi_session)     │  │
    integrations) └───────────────────────────────┘  │
                                                     ├──► AppPortApplication.handleRequest
                 ┌───────────────────────────────┐  │    validate → authorize → execute →
   MCP client ───┤ @appport/mcp createMcpHandler │──┘    serialize → output validation
   (POST /mcp)   │ (same cookie, identity only)  │
                 └───────────────────────────────┘
                                       │
                                       ▼
                         integrations.list@1 handler
                                       │
                                       ▼
                             PostgreSQL (integrations ⋈ tenants)
```

- The UI calls the capability through the published HTTP binding (`POST /appport`) using
  `@appport/client` and `@appport/transport-http`. It has no REST listing endpoint of its own.
- MCP `tools/call` is translated by `@appport/mcp` into the same `AppRequest` and dispatched through
  `handleRequest`.
- Both receive identity from the same cookie → `loadSession` path. MCP arguments and `_meta` cannot
  carry identity.

Transport endpoints mounted by `apps/api/src/appport-routes.ts`:

| Path                    | Served by                      | Purpose                                               |
| ----------------------- | ------------------------------ | ----------------------------------------------------- |
| `/.well-known/appport`  | `@appport/server` HTTP binding | discovery                                             |
| `POST /appport`         | HTTP binding                   | capability invocation                                 |
| `GET /appport/manifest` | HTTP binding                   | manifest                                              |
| `GET /appport/public`   | HTTP binding                   | public description                                    |
| `GET /appport/events`   | HTTP binding                   | events (none registered)                              |
| `POST /mcp`             | `@appport/mcp`                 | MCP Streamable HTTP (stateless; `GET`/`DELETE` → 405) |

`apps/api/src/appport-routes.ts` is a transport adapter only: it converts Fastify requests to WHATWG
`Request` objects and back. It contains no business logic and no authorization.

## 5. Capability matrix (Phase A finding)

| Area                      | Implemented                                                                                                                            | Verified                                                                           | Limitations                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Capability definition     | `defineCapability` with `name`, `version`, `effect`, `authorization`, `input`, `output`, `handler` — `@appport/core/src/capability.ts` | manifest test asserts name/version/kind/authorization/schema                       | No stream capabilities in this slice (none needed)                             |
| Capability registration   | `createApplication({ capabilities, authorizer })` — `@appport/core/src/application.ts`                                                 | app starts; manifest lists `integrations.list`                                     | Registration is per-process; no dynamic loading                                |
| Discovery                 | `GET /.well-known/appport`, `GET /appport/manifest`, `appport.manifest` capability                                                     | HTTP test and live `curl`                                                          | No signed/pinned discovery used by this app yet                                |
| Input validation          | `s.object(... additionalProperties false)` before authorization                                                                        | invalid UUID and unknown property → `INVALID_INPUT` (direct + MCP)                 | Schema does not cross-check existence; handler returns `NOT_FOUND`             |
| Output validation         | Declared `output` schema validated by core                                                                                             | handler returns the declared shape; malformed output would be `INTERNAL_ERROR`     | Not separately fault-injected                                                  |
| Authorization             | `combineAuthorizers([permissionAuthorizer(), authorizerFrom(...)])` — `@appport/authorization/src/index.ts`                            | anonymous `UNAUTHORIZED`; missing permission `FORBIDDEN`; cross-tenant `FORBIDDEN` | No resource-level grants table; tenant policy is code                          |
| MCP exposure              | `createMcpHandler(application, { context })` — `@appport/mcp/src/server.ts`                                                            | real MCP SDK client lists and calls `integrations_list`                            | Stateless adapter: no sessions, resumability, or server-initiated streams      |
| MCP invocation            | `tools/call` → `toAppRequest` → `handleRequest`                                                                                        | persisted rows returned; errors are `isError` with `dev.appport/error`             | No MCP resources/prompts; tools only                                           |
| Runtime integration       | Fastify adapter around WHATWG handlers                                                                                                 | stack runs; `curl` and Playwright use it                                           | Adapter re-serializes Fastify's parsed body (temporary)                        |
| Identity propagation      | Cookie → `loadSession` → `Session`/`Principal`                                                                                         | same identity for UI, MCP and direct tests                                         | AppPort has no authenticator; the host must implement this (by design)         |
| Tenant/resource isolation | Trusted tenant + authorizer + tenant-constrained query                                                                                 | tenant A cannot read B by any input                                                | Operator `read:any` is intentionally global                                    |
| Error handling            | AppPort error codes; MCP adapter maps codes to categories                                                                              | `UNAUTHORIZED`, `FORBIDDEN`, `INVALID_INPUT` observed                              | Production mode sanitizes internal detail (host must use `requestId`/trace id) |
| Telemetry                 | AppPort `telemetry` option, sink persisted to `audit_log` (slice 2)                                                                    | every invocation incl. refusals recorded (`apps/api/test/adopted-appport.test.ts`) | writes are asynchronous; a crash can lose the last records                     |

## 6. Platform gaps and local workarounds

| Gap                                             | Source evidence                                                                                                                         | Workaround in this slice                                                                                               | Smallest platform change                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| AppPort does not authenticate callers           | `@appport/server` `AuthenticationRequest`/`Identity`; authorization never infers trust from transport (`@appport/authorization` README) | Host resolves `mi_session` and passes `Session`/`Principal`                                                            | None required — this is the intended split                          |
| No durable `SessionStore` in core (memory only) | `@appport/core/src/sessions.ts` `MemorySessionStore`                                                                                    | The application's `sessions` table is the authority; identity is rebuilt per request, never stored in AppPort sessions | Optional durable session store adapter                              |
| MCP adapter is stateless                        | `@appport/mcp/src/server.ts` `createMcpHandler` creates a `Server` per request, declines `GET`/`DELETE`                                 | Acceptable: every tool call is self-contained; identity travels in the cookie                                          | Stateful transport support if server-initiated streams are required |
| HTTP binding consumes a text body               | `@appport/server/src/fetch.ts` reads `request.text()`                                                                                   | Fastify adapter stringifies the parsed body before constructing the `Request`                                          | A streaming/body-adapter variant                                    |
| No capability audit log in the contract         | AppPort has telemetry/evidence hooks; no built-in audit table                                                                           | Slice 2: telemetry sink writes every invocation (reads and refusals included) to the existing `audit_log`              | Telemetry sink or application-level invocation hook                 |
| No capability-level integration with the worker | Worker uses pg-boss and direct DB access                                                                                                | Out of scope: this slice registers one read capability                                                                 | Later slices may expose worker operations as capabilities           |

## 7. Verification commands

```bash
# Contract, persistence and authorization (direct AppPort invocation)
pnpm exec vitest run packages/capabilities/test/integrations-list.test.ts

# Native MCP client over Streamable HTTP + HTTP binding
pnpm exec vitest run apps/api/test/appport-mcp.test.ts

# Manifest and MCP tool projection
DATABASE_URL=postgres://mi:mi_dev_password@127.0.0.1:5432/managed_integrations_test \
  pnpm --filter @mi/capabilities exec tsx scripts/print-manifest.ts

# UI as a capability consumer (requires `make up`)
pnpm exec playwright test -g "integrations page"
```

Recorded output: `docs/evidence/runs/appport-manifest.log`, `docs/evidence/runs/appport-http.log`.

## 8. Not implemented (do not read this map as a roadmap)

Business capabilities: `integrations.list`, since slice 2 `deliveries.list` / `deliveries.get` /
`deliveries.retry`, and since slice 3 `reconciliation.start` / `runs` / `items` / `recover` (all adopted
executor only), and since slice 4 `portfolio.list` / `portfolio.integration` / `maintenance.events.get` /
`maintenance.events.evidence` (read-only). There is no capability for creating, configuring, enabling, disabling or syncing
integrations; no connection or credential capability; no sync, backlog, incident, maintenance or release
capability, and the native engine's reconciliation is not projected. Those operations remain
in the pre-existing REST/worker paths and are **not** projected through AppPort yet.
