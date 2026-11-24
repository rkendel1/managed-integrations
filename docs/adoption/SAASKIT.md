# SaaSKit adoption — step 1: source-level inspection (before adoption)

Repository `https://github.com/rkendel1/saaskit`, inspected at `8ead17dbd97634299bd90b9b169c25e2d5472d96`
(2026-11-17). Cloned read-only into a scratch directory; nothing was pushed or changed in the original repository.

## Baseline evidence (actual execution)

`npm ci --ignore-scripts` (lockfile: `@feltdb/feltkit` 0.3.30), then SaaSKit's own suite `npx feltkit test`:
**33 tests, 33 passed, 0 failed** (≈33 s). Payment-relevant tests among them: forged webhooks refused,
redelivered event applied once, out-of-order delivery reaches the same state, a payment that does not match its
invoice grants nothing and is flagged, a declined card changes nothing, off-session upgrade charge with
event-settled refunds, reconciliation applies a payment the event stream missed, smoke checkout → Pro.

## The real Stripe boundary

- **Provider-neutral contract** `components/stripe/provider.ts`: `PaymentProvider` (`ensureCustomer`,
  `createCheckout`, `charge` off-session, `refund`, `paymentMethod`, `paymentStatus`) and `NormalizedEvent`
  (`checkout.completed`, `payment.succeeded|failed`, `refund.succeeded|failed`, `payment_method.updated`,
  `ignored`). Nothing Stripe-specific crosses into the engine (`feltkit/`).
- **Stripe client** `components/stripe/stripe.ts`: form-encoded HTTP, `Stripe-Version: 2024-06-20`,
  `Idempotency-Key` on every write (`customer:<account>`, `checkout:<checkoutId>`,
  `charge:<invoiceId>:<attempt>`, `refund:<refundId>`), 402 → declined, 5xx/429/409 → retryable;
  `verifyStripeSignature` (t/v1, several v1 during rotation, 300 s tolerance); `normalizeStripeEvent` maps
  `checkout.session.completed`, `payment_intent.succeeded|payment_failed`, `refund.created|updated`,
  `setup_intent.succeeded`, `payment_method.attached`; metadata carries `accountId`, `invoiceId`, `checkoutId`,
  `refundId`.
- **Payments component** `components/payments.ts` (the only code that talks to the provider): inbound
  `POST /stripe/webhook` → verify → normalize → `payments:ingest`; outbound durable work
  (`checkout.create`, `invoice.charge`, `refund.create`, `payment.reconcile`) claimed with leases, retried when
  retryable, reported through `payments:workResult`; a lifecycle clock (renewals, trials, grace, dunning).
  Provider selection: `sk_test_` key → Stripe (or `STRIPE_API_BASE`), live keys refused unless allowed, no key
  outside production → the bundled simulator.
- **Simulator** `components/stripe/simulator.ts`: the subset of Stripe the client uses (customers, checkout
  sessions + hosted page, payment intents with test cards, refunds, payment methods), Stripe-shaped errors,
  idempotency, events signed exactly as Stripe signs them, optional reverse-order delivery.

## Engine invariants (implemented, `feltkit/payments.ts`)

- Every provider event recorded once, unique on `(provider, eventId)`, in the same transaction as its effects.
- A payment applies only to an **open** invoice, only when **amount and currency equal the invoice**; otherwise
  an anomaly is audited and nothing is granted. A second payment for a paid invoice is flagged (refund needed).
- Checkout completion grants nothing by itself; the payment event does.
- Refunds settle only by event, only for refunds initiated here, once.
- Reconciliation (`payment.reconcile` → `payment.observed`) applies a succeeded provider payment only to an
  open invoice with the same amount.

## Transaction types for Managed Integrations

checkout (payment / setup), off-session charge of an invoice, refund, payment-method update, reconciliation
read. Identity: invoice id (engine), payment intent id (Stripe), event id (Stripe), idempotency key (per attempt).

## What adoption must still decide (not yet built)

- **Hosting:** SaaSKit runs on FeltKit (FeltDB, ComponentHost). Adopt by running its own runtime — its
  `feltkit/` engine and `components/payments.ts` through FeltKit's public `ComponentHost` — per customer, with
  `STRIPE_API_BASE` pointing at the provider under test.
- **Application-side change (candidate, from the real code):** a change to `normalizeStripeEvent` or the
  charge idempotency key that the engine either refuses (amount/currency mismatch → invoice stays open, paid at
  Stripe) or that would duplicate charges. Detection: Stripe says succeeded, SaaSKit's invoice is open
  (provider verification), plus the artifact diff.
- **Stripe-side change:** must come from documented Stripe behaviour that touches this client (API version
  `2024-06-20`, the events it normalizes, off-session confirmation). Candidates are recorded only after they are
  checked against Stripe's changelog; none is asserted here.
