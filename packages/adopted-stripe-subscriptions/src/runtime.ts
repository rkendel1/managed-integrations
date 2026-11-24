/** The Stripe-dependent application's runtime on the shared registry, queues and lifecycles. */
import { and, eq, lt } from 'drizzle-orm';
import { deliveries, integrations, type Db } from '@mi/database';
import type { CredentialCipher, ProviderEndpointConfig } from '@mi/integration-shopify-netsuite';
import {
  adaptationsOf,
  nextAutomaticRetryDelaySeconds,
  pinnedDrift,
  requestDeliveryRetry,
  type IntegrationRuntime,
  type Probe,
  type WorkServices,
} from '@mi/managed';
import { describeError } from '@mi/observability';
import { stripeFor } from '@mi/provider-connections';
import {
  activateAppAdaptation,
  proposeAppPatch,
  rejectAppAdaptation,
  rollbackAppAdaptation,
  validateAppAdaptation,
} from './adaptation.ts';
import { patchCatalog, pinnedSource } from './artifact.ts';
import { STRIPE_APP_FLOW_TYPE } from './contract.ts';
import { STRIPE_SUBSCRIPTIONS } from './descriptor.ts';
import { executeAppDelivery } from './execute.ts';
import { instanceFor } from './host.ts';
import { receiveAppWebhook } from './ingest.ts';
import { advanceAppMaintenance, recordProviderChange } from './maintenance.ts';
import { stripeAppOnboarding } from './onboarding.ts';
import { STRIPE_SUBSCRIPTIONS_APP } from './provenance.ts';
import { invokeAppOperation } from './writes.ts';

export interface StripeAppRuntimeDeps {
  db: Db;
  cipher: CredentialCipher;
  endpoints: ProviderEndpointConfig;
  services: WorkServices;
  webhookBaseUrl: string;
}

export function createStripeSubscriptionsRuntime(deps: StripeAppRuntimeDeps): IntegrationRuntime {
  const { db, cipher, endpoints, services } = deps;
  const host = { db, cipher, endpoints };
  return {
    descriptor: STRIPE_SUBSCRIPTIONS,
    onboarding: stripeAppOnboarding({ cipher, endpoints, webhookBaseUrl: deps.webhookBaseUrl }),
    receive: (p) =>
      receiveAppWebhook({ db, cipher, integrationId: p.integrationId, rawBody: p.rawBody, signature: p.headers['stripe-signature'], ...(p.correlationId ? { correlationId: p.correlationId } : {}) }),
    async execute(deliveryId, trigger) {
      const r = await executeAppDelivery({ ...host, deliveryId, trigger });
      if (!r.executed) return r;
      if (r.outcome === 'failed' && r.errorClass === 'verification') {
        const inc = await recordProviderChange(db, deliveryId, r.mismatches ?? []);
        await services.enqueueMaintenance(inc.id);
      } else if (r.outcome === 'failed') {
        const delay = nextAutomaticRetryDelaySeconds(r.attemptNo ?? 1);
        if (delay != null && (await requestDeliveryRetry(db, deliveryId)).accepted)
          await services.enqueueExecution(deliveryId, { kind: 'automatic_retry' }, delay);
      }
      return r;
    },
    invoke: (p) => invokeAppOperation(host, p),
    maintain: (incidentId) => advanceAppMaintenance({ ...host, services }, incidentId),
    adaptations: {
      propose: (p) => proposeAppPatch(db, p),
      validate: (id) => validateAppAdaptation(db, cipher, id),
      activate: async (id, actor, note, opts) => {
        const row = await activateAppAdaptation(db, id, actor, note, opts);
        if (row.maintenanceEventId) await services.enqueueMaintenance(row.maintenanceEventId);
        return row;
      },
      rollback: (id, actor, reason) => rollbackAppAdaptation(db, id, actor, reason),
      reject: (id, actor, reason) => rejectAppAdaptation(db, id, actor, reason),
    },
    async inspect(integrationId) {
      const src = pinnedSource();
      const drift = pinnedDrift(src);
      let running = null;
      let problem: string | null = null;
      try {
        const inst = await instanceFor(host, integrationId);
        running = { id: inst.artifact.id, patches: inst.artifact.patches, files: inst.artifact.files };
      } catch (err) {
        problem = describeError(err).message;
      }
      return {
        adopted: { repository: STRIPE_SUBSCRIPTIONS_APP.repository, commit: STRIPE_SUBSCRIPTIONS_APP.commit, license: STRIPE_SUBSCRIPTIONS_APP.license, package: STRIPE_SUBSCRIPTIONS_APP.packageName },
        pinnedFiles: Object.entries(src.fileSha256).map(([file, expected]) => {
          const d = drift.find((x) => x.file === file);
          return { file, expected, actual: d?.actual ?? expected, matches: !d };
        }),
        running,
        problem,
        contracts: [],
        adaptations: await adaptationsOf(db, integrationId),
        catalog: patchCatalog().map((p) => ({ id: p.id, title: p.title, file: p.file })),
      };
    },
    async probe(integ): Promise<Probe> {
      const probe: Probe = { source: { available: false, detail: '' }, destination: { available: false, detail: '' }, credentials: [], recentSourceActivity: null };
      try {
        const stripe = await stripeFor(db, cipher, endpoints, integ.tenantId);
        await stripe.sdk.accounts.retrieve();
        probe.source = { available: true, detail: 'Stripe answered' };
        const inst = await instanceFor(host, integ.id);
        probe.destination = { available: true, detail: `application ${inst.artifact.id} running` };
        probe.credentials.push({ provider: 'stripe', state: 'valid', detail: 'key accepted' });
      } catch (err) {
        const msg = describeError(err).message;
        probe.source = { available: false, detail: msg };
        probe.credentials.push({ provider: 'stripe', state: /revoked|expired|Invalid API Key/i.test(msg) ? 'revoked' : 'unknown', detail: msg });
      }
      return probe;
    },
    async sweep() {
      const orphaned = await db
        .select({ id: deliveries.id })
        .from(deliveries)
        .innerJoin(integrations, eq(integrations.id, deliveries.integrationId))
        .where(and(eq(integrations.flowType, STRIPE_APP_FLOW_TYPE), eq(deliveries.outcome, 'pending'), lt(deliveries.updatedAt, new Date(Date.now() - 2 * 60_000))));
      for (const o of orphaned) await services.enqueueExecution(o.id, { kind: 'automatic_retry' });
    },
  };
}
