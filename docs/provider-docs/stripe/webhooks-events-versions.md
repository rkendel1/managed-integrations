# Stripe — webhooks, Events API, API versions (snapshot, 2026-11-24)

Summary of official Stripe documentation. Re-verify against the live pages before relying on it.

- Webhook signatures: https://docs.stripe.com/webhooks#verify-events — `Stripe-Signature: t=…,v1=…`;
  v1 = HMAC-SHA256 of `"<t>.<raw body>"` with the endpoint's signing secret; reject old timestamps (tolerance).
- Webhook bodies contain the event object with nested objects as ids (not expanded); integrations retrieve
  what they need, optionally with `expand[]`.
- Events API: https://docs.stripe.com/api/events/list — newest first, `created` filters, `types[]`,
  `starting_after` pagination. Stripe documents a **30-day** retention for events: recovery from the Events API
  is only possible within that window.
- Versioning: https://docs.stripe.com/upgrades — a request can set `Stripe-Version`; webhook endpoints have
  their own API version (events are rendered in the endpoint's version).
- 2025-03-31.basil (https://docs.stripe.com/changelog/basil/2025-03-31/add-support-for-multiple-partial-payments-on-invoices):
  `Invoice.charge`, `payment_intent`, `paid`, `paid_out_of_band` removed; payments are in `invoice.payments`.
  ledgerly's receiver already retrieves invoices at 2024-06-20 (`src/server/expand.ts`), so this change does
  NOT break the adopted integration; it is listed here because it was evaluated (see docs/adoption/SECOND-INTEGRATION.md).
