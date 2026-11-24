/**
 * Shopify → NetSuite (adopted) as an IntegrationRuntime (slice 6): the shared queues, worker tick,
 * onboarding, monitoring and operator tooling reach this integration only through these hooks.
 * The bodies are this integration's own behaviour (moved, not rewritten, from the slice 2–5 worker).
 */
import { and, eq, gt, lt } from 'drizzle-orm';
import {
  adaptations,
  deliveries,
  incidents,
  integrations,
  reconciliationItems,
  reconciliationRuns,
  type Db,
} from '@mi/database';
import {
  ConnectionCredentials,
  DEFAULT_RETRY,
  withRetry,
  type CredentialCipher,
  type ProviderEndpointConfig,
  type RetryPolicy,
} from '@mi/integration-shopify-netsuite';
import { ProviderError } from '@mi/contracts';
import { describeError } from '@mi/observability';
import {
  AdaptationError,
  type CredentialState,
  type IntegrationRuntime,
  type Probe,
  type WorkServices,
} from '@mi/managed';
import {
  activateAdaptation,
  proposeAdaptation,
  rejectAdaptation,
  rollbackAdaptation,
  runningCode,
  validateAdaptation,
} from './adaptation.ts';
import { patchCatalog } from './artifact.ts';
import { ADOPTED_FLOW_TYPE } from './contract.ts';
import { SHOPIFY_NETSUITE } from './descriptor.ts';
import { executeDelivery, nextAutomaticRetryDelaySeconds, requestDeliveryRetry } from './execute.ts';
import {
  advanceMaintenance,
  heldWithoutEvent,
  openMaintenanceEvents,
  recordInputContractFinding,
} from './maintenance.ts';
import { shopifyOnboarding } from './onboarding.ts';
import {
  adoptedClients,
  executeRecovery,
  findOrphanedWork,
  scanReconciliation,
  startReconciliation,
} from './reconcile.ts';

export interface ShopifyRuntimeDeps {
  db: Db;
  cipher: CredentialCipher;
  endpoints: ProviderEndpointConfig;
  services: WorkServices;
  webhookBaseUrl: string;
  workerId: string;
  reconcileIntervalMinutes: number;
  retry?: RetryPolicy;
}

/** Classifies a probe failure: lost authorization vs an unavailable system. */
function credentialFromError(provider: string, err: unknown): CredentialState | null {
  const pe = err instanceof ProviderError ? err : null;
  const msg = describeError(err).message;
  if (
    pe?.errorClass === 'authentication' ||
    pe?.errorClass === 'authorization' ||
    /revoked|invalid_grant|401|unauthori[sz]ed|forbidden/i.test(msg)
  )
    return { provider, state: /revoked/i.test(msg) ? 'revoked' : 'expired', detail: msg };
  return null;
}

