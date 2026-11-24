/** The QuickBooks-dependent application's runtime on the shared registry, queues and lifecycles. */
import { and, eq, ne } from 'drizzle-orm';
import { incidents, integrations, type Db } from '@mi/database';
import type { CredentialCipher, ProviderEndpointConfig } from '@mi/integration-shopify-netsuite';
import { adaptationsOf, pinnedDrift, type IntegrationRuntime, type Probe, type WorkServices } from '@mi/managed';
import { describeError } from '@mi/observability';
import { AuthorizationLost, loadConnection, QuickBooksAccess } from '@mi/provider-connections';
import { activateQboAdaptation, proposeDependencyChange, rejectQboAdaptation, rollbackQboAdaptation, validateDependencyChange } from './adaptation.ts';
import { dependencyChangeCatalog, pinnedSource } from './artifact.ts';
import { QBO_TOOLS_FLOW_TYPE } from './contract.ts';
import { QBO_TOOLS } from './descriptor.ts';
import { loadApplication } from './host.ts';
import { activeChanges, invokeCreateInvoice, type InvoiceInput } from './invoke.ts';
import { advanceQboMaintenance, checkUpstream } from './maintenance.ts';
import { qboToolsOnboarding } from './onboarding.ts';
import { QBO_TOOLS_APP } from './provenance.ts';

export function createQboToolsRuntime(deps: { db: Db; cipher: CredentialCipher; endpoints: ProviderEndpointConfig; services: WorkServices }): IntegrationRuntime {
  const { db, cipher, endpoints, services } = deps;
  const host = { db, cipher, endpoints };
  return {
    descriptor: QBO_TOOLS,
    onboarding: qboToolsOnboarding({ cipher, endpoints }),
    async invoke(p) {
      if (p.operation !== 'create_invoice') throw new Error(`Unknown operation ${p.operation}`);
      const r = await invokeCreateInvoice(host, { integrationId: p.integrationId, input: p.input as unknown as InvoiceInput, requestId: p.requestId, principalId: p.principalId });
      if (r.outcome === 'awaiting_authorization') {
        const ev = (r.output as { reauthEventId?: string }).reauthEventId;
        if (ev) await services.enqueueMaintenance(ev);
      }
      if (r.outcome === 'delivered' && !r.replayed) {
        // An upgrade waiting to be verified on real work can continue.
        const waiting = await db.select({ id: incidents.id }).from(incidents).where(and(eq(incidents.integrationId, p.integrationId), eq(incidents.kind, 'application_change'), ne(incidents.status, 'resolved')));
        for (const w of waiting) await services.enqueueMaintenance(w.id);
      }
      return r;
    },
    maintain: (incidentId) => advanceQboMaintenance({ ...host, services }, incidentId),
    adaptations: {
      propose: (p) => proposeDependencyChange(db, { integrationId: p.integrationId, changeId: p.patchId, actor: p.actor, reason: p.reason, maintenanceEventId: p.maintenanceEventId ?? null }),
      validate: (id) => validateDependencyChange(db, cipher, endpoints, id),
      activate: async (id, actor, note, opts) => {
        const row = await activateQboAdaptation(db, id, actor, note, opts);
        if (row.maintenanceEventId) await services.enqueueMaintenance(row.maintenanceEventId);
        return row;
      },
      rollback: (id, actor, reason) => rollbackQboAdaptation(db, id, actor, reason),
      reject: (id, actor, reason) => rejectQboAdaptation(db, id, actor, reason),
    },
    async inspect(integrationId) {
      const src = pinnedSource();
      const drift = pinnedDrift(src);
      let running = null;
      let problem: string | null = null;
      try {
        const app = await loadApplication((await activeChanges(db, integrationId)).changes, integrationId);
        running = { id: app.artifact.id, patches: app.artifact.patches, files: app.artifact.files, dependencies: app.artifact.dependencies };
      } catch (err) {
        problem = describeError(err).message;
      }
      return {
        adopted: { repository: QBO_TOOLS_APP.repository, commit: QBO_TOOLS_APP.commit, license: QBO_TOOLS_APP.license, package: QBO_TOOLS_APP.packageName },
        pinnedFiles: Object.entries(src.fileSha256).map(([file, expected]) => ({ file, expected, actual: drift.find((x) => x.file === file)?.actual ?? expected, matches: !drift.some((x) => x.file === file) })),
        running,
        problem,
        contracts: [],
        adaptations: await adaptationsOf(db, integrationId),
        catalog: dependencyChangeCatalog().map((c) => ({ id: c.id, title: c.title, file: `dependency ${c.dependency}` })),
      };
    },
    async probe(integ): Promise<Probe> {
      const probe: Probe = { source: { available: true, detail: 'requests come from the customer' }, destination: { available: false, detail: '' }, credentials: [], recentSourceActivity: null };
      try {
        await new QuickBooksAccess(db, cipher, endpoints, integ.tenantId).query('select * from CompanyInfo');
        probe.destination = { available: true, detail: 'QuickBooks answered' };
        probe.credentials.push({ provider: 'quickbooks', state: 'valid', detail: 'token valid' });
      } catch (err) {
        const msg = describeError(err).message;
        probe.destination = { available: false, detail: msg };
        const conn = await loadConnection(db, integ.tenantId, 'quickbooks');
        probe.credentials.push({ provider: 'quickbooks', state: err instanceof AuthorizationLost ? (conn?.status === 'revoked' ? 'revoked' : 'expired') : 'unknown', detail: msg });
      }
      return probe;
    },
    async sweep() {
      const active = await db.select().from(integrations).where(and(eq(integrations.enabled, true), eq(integrations.lifecycle, 'active'), eq(integrations.flowType, QBO_TOOLS_FLOW_TYPE)));
      for (const integ of active) {
        const ev = await checkUpstream(db, integ);
        if (ev) await services.enqueueMaintenance(ev.id);
      }
    },
  };
}
