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
| Native polling sync engine + schema-drift incident + agent repair + operator approval + canary release (S1) | ✅ | ✗ | Not built in B (see "Not at parity") |
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
| Operator UI: releases (canary), economics/metrics, candidates (agent repair) | ✅ | ✗ | Belongs to S1 / A's native pipeline, which B does not have |
| AppPort capabilities | ✅ 24 | ✅ 20 (AppPort + MCP served by FeltKit) | B publishes each function's capability with a declared output schema (F13) |
| MCP endpoint | ✅ (session cookie) | ◐ FeltKit `/mcp` (needs an agent or service session: `feltkit session create`) | Driven through MCP in A's demos; B's scenarios use FeltKit's client |
| Credential encryption at rest | ✅ AES-GCM keyring, AAD per row | ✅ AES-GCM keyring (in FeltKit custody), AAD per workspace and purpose | B: the keyring itself is a FeltKit credential |
| Audit / activity | ✅ `audit_log` | ✅ FeltKit activity log + per-record histories | |
| Deploy | ✅ Docker Compose (own Dockerfile, Caddy, backups) | ◐ `feltkit deploy` container target built and boot-verified by FeltKit | Image build blocked here (F7); the same artifact ran in production mode via FeltKit's Node path; S2 and S3 passed against it |

## Not at parity (stated, not hidden)

1. **S1: native sync with AI repair.** A's legacy flow (`demo-failure.ts`) is not built in B:
   - a polling GraphQL engine with a held cursor;
   - an agent that edits code in a worktree (Claude planner or playbook);
   - an independent Docker sandbox validation;
   - an operator approval;
   - a canary release with automatic rollback.

   EVE (`@appport/eve`, Apache-2.0) is the stack's agent runtime and would take the planner role. It is not wired.
2. **Configuration and decision corrections, and the slice-7 target scenarios** (OneWorld, inactive account,
   combined source+target). B's correction registry declares these kinds, but no B scenario exercises them.
3. **OpenAPI contract pipeline and the slice-8 analysis tooling.** These are analysis tools around A, not runtime features.
4. **Production-mode staff.** Not run (no mail service).
