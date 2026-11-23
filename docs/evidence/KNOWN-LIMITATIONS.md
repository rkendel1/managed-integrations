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

## Risks

- Real NetSuite accounts commonly have mandatory custom fields/approval workflows: these surface as
  `records_rejected` (customer action) — handled, but likely frequent at onboarding.
- Shopify watermark sync can miss late-visible updates older than the 5-minute overlap; reconciliation
  is the backstop.
- Playbook coverage is narrow; most real failures will need the Claude planner or a human.
