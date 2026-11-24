/**
 * Provenance of the Stripe-dependent application (slice 7): stripe-webhooks-subscriptions-node-ts, an
 * Express + TypeScript service that creates Checkout Sessions and PaymentIntents in Stripe and keeps its own
 * record of subscriptions, invoices and payment intents from Stripe webhooks (signature-verified, deduplicated
 * by event id, 500 on failure so Stripe retries).
 *
 * It is NOT a pipeline: Stripe is its only provider (role: both — it writes to Stripe and is driven by
 * Stripe's events); its output is its own database. Selection evidence: docs/adoption/PROVIDER-APPLICATIONS.md.
 *
 * Attachment: VENDORED. The executed files are copied byte-for-byte from the pinned commit into
 * upstream/stripe-webhooks-subscriptions-node-ts (MIT licence included) and sha256-pinned below; the test
 * suite checks every pin. Its dependencies are installed at the versions of its own package-lock.json.
 */
export const STRIPE_SUBSCRIPTIONS_APP = {
  packageName: 'stripe-webhooks-subscriptions-node-ts',
  version: '1.0.0',
  repository: 'https://github.com/abdelrahmansapryalwtany/stripe-webhooks-subscriptions-node-ts',
  commit: '4812d259e7e8e1e57785f2e09be448e5e3ad92b1',
  license: 'MIT',
  attachment: 'vendored' as const,
  entryPoints: [
    'src/app.ts#buildApp (the application itself: health, webhook and Stripe routes)',
    'src/webhooks/stripeWebhook.ts#stripeWebhookHandler (POST /v1/stripe/webhook: verify, dedupe, process)',
    'src/webhooks/stripeEventProcessor.ts#processStripeEvent (event → its Subscription / Invoice / PaymentIntent record)',
    'src/routes/stripe.ts (POST /v1/stripe/checkout-session and /v1/stripe/payment-intent: writes to Stripe)',
    'src/stripe/stripe.ts (the Stripe client, API version pinned to 2025-02-24.acacia)',
  ],
  notUsed: [
    'src/server.ts: the host listens instead (one instance per managed customer, on a local port)',
    'prisma migrations / @prisma/client: the application database is hosted (deployment binding, below)',
    'dotenv: the host provides the environment (deployment binding, below)',
  ],
  /** sha256 of every upstream file the host executes or binds, from the pinned commit (git archive). */
  fileSha256: {
    'src/app.ts': '2ce4b4fdcaecea495a2a971ed878e6e096923b8d3736c558b646377ea51c5634',
    'src/config/env.ts': 'f35c368efe1b32c3dce9aa65af21f6ef849abed441a7132c5cb8ed840e748e5f',
    'src/db/prisma.ts': '274662bd74d96b6b02e506f516e8917288ba021bb37217874a80bbb1753e7bde',
    'src/routes/stripe.ts': 'dd422ff313e9f81dce4593dcd07b41673b7130e59468e6630b73264ffb6d5c8b',
    'src/stripe/stripe.ts': '3175426c8bfc1ed03cbf3c8d7ad824cb8b585623cb608ad319a5318a5a93b8da',
    'src/webhooks/stripeEventProcessor.ts': '9cee1bbcca7a1de14c5d4917683beffe8be3c015e513ec4961581620de03c759',
    'src/webhooks/stripeWebhook.ts': 'af64e7fa4f92cc8006d2d5caeb3cc94e3de5f2d116f4dba3f3184d3786cdf9e3',
  } as Record<string, string>,
  /** Resolved versions from the pinned package-lock.json (installed exactly by this package). */
  dependencies: { express: '4.22.1', stripe: '17.7.0', zod: '3.25.76' },
  /** The Stripe API version the code declares (src/stripe/stripe.ts). */
  stripeApiVersion: '2025-02-24.acacia',
};
