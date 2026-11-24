# Provider-dependent applications (slice 7)

Slice 7's scope correction: prove adoption and maintenance of **applications that depend on one provider**,
not only source → target pipelines, without wrapping the Stripe → QuickBooks pipeline. Two real, open-source
applications were selected, vendored at a pinned commit and run unmodified.

## Search and selection

GitHub search (`search/repositories`, MIT/Apache, TypeScript/JavaScript), then clones read locally. Their own
test toolchains were **not** run (not permitted in this environment); behaviour was established by running the
pinned code against the fixtures.

| Candidate                                              | Verdict                                                                                                                                  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| abdelrahmansapryalwtany/stripe-webhooks-subscriptions-node-ts (MIT) | **Selected (Stripe).** A complete service: Checkout/PaymentIntent writes, signed webhooks, its own idempotency table, its own records. Pins Stripe API `2025-02-24.acacia` and reads exactly the fields Stripe moved/removed in `2025-03-31.basil`. |
| coderinho2/stripe-entitlements (MIT)                   | A pure library (events → access); no provider calls of its own. Good engineering, but not an application with a provider connection.     |
| laf-rge/quickbooks-mcp (MIT)                           | **Selected (QuickBooks).** An MCP server with ~30 QuickBooks tools; active upstream (54 commits; v0.11.0 → v0.12.0 during 2026). Tool handlers take the QuickBooks client as an argument, so the host can own authorization. |
| intuit/intuit-developer-nodejs (MIT)                   | Official sample: OAuth + one call. Too thin to maintain.                                                                                |
| bitsandbots/espocrm-quickbooks (MIT)                   | PHP module inside a CRM; not separable.                                                                                                  |

Not used: `rkendel1/saaskit` (the account's own Stripe application, named in `docs/product/Support.md`) — found
after the selection; it is the natural next application to adopt on the same mechanisms.

## Stripe-dependent application

- Repository `https://github.com/abdelrahmansapryalwtany/stripe-webhooks-subscriptions-node-ts`, commit
  `4812d259e7e8e1e57785f2e09be448e5e3ad92b1`, MIT (licence vendored).
- Vendored: `packages/adopted-stripe-subscriptions/upstream/…` (src, package.json, tsconfig, prisma schema,
  README, LICENSE) via `git archive` of the pinned commit; 7 executed files sha-pinned
  (`src/provenance.ts`).
- Runs as itself: `buildApp()` (Express), its webhook handler (stripe-node `constructEvent` signature check,
  `StripeEvent` dedupe, 500 → retry), `processStripeEvent`, its `/v1/stripe/checkout-session` and
  `/payment-intent` routes; its Stripe client at its pinned version. One instance per customer.
- Deployment bindings (sha-recorded; upstream files still pinned): `src/db/prisma.ts` → a delegate over
  `app_records` implementing exactly the Prisma calls the application makes; `src/config/env.ts` → the host's
  environment (key and webhook secret from the customer's encrypted connection). Not used: `src/server.ts`,
  Prisma migrations, dotenv.
- Dependency set from its lockfile: stripe 17.7.0, express 4.22.1, zod 3.25.76 (linked into the artifact).
- Discovery: the customer's Stripe webhook endpoints; one on the application's route (`/v1/stripe/webhook`)
  identifies the deployment and the payload version it runs with.

## QuickBooks-dependent application

- Repository `https://github.com/laf-rge/quickbooks-mcp`, commit `ce1317e51d43fb669d73f6f874935fb7827e5ebd`
  (v0.11.0), MIT.
- Adopted: the `create_invoice` tool (`src/tools/handlers/invoice.ts`) and its full import graph — 27 files,
  vendored and sha-pinned. The MCP transport and the credential storage modules are not used (the credential
  modules are imported by the graph but never called: the host builds the client).
- Dependency set from its lockfile: node-quickbooks 2.0.48 (axios; default minor version 75), intuit-oauth
  4.2.2, @aws-sdk/client-secrets-manager and client-ssm 3.1004.0, tmp 0.2.5. Alternative installed for the
  reviewed change: node-quickbooks 2.0.50.
- Real upstream facts used: v0.12.0 (`611ca6d`, 2026-10-19) changes none of the 27 executed files and moves
  node-quickbooks 2.0.48 → 2.0.50; the two node-quickbooks tarballs have an identical `index.js` (2.0.50 adds
  `index.d.ts`), so the only runtime difference is the User-Agent. node-quickbooks 2.0.46 had raised its default
  minor version 65 → 75 and 2.0.48 replaced `request` with axios (history, not exercised).
- Discovery: none possible (the application leaves no signature in QuickBooks); the candidate is stated as a new
  managed instance.