export function createShopifyNetsuiteRuntime(deps: ShopifyRuntimeDeps): IntegrationRuntime {
  const { db, cipher, endpoints, services } = deps;
  const retry = deps.retry ?? DEFAULT_RETRY;
  const clientsFor = (integrationId: string) => adoptedClients(db, cipher, endpoints, integrationId);

  return {
    descriptor: SHOPIFY_NETSUITE,
    onboarding: shopifyOnboarding({
      cipher,
      endpoints,
      webhookBaseUrl: deps.webhookBaseUrl,
      enqueueReconciliation: services.enqueueReconciliation,
      ...(deps.retry ? { retry: deps.retry } : {}),
    }),

    async execute(deliveryId, trigger) {
      const result = await executeDelivery({ db, cipher, endpoints, deliveryId, trigger });
      if (result.executed && result.outcome === 'held') {
        // The input no longer satisfies the adopted contract: nothing was written; maintenance takes over.
        const f = await recordInputContractFinding(db, cipher, deliveryId);
        if (f) await services.enqueueMaintenance(f.incidentId);
      }
      if (result.executed && result.outcome === 'failed') {
        const delay = nextAutomaticRetryDelaySeconds(result.attemptNo);
        if (delay != null && (await requestDeliveryRetry(db, deliveryId)).accepted)
          await services.enqueueExecution(deliveryId, { kind: 'automatic_retry' }, delay);
      }
      return result;
    },

    async scan(runId) {
      const [run] = await db.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, runId));
      if (!run) return { skipped: 'unknown run' };
      return scanReconciliation({
        db,
        runId,
        workerId: deps.workerId,
        clients: await clientsFor(run.integrationId),
        retry,
      });
    },

    async recover(itemId) {
      const [item] = await db.select().from(reconciliationItems).where(eq(reconciliationItems.id, itemId));
      if (!item) return { skipped: 'unknown item' };
      const r = await executeRecovery({
        db,
        cipher,
        endpoints,
        itemId,
        clients: await clientsFor(item.integrationId),
        retry,
      });
      if (!r.done && r.retryLater) throw new Error(`recovery deferred: ${r.reason}`); // pg-boss retries with backoff
      return r;
    },

    async maintain(incidentId) {
      const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
      if (!inc?.integrationId) return { state: 'noop', detail: 'unknown event' };
      return advanceMaintenance({
        db,
        cipher,
        incidentId,
        clients: await clientsFor(inc.integrationId),
        enqueueExecution: (id, t) => services.enqueueExecution(id, t),
        enqueueReconciliation: services.enqueueReconciliation,
        enqueueRecovery: services.enqueueRecovery,
        retry,
      });
    },

    adaptations: {
      async propose({ integrationId, patchId, actor, reason, maintenanceEventId }) {
        const p = patchCatalog().find((x) => x.id === patchId);
        if (!p)
          throw new AdaptationError('INVALID', 'Only reviewed patches from the catalog can be proposed');
        return proposeAdaptation(db, {
          integrationId,
          maintenanceEventId: maintenanceEventId ?? null,
          kind: 'patch',
          dependency: { addresses: p.addresses },
          codePath: { file: p.file, originalBehavior: p.originalBehavior },
          spec: {
            patchId: p.id,
            file: p.file,
            baseSha256: p.baseSha256,
            resultSha256: p.resultSha256,
            find: p.find,
            replace: p.replace,
          },
          rationale: `${p.reason} — proposed by operator: ${reason}`,
          evidence: {
            providerEvidence: p.providerEvidence,
            assumptions: p.assumptions,
            rollback: p.rollback,
          },
          actor,
        });
      },
      async validate(adaptationId) {
        const [row] = await db.select().from(adaptations).where(eq(adaptations.id, adaptationId));
        return validateAdaptation(db, cipher, adaptationId, await clientsFor(row!.integrationId), retry);
      },
      activate: (id, actor, note, opts) => activateAdaptation(db, id, actor, note, opts),
      rollback: (id, actor, reason) => rollbackAdaptation(db, id, actor, reason),
      reject: (id, actor, reason) => rejectAdaptation(db, id, actor, reason),
    },

    inspect: (integrationId) => runningCode(db, integrationId),

    async probe(integ): Promise<Probe> {
      const creds = new ConnectionCredentials(db, cipher, endpoints);
      const credentials: CredentialState[] = [];
      for (const p of ['shopify', 'netsuite'] as const) {
        const row = await creds.load(integ.tenantId, p);
        if (!row?.credentialsCiphertext)
          credentials.push({ provider: p, state: 'missing', detail: 'not connected' });
        else if (row.status === 'revoked')
          credentials.push({ provider: p, state: 'revoked', detail: row.verificationError ?? 'revoked' });
        else credentials.push({ provider: p, state: 'valid', detail: row.status });
      }
      const probe: Probe = {
        source: { available: false, detail: '' },
        destination: { available: false, detail: '' },
        credentials,
        recentSourceActivity: null,
      };
      let clients;
      try {
        clients = await clientsFor(integ.id);
      } catch (err) {
        probe.source.detail = probe.destination.detail = describeError(err).message;
        return probe;
      }
      const mark = (provider: string, err: unknown) => {
        const c = credentialFromError(provider, err);
        if (c) probe.credentials = [...probe.credentials.filter((x) => x.provider !== provider), c];
      };
      try {
        const since = new Date(Date.now() - 24 * 3600_000).toISOString();
        const res = await withRetry(
          () =>
            clients.shopify.graphql(
              `query { shop { name } orders(first: 50, query: "created_at:>='${since}'") { nodes { id } } }`,
              {},
            ),
          { ...retry, maxAttempts: 1 },
        );
        const nodes = (res.data as { orders?: { nodes: unknown[] } }).orders?.nodes ?? [];
        probe.source = { available: true, detail: 'Shopify Admin API answered' };
        probe.recentSourceActivity = { count: nodes.length, from: since, to: new Date().toISOString() };
      } catch (err) {
        probe.source = { available: false, detail: describeError(err).message };
        mark('shopify', err);
      }
      try {
        await clients.netsuite.suiteqlPage(
          `SELECT id, entityid FROM customer WHERE entityid IN ('WEB')`,
          [],
          1,
          0,
        );
        probe.destination = { available: true, detail: 'NetSuite SuiteQL answered' };
      } catch (err) {
        probe.destination = { available: false, detail: describeError(err).message };
        mark('netsuite', err);
      }
      return probe;
    },

    async sweep() {
      // Durable outbox completion: deliveries accepted but never picked up (API stopped mid-way).
      const orphaned = await db
        .select({ id: deliveries.id })
        .from(deliveries)
        .innerJoin(integrations, eq(integrations.id, deliveries.integrationId))
        .where(
          and(
            eq(integrations.flowType, ADOPTED_FLOW_TYPE),
            eq(deliveries.outcome, 'pending'),
            lt(deliveries.updatedAt, new Date(Date.now() - 2 * 60_000)),
          ),
        );
      for (const o of orphaned) await services.enqueueExecution(o.id, { kind: 'automatic_retry' });
      // Reconciliation scans and recoveries left behind by a dead worker (expired leases).
      const orphanedRecon = await findOrphanedWork(db);
      for (const runId of orphanedRecon.runIds) await services.enqueueReconciliation(runId);
      for (const itemId of orphanedRecon.itemIds) await services.enqueueRecovery(itemId);
      // Held orders whose finding was lost, and open maintenance events.
      for (const deliveryId of await heldWithoutEvent(db)) {
        const f = await recordInputContractFinding(db, cipher, deliveryId);
        if (f) await services.enqueueMaintenance(f.incidentId);
      }
      for (const incidentId of await openMaintenanceEvents(db)) await services.enqueueMaintenance(incidentId);
      // Scheduled completeness check (bounded: one run per interval).
      const active = await db
        .select()
        .from(integrations)
        .where(and(eq(integrations.enabled, true), eq(integrations.flowType, ADOPTED_FLOW_TYPE)));
      for (const integ of active) {
        const due = new Date(Date.now() - deps.reconcileIntervalMinutes * 60_000);
        const recent = await db
          .select({ id: reconciliationRuns.id })
          .from(reconciliationRuns)
          .where(and(eq(reconciliationRuns.integrationId, integ.id), gt(reconciliationRuns.startedAt, due)))
          .limit(1);
        if (!recent.length) {
          const started = await startReconciliation(db, { integrationId: integ.id, trigger: 'schedule' });
          if (!started.deduplicated) await services.enqueueReconciliation(started.runId);
        }
      }
    },
  };
}
