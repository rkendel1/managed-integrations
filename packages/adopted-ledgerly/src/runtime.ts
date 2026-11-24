/**
 * Stripe → QuickBooks (adopted ledgerly) as an IntegrationRuntime (slice 6). The shared queues, worker tick,
 * onboarding engine, monitoring and operator tooling reach it only through these hooks; nothing in the API,
 * worker or customer product is specific to it.
 */
import { and, eq, gt, inArray, lt, ne } from 'drizzle-orm';
import { adaptations, deliveries, incidents, integrations, reconciliationRuns, type Db } from '@mi/database';
import type { CredentialCipher, ProviderEndpointConfig } from '@mi/integration-shopify-netsuite';
import {
  AdaptationError,
  nextAutomaticRetryDelaySeconds,
  requestDeliveryRetry,
  type CredentialState,
  type IntegrationRuntime,
  type Probe,
  type WorkServices,
} from '@mi/managed';
import { describeError } from '@mi/observability';
import {
  activateLedgerlyAdaptation,
  ledgerlyRunningCode,
  proposePatch,
  rejectLedgerlyAdaptation,
  rollbackLedgerlyAdaptation,
  validateLedgerlyAdaptation,
} from './adaptation.ts';
import { patchCatalog } from './artifact.ts';
import { LEDGERLY_FLOW_TYPE, MANAGED_EVENT_TYPES } from './contract.ts';
import { STRIPE_QUICKBOOKS } from './descriptor.ts';
import { executeLedgerlyDelivery } from './execute.ts';
import {
  advanceLedgerlyMaintenance,
  checkDependencyContract,
  openLedgerlyEvents,
  recordAuthorizationLost,
  recordInputContractBreak,
} from './maintenance.ts';
import { ledgerlyOnboarding } from './onboarding.ts';
import { AuthorizationLost, loadConnection, QuickBooksAccess, stripeFor } from './providers.ts';
import {
  recoverLedgerlyItem,
  scanLedgerlyReconciliation,
  startLedgerlyReconciliation,
  requestLedgerlyRecovery,
} from './reconcile.ts';

export interface LedgerlyRuntimeDeps {
  db: Db;
  cipher: CredentialCipher;
  endpoints: ProviderEndpointConfig;
  services: WorkServices;
  webhookBaseUrl: string;
  workerId: string;
  reconcileIntervalMinutes: number;
}

