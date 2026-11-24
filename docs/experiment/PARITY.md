# Parity matrix — System A (control) vs System B (FeltKit)

Status per capability, with the evidence for each system.
- ✅ = present and exercised by a passing scenario or test.
- ◐ = present, with the stated difference.
- ✗ = not built.

Scenario IDs refer to `SCENARIOS.md`.

## Integrations and flows

| Capability | A | B | Evidence / difference |
|---|---|---|---|
| Adopted Shopify → NetSuite order sync (upstream @ d01b51d runs the work) | ✅ | ✅ | S2 in both systems |
| Signed webhook ingress (Shopify HMAC over raw body, shop domain, webhook id) | ✅ | ✅ | B uses the upstream's own `verifyShopifyHmac`, in a FeltKit component (FINDINGS F5) |
| Durable receipt + dedupe (webhook id, `integration:source` key) | ✅ | ✅ | B: `receipts` and `deliveries` collections with unique constraints |
| Automatic retries with a bound, then left for a person | ✅ 5 tries with backoff | ✅ 5 work attempts | B: FeltKit's work retry (`maxAttempts`); A: pg-boss plus its own schedule |
| `deliveries.list/get/retry` (duplicate retry → CONFLICT) | ✅ | ✅ | S2 |
| Reconciliation: classify, recover once, verify in the target, refuse duplicates | ✅ | ✅ | S3 |
| Maintenance lifecycle: detect → investigate (file:line) → correct → validate → activate → recover → verify → account | ✅ | ✅ | S4. B's driver is deterministic, as is A's adopted-flow driver |
| Correction kinds: adapter, patch, configuration, decision, unsupported | ✅ all five | ◐ adapter, patch, unsupported exercised; configuration/decision declared only | A exercises configuration and decision in slice-7 Vitest scenarios (OneWorld, inactive account); B has no scenario for them |
| Operator activation / rollback / reject with history | ✅ | ✅ | S6 and S7 (activation, rollback drill) |
| Onboarding: connect → discover from the customer's own writes → versioned confirm → baseline | ✅ | ✅ | S5 and S6 |
| Stripe → QuickBooks (ledgerly @ 3101182) | ✅ | ✅ | S6 |
| QuickBooks OAuth with rotating refresh tokens; revoke → held → reconnect → exactly once | ✅ | ✅ | S6 and S7 |
| Provider dependency check from the running code (minorversion 70 → 75) | ✅ | ✅ | S6. B reads the artifact's own source; patch validated by replay |
| Hosted Stripe application with its own records, read-back verification, basil patch | ✅ | ✅ | S7 |
| QuickBooks tools (quickbooks-mcp): exactly-once invoke, held on revoke, upstream release by request-level replay, rollback | ✅ | ◐ | S7. B's `applications.invoke` is asynchronous (poll `applications.request`). A's returns the outcome in the call |
| Native polling sync engine + schema-drift incident + agent repair + operator approval + canary release (S1) | ✅ | ◐ | S1 in both systems. A's agent edits code in a worktree (Claude planner, or playbook); B's EVE agent (or playbook) proposes a change to the engine's declared query specification — a narrower repair surface, validated by a fixed acceptance suite against the live provider. A validates in a Docker sandbox; B against the provider (read only). Both: operator approval, canary, automatic rollback on a failed canary |
| Target-side scenarios in Vitest: OneWorld subsidiary, inactive QBO account (610), combined source+target | ✅ | ✗ | A covers these in slice-7 tests; B has no equivalent scenario |
| OpenAPI contract pipeline (`@mi/openapi`, slice 8) | ✅ | ✗ | Slice 8 analysis tooling; not re-implemented in B |

## Product surfaces

| Capability | A | B | Evidence / difference |
|---|---|---|---|
| Sign-in, sign-up, sessions, CSRF | ✅ hand-built | ✅ FeltKit | B writes no auth code. FeltKit accounts, cookie sessions with CSRF, `SignIn` screen |
| Tenancy | ✅ hand-built (`tenant_id` filters + AppPort authorizers) | ✅ FeltKit workspaces | B: `tenant: true` collections. Another company's records are `NOT_FOUND` (A answers `FORBIDDEN`) |
| Staff / operators | ✅ global operator accounts | ◐ staff are invited into each customer's company as `operator` | Different model, same authority. An all-companies inbox is per company (TenantSwitcher). Production staff need verified e-mail (F14) |
| Customer UI: overview/portfolio, connections, set-up, integration, maintenance outcome | ✅ | ✅ | Playwright (B: `systems/b/e2e`) |
| Operator UI: inbox, integration (adopted code, corrections, deliveries, reconciliation), evidence | ✅ | ✅ | Playwright |
| Operator UI: releases (canary), economics/metrics, candidates (agent repair) | ✅ | ◐ | B shows candidates (corrections with planner, hypothesis and validation) on the operator's integration page; no separate releases or economics screens |
| AppPort capabilities | ✅ 24 | ✅ 23 (AppPort + MCP served by FeltKit) | B publishes each function's capability with a declared output schema (F13) |
| MCP endpoint | ✅ (session cookie) | ◐ FeltKit `/mcp` (needs an agent or service session: `feltkit session create`) | Driven through MCP in A's demos; B's scenarios use FeltKit's client |
| Credential encryption at rest | ✅ AES-GCM keyring, AAD per row | ✅ AES-GCM keyring (in FeltKit custody), AAD per workspace and purpose | B: the keyring itself is a FeltKit credential |
| Audit / activity | ✅ `audit_log` | ✅ FeltKit activity log + per-record histories | |
| Deploy | ✅ Docker Compose (own Dockerfile, Caddy, backups) | ◐ `feltkit deploy` container target built and boot-verified by FeltKit | Image build blocked here (F7); the same artifact ran in production mode via FeltKit's Node path; S2 and S3 passed against it |

## Not at parity (stated, not hidden)

1. **S1's repair surface.** B repairs a declared engine specification proposed by EVE (or the playbook), not
   arbitrary code. A's agent can edit source files under a protected test suite. B's approach is safer and
   simpler to validate. It is also less general: a change that the specification does not express would need an engineer.
2. **Configuration and decision corrections, and the slice-7 target scenarios** (OneWorld, inactive QuickBooks account,
   combined source+target). B's registry declares these kinds, but no B scenario exercises them.
3. **The OpenAPI contract pipeline and the slice-8 analysis tooling.** These are analysis tools around A, not runtime features.
4. **Production staff.** Not run (no mail service; FINDINGS F14).
5. **The container image** of B's deployment was not built here (F7); the same artifact ran with FeltKit's Node path.
