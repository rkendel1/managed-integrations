# Provider documentation snapshots

Read-only reference material available to the maintenance agent (`read_provider_docs` tool).

- `shopify/admin-graphql-orders.md`, `netsuite/rest-sales-orders.md` — summaries of **official**
  provider documentation (URLs inline), captured 2026-11-23. Re-verify against the live docs before relying on them.
- `shopify/FIXTURE-schema-changelog.md` — **fictional** schema change used by the deterministic
  test fixture to exercise detection → repair → release. It is **not** a statement about Shopify.

The agent has no general internet access in this slice; refreshing these snapshots from official
sources is an operator task (see docs/operations/RUNBOOK.md).

Slice 6 (Stripe → QuickBooks):

- `stripe/webhooks-events-versions.md`, `quickbooks/oauth-and-journal-entries.md`, `quickbooks/minor-versions.md` —
  summaries of **official** Stripe and Intuit documentation (URLs inline), captured 2026-11-24.