export function createStripeQuickbooksRuntime(deps: LedgerlyRuntimeDeps): IntegrationRuntime {
  const { db, cipher, endpoints, services } = deps;
  const maintainDeps = { db, cipher, endpoints, services };
  return {
    descriptor: STRIPE_QUICKBOOKS,
    onboarding: ledgerlyOnboarding({
      cipher,
      endpoints,
      webhookBaseUrl: deps.webhookBaseUrl,
      enqueueReconciliation: services.enqueueReconciliation,
    }),

    async execute(deliveryId, trigger) {
      const r = await executeLedgerlyDelivery({ db, cipher, endpoints, deliveryId, trigger });
      if (!r.executed) return r;
      const [d] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
      if (r.outcome === 'awaiting_authorization') {
        const inc = await recordAuthorizationLost(
          db,
          d!.integrationId,
          r.lost ?? 'quickbooks',
          r.message ?? 'authorization lost',
        );
        await services.enqueueMaintenance(inc.id);
      }
      if (r.outcome === 'held' && r.missingField) {
        const inc = await recordInputContractBreak(db, deliveryId, r.missingField);
        await services.enqueueMaintenance(inc.id);
      }
      if (r.outcome === 'delivered') {
        // A correction waiting for work to run on it can now be verified.
        const waiting = await db
          .select({ id: incidents.id })
          .from(incidents)
          .where(
            and(
              eq(incidents.integrationId, d!.integrationId),
              eq(incidents.kind, 'dependency_contract_change'),
              ne(incidents.status, 'resolved'),
            ),
          );
        for (const w of waiting) await services.enqueueMaintenance(w.id);
      }
      if (r.outcome === 'failed') {
        const delay = nextAutomaticRetryDelaySeconds(r.attemptNo);
        if (delay != null && (await requestDeliveryRetry(db, deliveryId)).accepted)
          await services.enqueueExecution(deliveryId, { kind: 'automatic_retry' }, delay);
      }
      return r;
    },

    reconciliation: {
      start: ({ integrationId, requestedBy }) =>
        startLedgerlyReconciliation(db, { integrationId, trigger: 'manual', requestedBy, dedupe: true }),
      requestRecovery: (p) => requestLedgerlyRecovery(db, p),
    },
    scan: (runId) => scanLedgerlyReconciliation({ db, cipher, endpoints, runId, workerId: deps.workerId }),
    recover: (itemId) =>
      recoverLedgerlyItem({ db, cipher, endpoints, itemId, requestedBy: 'system:recovery' }),
    maintain: (incidentId) => advanceLedgerlyMaintenance(maintainDeps, incidentId),

    adaptations: {
      propose: (p) => {
        if (!patchCatalog().some((x) => x.id === p.patchId))
          throw new AdaptationError('INVALID', 'Only reviewed patches from the catalog can be proposed');
        return proposePatch(db, p);
      },
      validate: (id) => validateLedgerlyAdaptation(db, cipher, endpoints, id),
      activate: async (id, actor, note, opts) => {
        const row = await activateLedgerlyAdaptation(db, id, actor, note, opts);
        // A maintenance event waiting on this decision continues.
        if (row.maintenanceEventId) await services.enqueueMaintenance(row.maintenanceEventId);
        return row;
      },
      rollback: (id, actor, reason) => rollbackLedgerlyAdaptation(db, id, actor, reason),
      reject: (id, actor, reason) => rejectLedgerlyAdaptation(db, id, actor, reason),
    },

    inspect: (integrationId) => ledgerlyRunningCode(db, integrationId),

    async probe(integ): Promise<Probe> {
      const credentials: CredentialState[] = [];
      const probe: Probe = {
        source: { available: false, detail: '' },
        destination: { available: false, detail: '' },
        credentials,
        recentSourceActivity: null,
      };
      try {
        const stripe = await stripeFor(db, cipher, endpoints, integ.tenantId);
        await stripe.sdk.accounts.retrieve();
        const since = Math.floor(Date.now() / 1000) - 24 * 3600;
        const recent = await stripe.sdk.events.list({
          created: { gte: since },
          types: [...MANAGED_EVENT_TYPES],
          limit: 100,
        });
        probe.source = { available: true, detail: 'Stripe answered' };
        probe.recentSourceActivity = {
          count: recent.data.length,
          from: new Date(since * 1000).toISOString(),
          to: new Date().toISOString(),
        };
        credentials.push({ provider: 'stripe', state: 'valid', detail: 'key accepted' });
      } catch (err) {
        const msg = describeError(err).message;
        const auth = err instanceof AuthorizationLost || (err as { statusCode?: number }).statusCode === 401;
        probe.source = { available: false, detail: msg };
        credentials.push({
          provider: 'stripe',
          state: auth ? (/revoked|expired/i.test(msg) ? 'revoked' : 'expired') : 'unknown',
          detail: msg,
        });
      }
      try {
        const qbo = new QuickBooksAccess(db, cipher, endpoints, integ.tenantId);
        const ci = await qbo.query<{ CompanyInfo?: unknown[] }>('select * from CompanyInfo');
        probe.destination = { available: !!ci.CompanyInfo?.length, detail: 'QuickBooks answered' };
        credentials.push({ provider: 'quickbooks', state: 'valid', detail: 'token valid' });
      } catch (err) {
        const msg = describeError(err).message;
        probe.destination = { available: false, detail: msg };
        const conn = await loadConnection(db, integ.tenantId, 'quickbooks');
        credentials.push({
          provider: 'quickbooks',
          state:
            err instanceof AuthorizationLost
              ? conn?.status === 'revoked'
                ? 'revoked'
                : 'expired'
              : 'unknown',
          detail: msg,
        });
      }
      return probe;
    },

    async sweep() {
      // Durable outbox completion: deliveries accepted but never picked up.
      const orphaned = await db
        .select({ id: deliveries.id })
        .from(deliveries)
        .innerJoin(integrations, eq(integrations.id, deliveries.integrationId))
        .where(
          and(
            eq(integrations.flowType, LEDGERLY_FLOW_TYPE),
            eq(deliveries.outcome, 'pending'),
            lt(deliveries.updatedAt, new Date(Date.now() - 2 * 60_000)),
          ),
        );
      for (const o of orphaned) await services.enqueueExecution(o.id, { kind: 'automatic_retry' });
      const active = await db
        .select()
        .from(integrations)
        .where(
          and(
            eq(integrations.enabled, true),
            eq(integrations.lifecycle, 'active'),
            eq(integrations.flowType, LEDGERLY_FLOW_TYPE),
          ),
        );
      for (const integ of active) {
        // Dependency contract of the pinned code vs provider documentation.
        const dep = await checkDependencyContract(db, integ);
        if (dep) await services.enqueueMaintenance(dep.id);
        // Scheduled completeness check (bounded: one run per interval).
        const due = new Date(Date.now() - deps.reconcileIntervalMinutes * 60_000);
        const recent = await db
          .select({ id: reconciliationRuns.id })
          .from(reconciliationRuns)
          .where(and(eq(reconciliationRuns.integrationId, integ.id), gt(reconciliationRuns.startedAt, due)))
          .limit(1);
        if (!recent.length) {
          const s = await startLedgerlyReconciliation(db, { integrationId: integ.id, trigger: 'schedule' });
          if (!s.deduplicated) await services.enqueueReconciliation(s.runId);
        }
      }
      for (const id of await openLedgerlyEvents(db)) await services.enqueueMaintenance(id);
    },
  };
}

/** Validated patches waiting for a person on this integration (operator queue helper). */
export async function ledgerlyAwaitingDecision(db: Db, integrationIds: string[]) {
  if (!integrationIds.length) return [];
  return db
    .select()
    .from(adaptations)
    .where(and(inArray(adaptations.integrationId, integrationIds), eq(adaptations.status, 'validated')));
}
