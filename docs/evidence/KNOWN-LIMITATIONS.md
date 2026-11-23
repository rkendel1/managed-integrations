# Known limitations, blockers and risks

## Blockers (external)

1. **No real provider access.** No Shopify app/dev store or NetSuite sandbox credentials were available.
   All provider behaviour was verified against deterministic fixtures modelled on official docs. Needed:
   a Shopify app (client id/secret, redirect URL) + development store, and a NetSuite sandbox with an
   OAuth 2.0 client-credentials integration record and a mapped certificate.
2. **Unverified provider details** listed in `docs/architecture/PROVIDER-RESEARCH.md` (search-syntax
   quoting, throttle response form, upsert Location header, JWT `aud`/algorithm, required salesOrder
   fields, SuiteQL columns and quantity sign, Retry-After on NetSuite 429).
3. **No Anthropic API key**: the Claude planner (`ClaudePlanner`) is implemented with the official SDK but
   has never been executed. The demonstrated repair uses the deterministic playbook.

## Simulated / fixture-only

- The demonstrated "upstream change" (`LineItem.originalUnitPriceSet` → `preDiscountUnitPriceSet`) is
  **fictional**, defined in `packages/test-fixtures` and `docs/provider-docs/shopify/FIXTURE-schema-changelog.md`.
- The Shopify OAuth consent screen is auto-approved by the fixture; demo seeding issues tokens directly.
- Reproduction profiles (`baseline`, `drift`) are pre-authored. In production the agent would need to
  derive a reproduction from sanitized observations; that capability is **not implemented** (the playbook
  only handles GraphQL field removals with a documented replacement).
- `--auto-approve` in the demo is a scripted stand-in for the operator click.
- Fixture state is in-memory: restarting the fixtures container invalidates the demo (`make reset`).

## Product scope limits (by design for contract 1.0.0)

Single configured NetSuite customer entity; no customer matching; edits after delivery are detected
(stale) but not propagated; discounts/shipping/tax not mapped; orders > 100 line items rejected;
single currency; one integration per tenant.

## Engineering limits

- Runtime images run TypeScript via `tsx` with dev dependencies installed (larger images, slower start).
- OpenAPI generation not implemented; OpenTelemetry export and Sentry not wired (log-based trace ids only).
- Sync processes records sequentially (NetSuite concurrency cap 2 exists in the client but the engine
  does not parallelise); throughput not measured beyond fixture scale (≈100 orders).
- Canary is per-integration (one integration per tenant); no cross-tenant staged rollout.
- Maintenance service needs the host Docker socket (root-equivalent) — run it on a separate host in
  production. Validation/sandbox runs take ~15 s per suite.
- Key rotation re-encryption, operator MFA, password reset, CSP header: not implemented.
- Human intervention hours, hosting cost and margin are not measured automatically.
- Interrupted-run detection waits for lease expiry (2 min) before resuming.
- Scheduled reconciliation window is the last 7 days; older history is reconciled only on demand.

## AppPort layer (SLICE 1)

1. **One capability only.** `integrations.list@1` is registered. Creating/configuring/enabling/syncing
   integrations, connections, credentials, incidents, maintenance and releases are still REST routes or
   worker jobs; they are **not** AppPort capabilities and MCP cannot reach them.
2. **Agents need a browser session cookie.** MCP resolves identity from `mi_session`. There is no OAuth
   resource-server flow, API key or service principal for MCP clients yet. A non-browser agent cannot
   authenticate without a session token minted for it. This is the main blocker to real agent use.
3. **No capability audit trail or telemetry sink.** Read invocations are not written to `audit_log`;
   AppPort's telemetry hooks are not wired to pino/OTel.
4. **MCP is stateless.** `createMcpHandler` builds a server per HTTP request and declines `GET`/`DELETE`.
   No resumable streams, server-initiated notifications, resources or prompts.
5. **Local HTTP adapter.** `apps/api/src/appport-routes.ts` converts Fastify requests to WHATWG
   `Request`/`Response` and re-serializes the parsed JSON body; the AppPort binding reads a text body.
   AppPort request bodies are capped at 256 KiB.
6. **No durable AppPort session store.** Identity is rebuilt from the application `sessions` table on
   every call; AppPort's in-memory `MemorySessionStore` is not used. Sign-out/expiry therefore applies
   immediately, but no AppPort session features exist.
7. **No pagination or filtering** beyond tenant: `integrations.list` returns every integration of the
   tenant (currently one per tenant by product scope).
8. **Tenant policy is code**, not a grants table; per-user permissions are not modelled.
9. **UI state tests use transport interception** for the empty and failure cases (only the
   `integrations.list` response is substituted; discovery/manifest are real). The success path is a real
   capability call against PostgreSQL.
10. **E2E suite is stateful.** The pre-existing unmapped-SKU browser test adds a SKU mapping and is only
    repeatable after `make reset`; the suite also assumes the first scheduled sync has run
    (`last-sync != never`). These are pre-existing properties, not introduced by this slice. The new
    `/app/integrations` tests do not depend on that state.

## Risks

- Real NetSuite accounts commonly have mandatory custom fields/approval workflows: these surface as
  `records_rejected` (customer action) — handled, but likely frequent at onboarding.
- Shopify watermark sync can miss late-visible updates older than the 5-minute overlap; reconciliation
  is the backstop.
- Playbook coverage is narrow; most real failures will need the Claude planner or a human.

## Slice 2 — adopted executor (shopify-erp-order-sync)

See `docs/adoption/ADOPTION.md` §I. In short: fixture-only verification; no subsidiary (OneWorld rejects);
`orders/create` only; missed webhooks undetected (addressed in slice 3); raw payloads (PII) retained encrypted without a retention job;
single app-level webhook secret; asynchronous invocation-evidence writes; upstream repository has a single commit
and author. The Docker build requires `git` and rewrites GitHub SSH URLs to HTTPS for the git-pinned dependency.

## Slice 3 — reconciliation and missing-delivery recovery

See `docs/adoption/RECONCILIATION.md` §6. In short: fixture-only (Shopify GraphQL search and fields as
documented, not checked against a real store); the recovery input is a documented reconstruction of the
fields upstream reads, not Shopify's webhook body; verification compares identity (externalId, order name),
not lines or amounts; orders with more than 100 lines are excluded; `ambiguous` /
`destination_exists_untracked` items have no resolution action; edits, cancellations after delivery and
refunds are not reconciled.
