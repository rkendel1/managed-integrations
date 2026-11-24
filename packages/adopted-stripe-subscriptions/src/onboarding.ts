/**
 * Onboarding the Stripe-dependent application on the shared onboarding engine. Discovery reads the customer's
 * Stripe webhook endpoints: an endpoint on the application's own route (/v1/stripe/webhook) subscribed to its
 * events is its existing deployment, and its API version is the payload contract the application runs with.
 * Activation: our endpoint at that same version; the last 30 days of events replayed through the pinned
 * application (building its hosted database); every resulting record verified against Stripe.
 */
import { eq } from 'drizzle-orm';
import { deliveries, integrationContracts, integrations, providers, type Db } from '@mi/database';
import type { CredentialCipher, ProviderEndpointConfig } from '@mi/integration-shopify-netsuite';
import { contractSha256 } from '@mi/integration-shopify-netsuite';
import type { IntegrationContractDefinition } from '@mi/contracts';
import { discoveryOutcome, type ActivationStep, type Discovery, type OnboardingImplementation } from '@mi/managed';
import { describeError } from '@mi/observability';
import { stripeFor } from '@mi/provider-connections';
import { APP_EVENT_TYPES, appWebhookSecretAad, STRIPE_APP_CONTRACT_VERSION, STRIPE_APP_FLOW_TYPE, StripeAppConfigSchema } from './contract.ts';
import { STRIPE_SUBSCRIPTIONS } from './descriptor.ts';
import { executeAppDelivery, type StripeEventPayload } from './execute.ts';
import { recordAppEvent } from './ingest.ts';
import { STRIPE_SUBSCRIPTIONS_APP } from './provenance.ts';

export interface AppOnboardingDeps {
  cipher: CredentialCipher;
  endpoints: ProviderEndpointConfig;
  webhookBaseUrl: string;
}
/**
 * The registered contract (shared IntegrationContractDefinition). For an application its "scope" is the
 * provider connection and the application's own records — not a second provider.
 */
export const APP_CONTRACT: IntegrationContractDefinition = {
  version: STRIPE_APP_CONTRACT_VERSION,
  flowType: STRIPE_APP_FLOW_TYPE as IntegrationContractDefinition['flowType'],
  scope: {
    source: 'Stripe (events for the application; its writes: Checkout Sessions, PaymentIntents)',
    destination: 'the application’s own database (hosted per customer)',
    objects: ['Subscription', 'Invoice', 'PaymentIntent', 'StripeEvent (the application’s idempotency record)'],
    fields: [
      { source: 'subscription status / current period end / cancel_at_period_end', destination: 'Subscription', rule: 'as Stripe states, at every API version' },
      { source: 'invoice status / subscription / paid / amount_due', destination: 'Invoice', rule: 'as Stripe states, at every API version' },
      { source: 'payment intent status / amount / currency', destination: 'PaymentIntent', rule: 'as Stripe states' },
    ],
    excluded: ['Event ordering: the application stores the last event it receives (detected by verification, not corrected)'],
  },
  direction: {
    source: 'Stripe',
    destination: 'the application',
    permittedWrites: ['Stripe: create Checkout Sessions and PaymentIntents (the application’s own routes)', 'the application’s own database'],
    neverWrites: ['Stripe objects other than those the application creates', 'the customer’s previous deployment'],
  },
  freshness: { syncIntervalMinutes: 0, maxAcceptableDelayMinutes: 0 },
  completeness: ['Every signed Stripe event is recorded durably before it is acknowledged; the Stripe Events API (30 days) finds events never received.'],
  correctness: ['Every record the application keeps is compared with Stripe after processing and when verifying a correction.'],
  idempotency: ['One delivery per Stripe event id; the application’s own event table behind it; writes keyed by the caller’s request id.'],
  recovery: ['Affected events re-run through the application’s own processor; missing events recovered from the Events API.'],
  compatibility: [`Pinned to ${STRIPE_SUBSCRIPTIONS_APP.commit.slice(0, 12)} with stripe-node ${STRIPE_SUBSCRIPTIONS_APP.dependencies.stripe} (API ${STRIPE_SUBSCRIPTIONS_APP.stripeApiVersion}).`],
  responsibility: {
    weOwn: ['Hosting the application and its database, receipt, verification, corrections and evidence'],
    customerOwns: ['Their Stripe account and products', 'Their previous deployment until they retire it'],
  },
  limitations: ['Fixture-verified only: not run against a live Stripe account.'],
};

async function ensureContract(db: Db) {
  await db.insert(providers).values({ id: 'stripe', displayName: 'Stripe', apiVersion: '2024-06-20', capabilities: ['events.list (Events API)', 'webhook_endpoints.create'], documentation: ['https://docs.stripe.com/api'] }).onConflictDoNothing();
  await db.insert(integrationContracts).values({ version: APP_CONTRACT.version, flowType: STRIPE_APP_FLOW_TYPE, definition: APP_CONTRACT, definitionSha256: contractSha256(APP_CONTRACT) }).onConflictDoNothing();
}

