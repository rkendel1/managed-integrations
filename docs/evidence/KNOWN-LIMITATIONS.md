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

## Slice 4 — customer product and maintenance lifecycle

See `docs/product/MAINTENANCE.md` §10. In short:

- Fixture-only, and the provider change is fictional.
- The input contract detects missing or ill-typed fields, not changes in meaning.
- The only automatic correction is "a documented field moved" (verified against stored payloads and
  Shopify's own records); everything else escalates, and there is no operator action yet to resume an
  escalated event.
- NetSuite-side changes for the adopted flow are not detected.
- There are no outbound customer notifications.
- "Verified" (7 days) and "Protected" (a consistent check within 24 h) are fixed product rules.
- The native flow's customer Settings page (SKU mappings) is still the slice-1 page and keeps some operational vocabulary (health badge, contract version, "synced through").
- Native incidents appear in the customer's maintenance history with the facts they have; they have no
  transaction accounting, so they never carry a zero-loss claim.

## Slice 5 — onboarding and adaptation

- Fixture-only. No live Shopify store or NetSuite account has been onboarded.
- NetSuite connection is machine-to-machine: the customer's admin must create an integration record and
  upload our certificate (4 of the 7 onboarding actions). A one-click NetSuite OAuth 2.0 authorization-code
  flow needs our app installed in their account (SuiteApp/integration record); not built.
- Discovery recognizes one adoptable implementation (shopify-erp-order-sync) by its NetSuite signature.
  Other integrations are detected as "another integration" but cannot be adopted.
- Shopify does not expose other apps' webhook subscriptions, so we cannot see or retire the customer's
  existing deployment. After takeover both may run; duplicates are prevented because both write the same
  NetSuite external id (upsert), but the customer should retire their deployment.
- The adopted code sends no subsidiary: NetSuite OneWorld accounts reject its orders (since slice 2). Demos
  and tests use a non-OneWorld fixture account.
- Orders from before the takeover that never reached NetSuite are reported, not recovered, without a
  customer decision; there is no customer UI action for that decision yet.
- Corrections: one adapter type (`field_moved`) and one reviewed patch (p0001). Adapters auto-activate only
  with a full validation; patches always need an operator. Arbitrary code changes cannot be proposed.
- The browser cannot complete the fixture's Shopify OAuth in Docker (in-network host); covered by API tests
  and `make demo-onboarding`.

## Slice 6 — portability and the second integration (Stripe → QuickBooks)

- **Fixture-only.** No live Stripe account or QuickBooks company was used. The fixtures model the documented
  behaviour (signatures, Events API, versioned rendering, Intuit OAuth rotation, requestid, minor versions).
- **ledgerly's inherited test suite was not run** (installing and executing a third-party repository's dev
  toolchain was refused by the environment's permission policy). Its 29 golden QuickBooks outputs are reproduced
  through our loader instead.
- **Not managed for Stripe → QuickBooks:** deferred revenue schedules (annual plans: refused), disputes, credit
  notes, invoice voids, cross-currency payouts (refused by upstream); recovery is bounded by Stripe's 30-day
  event retention; other integrations are recognised in QuickBooks only when they use the Stripe object id as DocNumber.
- **Discovery reads at most 100 recent events** and expands each through the Stripe API (cost grows with volume).
- **Reauthorization recovery exists for Stripe → QuickBooks only.** For Shopify → NetSuite, lost authorization is
  detected by monitoring and the customer is asked to reconnect, but releasing and verifying held orders afterwards
  is not implemented.
- **Shared table column names predate portability** (`reconciliation_items.source_order_id`, `order_name`,
  `webhook_receipts.shop_domain`): they hold a Stripe event id / label / `stripe` for the second integration.
- **Monitoring cadence state is in memory** in the worker (the facts are durable; only "when did we last probe"
  resets on restart, which causes one extra probe).
- **The browser cannot complete the fixture OAuth for QuickBooks** (as for Shopify); the API tests and
  `make demo-stripe` exercise those routes.

## Slice 7 — three-sided change resilience, provider-centric adoption

- **Fixture-only.** Every provider change (Stripe 2025-03-31.basil webhooks, QuickBooks inactive accounts and
  revoked authorization, NetSuite OneWorld) is reproduced in deterministic fixtures modelled on public
  documentation. None was run against a live account.
- **Two applications, one operation each where it matters.** The QuickBooks application is adopted for its
  `create_invoice` tool only (its ~30 other tools are not hosted). The Stripe application is hosted in full, but
  its writes are only invoked through `applications.invoke` (no hosted public URL for the customer's frontend).
- **Deployment bindings.** The Stripe application's Prisma client and environment loader are replaced by host
  bindings (sha-recorded; the upstream files stay pinned). The binding implements only the Prisma calls the
  application makes today; a future upstream change that needs more fails validation rather than silently
  degrading.
- **The Stripe application's own ordering bug is not corrected.** It stores the last event it receives per
  object; Stripe does not deliver in order. Provider verification detects a stale record; no correction exists.
- **Recovery through the application's processor.** The Stripe application dedupes processed events, so
  recovery calls its own `processStripeEvent` with the stored payload (not its webhook route).
- **QuickBooks invoice creation is not idempotent** in node-quickbooks (no `requestid`). A request whose outcome
  is unknown after sending is never re-sent automatically; only requests QuickBooks refused (401 /
  `invalid_grant`, nothing processed) are held and released.
- **No upstream watcher.** The QuickBooks application's upstream release is represented by a reviewed dependency
  change in the catalog (with its evidence); nothing polls GitHub or npm.
- **No discovery for the QuickBooks application** (an MCP server leaves no signature in QuickBooks); it is offered
  as a new managed instance.
- **Combined changes are coordinated within one integration only** (`blockingEvents`); two integrations that
  share a provider are maintained independently.
- **Target verification population** for NetSuite OneWorld is the orders the integration received in the
  period; missed webhooks in that period are found by the source event's reconciliation, not by the target
  event.
- **Not adopted:** `rkendel1/saaskit` (the account's own Stripe application) was found after selection; it is the
  natural next application on the same mechanisms.
