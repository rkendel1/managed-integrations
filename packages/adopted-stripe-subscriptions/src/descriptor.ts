/**
 * The Stripe-dependent APPLICATION (not a pipeline): its maintenance contract. One provider, Stripe, in the
 * role `both` — the application writes to Stripe (Checkout Sessions, PaymentIntents) and is driven by Stripe's
 * events; its output is its own database. Every `implemented` entry is exercised by this package's tests.
 */
import type { IntegrationDescriptor, Responsibilities } from '@mi/managed';
import { STRIPE_APP_FLOW_TYPE } from './contract.ts';
import { STRIPE_SUBSCRIPTIONS_APP as U } from './provenance.ts';

export const STRIPE_SUBSCRIPTIONS: IntegrationDescriptor & { responsibilities: Responsibilities } = {
  flowType: STRIPE_APP_FLOW_TYPE,
  name: 'Subscriptions app (Stripe)',
  process: 'Your subscriptions service: it starts checkouts and payments in Stripe and keeps its own record of subscriptions, invoices and payments from Stripe’s events',
  shape: 'application',
  providers: [
    {
      id: 'stripe',
      name: 'Stripe',
      role: 'both',
      api: 'Stripe API (Checkout Sessions, PaymentIntents) and webhook events',
      version: `${U.stripeApiVersion} declared by the application’s client (src/stripe/stripe.ts); webhook bodies at the endpoint’s API version`,
      auth: 'secret/restricted key (Bearer) for writes; webhook signature HMAC-SHA256 (whsec), checked by the application',
      client: `stripe-node ${U.dependencies.stripe} (from the application’s lockfile), linked into the artifact`,
      operations: [
        { name: 'POST /v1/checkout/sessions', kind: 'write', effect: 'creates a Checkout Session (the application’s /v1/stripe/checkout-session route)' },
        { name: 'POST /v1/payment_intents', kind: 'write', effect: 'creates a PaymentIntent (the application’s /v1/stripe/payment-intent route)' },
        { name: 'customer.subscription.* / invoice.* / payment_intent.* events', kind: 'event', effect: 'the application records the object’s status, period end, links and amounts' },
        { name: 'retrieve subscription / invoice / payment intent; Events API', kind: 'read', effect: 'our verification and recovery (not the application)' },
      ],
      semantics: 'whether a customer’s subscription is active and until when; whether an invoice is paid; payment status and amounts',
      idempotency: 'one delivery per Stripe event id at our ingress; the application’s own StripeEvent table (processed/ignored events are not re-processed); stripe-node idempotency keys on writes',
      recovery: 'affected events re-run through the application’s own processor; events never received are recovered from the Events API (30 days) and run through its webhook route',
      verification: [
        'each record the application keeps equals what Stripe states (status, period end, subscription link, paid, amounts)',
        'every Stripe event of a period was received and processed by the application',
      ],
    },
  ],
  transactions: { one: 'Stripe event', many: 'Stripe events', record: 'record', businessData: 'statuses, period ends, links and amounts' },
  adopted: {
    repository: U.repository,
    commit: U.commit,
    license: U.license,
    package: U.packageName,
    attachment: 'vendored',
    entryPoints: U.entryPoints,
    notUsed: U.notUsed,
  },
  execution: {
    trigger: 'Stripe webhooks to our endpoint (verified, durably received), handed to the application’s own webhook route; the application’s routes for its writes',
    idempotency: 'one delivery per Stripe event id; the application’s own event table behind it',
  },
  dependencies: [
    { provider: 'stripe', contract: 'webhook event payload', version: 'the endpoint’s API version', usedFor: 'every field src/webhooks/stripeEventProcessor.ts reads' },
    { provider: 'stripe', contract: 'Checkout Sessions / PaymentIntents create', version: U.stripeApiVersion, usedFor: 'the application’s writes' },
  ],
  capabilities: {
    discovery: 'Your Stripe account’s webhook endpoints: an endpoint on the application’s route (/v1/stripe/webhook) subscribed to its events identifies your deployment and the API version its events use.',
    monitoring: [
      { signal: 'source_available', method: 'Stripe GET /v1/account with the customer’s key' },
      { signal: 'credentials', method: 'Stripe key accepted' },
      { signal: 'processing', method: 'events received but not yet run through the application' },
      { signal: 'rejected', method: 'events the application refuses (4xx)' },
      { signal: 'contract_change', method: 'shape of every event type the application reads (contract observations)' },
      { signal: 'destination_verification', method: 'each record read back against Stripe after processing' },
      { signal: 'commitment_boundary', method: 'escalated maintenance events and unsupported changes' },
    ],
    recovery: 'Affected events re-run through the application’s own processor on the corrected artifact; missing events recovered from the Stripe Events API.',
    verification: 'Every record the application keeps is compared with Stripe (live retrieve) using Stripe’s documented meaning of each field at every API version.',
    corrections: [
      { pattern: 'field_moved', status: 'implemented', note: 'reviewed patch p0001: Stripe 2025-03-31.basil field locations (operator activation)' },
      { pattern: 'api_version_pin', status: 'not_supported', note: 'the application pins its client version itself; a version upgrade is a reviewed code change' },
      { pattern: 'reauthorization', status: 'not_supported', note: 'a revoked key holds events (awaiting authorization); the customer replaces the key' },
      { pattern: 'business_meaning', status: 'not_supported', note: 'routed to a person (unsupported)' },
    ],
  },
  limitations: [
    'The application stores the latest event it receives for an object; Stripe does not deliver events in order. Our verification against Stripe detects a stale record; correcting the application’s ordering is not supported.',
    'Recovery from Stripe is bounded by Stripe’s 30-day event retention.',
    'We do not disable the endpoint of your previous deployment at Stripe; until you do, both receive events.',
    'Writes are verified by reading the created object back from Stripe; the application’s own HTTP clients (your frontend) are not under our management.',
  ],
  responsibilities: {
    version: 'a1',
    maintain: [
      'Run your subscriptions application for you: the same code, pinned to a known version, with its own database hosted by us.',
      'Receive Stripe’s events for it, hand each to the application exactly once, and check what it recorded against Stripe.',
      'Adapt the application when Stripe changes what it sends, verify the result and tell you what happened.',
    ],
    access: [
      'Stripe: create Checkout Sessions and PaymentIntents (what your application does), read subscriptions, invoices, payment intents and events, and register a webhook endpoint for our service.',
    ],
    verify: [
      'Every subscription, invoice and payment your application records says what Stripe says.',
      'No Stripe event of your application is missed.',
    ],
  },
};