export function stripeAppOnboarding(deps: AppOnboardingDeps): OnboardingImplementation {
  return {
    descriptor: STRIPE_SUBSCRIPTIONS,
    async discover(db: Db, tenantId: string, opts: { now?: Date }): Promise<Discovery> {
      const now = opts.now ?? new Date();
      const stripe = await stripeFor(db, deps.cipher, deps.endpoints, tenantId);
      const eps = (await stripe.sdk.webhookEndpoints.list({ limit: 100 })).data;
      const mine = deps.webhookBaseUrl.replace(/\/$/, '');
      const candidates = eps
        .filter((e) => !e.url.startsWith(mine) && new URL(e.url).pathname.endsWith('/v1/stripe/webhook'))
        .map((e) => {
          const events = e.enabled_events as string[];
          const covered = events.filter((t) => (APP_EVENT_TYPES as readonly string[]).includes(t));
          return {
            id: `stripe-app:${e.id}`,
            kind: 'adoptable' as const,
            title: 'Your subscriptions application',
            summary: `A Stripe webhook endpoint on the application’s route (${new URL(e.url).pathname}) at API version ${e.api_version ?? 'account default'}, subscribed to ${covered.length} of the application’s events.`,
            implementation: STRIPE_SUBSCRIPTIONS_APP.packageName,
            confidence: covered.length >= 3 ? ('established' as const) : ('partial' as const),
            evidence: { endpoint: { id: e.id, url: e.url, apiVersion: e.api_version ?? null, events } },
          };
        });
      return {
        at: now.toISOString(),
        outcome: discoveryOutcome(candidates),
        window: { from: now.toISOString(), to: now.toISOString() },
        sampled: eps.length,
        candidates,
      };
    },
    ensureContract,
    integrationValues: (c) => {
      const ep = c.evidence['endpoint'] as { id: string; url: string; apiVersion: string | null } | undefined;
      return {
        displayName: STRIPE_SUBSCRIPTIONS.name,
        contractVersion: STRIPE_APP_CONTRACT_VERSION,
        config: { webhook: null, previousEndpoint: ep ? { id: ep.id, url: ep.url, apiVersion: ep.apiVersion ?? STRIPE_SUBSCRIPTIONS_APP.stripeApiVersion } : null },
      };
    },
    steps: steps(deps),
    async baselineResult(_db, records) {
      return { eventsReplayed: records['history']?.['replayed'] ?? 0, recordsVerified: records['verify']?.['verified'] ?? 0 };
    },
  };
}

function steps(deps: AppOnboardingDeps): ActivationStep[] {
  return [
    {
      key: 'webhook',
      label: 'Stripe’s events for your application come to us',
      async run(ctx) {
        const [integ] = await ctx.db.select().from(integrations).where(eq(integrations.id, ctx.integrationId));
        const config = StripeAppConfigSchema.parse(integ!.config);
        if (config.webhook) return { state: 'done', detail: 'already registered', record: { endpointId: config.webhook.endpointId } };
        const stripe = await stripeFor(ctx.db, deps.cipher, deps.endpoints, ctx.tenantId);
        const url = `${deps.webhookBaseUrl.replace(/\/$/, '')}/webhooks/stripe/${ctx.integrationId}`;
        // The same API version as the deployment we found: the payload contract the application runs with.
        const apiVersion = config.previousEndpoint?.apiVersion ?? STRIPE_SUBSCRIPTIONS_APP.stripeApiVersion;
        try {
          const ep = await stripe.sdk.webhookEndpoints.create({ url, enabled_events: [...APP_EVENT_TYPES] as never, api_version: apiVersion as never, description: 'Managed Integrations (subscriptions application)' });
          const webhook = { endpointId: ep.id, url, apiVersion: ep.api_version ?? apiVersion, secretCiphertext: deps.cipher.encrypt(ep.secret!, appWebhookSecretAad(ctx.integrationId)) };
          await ctx.db.update(integrations).set({ config: { ...config, webhook }, updatedAt: new Date() }).where(eq(integrations.id, ctx.integrationId));
          return { state: 'done', detail: 'webhook endpoint registered', record: { endpointId: ep.id, apiVersion: webhook.apiVersion } };
        } catch (err) {
          return { state: 'blocked', detail: 'webhook endpoint refused', problem: `Stripe did not accept our notification endpoint: ${describeError(err).message}` };
        }
      },
    },
    {
      key: 'history',
      label: 'Your application’s records are rebuilt from the last 30 days of Stripe events',
      async run(ctx) {
        const [integ] = await ctx.db.select().from(integrations).where(eq(integrations.id, ctx.integrationId));
        const stripe = await stripeFor(ctx.db, deps.cipher, deps.endpoints, ctx.tenantId);
        const since = Math.floor(Date.now() / 1000) - 30 * 86400;
        const all: StripeEventPayload[] = [];
        let after: string | undefined;
        for (;;) {
          const page = await stripe.sdk.events.list({ created: { gte: since }, types: [...APP_EVENT_TYPES], limit: 100, ...(after ? { starting_after: after } : {}) });
          all.push(...(page.data as unknown as StripeEventPayload[]));
          if (!page.has_more) break;
          after = page.data.at(-1)!.id;
        }
        let replayed = 0;
        for (const e of all.reverse()) {
          const r = await recordAppEvent(ctx.db, deps.cipher, integ!, e, Buffer.from(JSON.stringify(e)), 'reconciliation');
          if (r.deliveryId && r.execute) {
            await executeAppDelivery({ db: ctx.db, cipher: deps.cipher, endpoints: deps.endpoints, deliveryId: r.deliveryId, trigger: { kind: 'reconciliation_recovery', reason: 'onboarding history' } });
            replayed++;
          }
        }
        return { state: 'done', detail: `${replayed} events replayed`, record: { replayed, listed: all.length } };
      },
    },
    {
      key: 'verify',
      label: 'Every record is checked against Stripe',
      async run(ctx) {
        const rows = await ctx.db.select().from(deliveries).where(eq(deliveries.integrationId, ctx.integrationId));
        const bad = rows.filter((r) => r.outcome !== 'delivered');
        if (bad.length) return { state: 'blocked', detail: `${bad.length} not verified`, problem: `${bad.length} of your application’s records do not match Stripe yet. We are looking into it.` };
        return { state: 'done', detail: `${rows.length} verified`, record: { verified: rows.length } };
      },
    },
  ];
}
