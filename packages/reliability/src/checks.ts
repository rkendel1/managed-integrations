/**
 * Deterministic reliability evaluation. Reads durable state, opens/advances incidents, and
 * returns actions for the worker to execute. It performs no provider I/O itself — decisions
 * are separated from execution.
 */
import { and, desc, eq, ne } from 'drizzle-orm';
import type { IncidentKind, IntegrationContractDefinition } from '@mi/contracts';
import {
  connections,
  deliveries,
  incidents,
  integrationContracts,
  integrations,
  maintenanceRuns,
  reconciliationRuns,
  syncRuns,
  type Db,
} from '@mi/database';
import {
  findOpenIncident,
  noteIncident,
  openIncident,
  resolveWithVerification,
  transitionIncident,
  type IncidentRow,
} from './incidents.ts';
import type { ReconcileResult } from './reconciliation.ts';

export type ReliabilityAction =
  | { type: 'sync'; integrationId: string; trigger: 'recovery' }
  | { type: 'reconcile'; integrationId: string; incidentId: string | null; trigger: 'incident' | 'schedule' }
  | { type: 'redeliver'; integrationId: string; legacyIds: string[]; incidentId: string | null }
  | { type: 'assess_backlog'; integrationId: string; incidentId: string }
  | { type: 'maintenance'; integrationId: string; incidentId: string };

export type Health = 'healthy' | 'degraded' | 'failing' | 'unknown';

const AUTH_CLASSES = new Set(['authentication', 'authorization']);
const RECOVERABLE_CLASSES = new Set(['transient', 'rate_limited']);

export interface EvaluationResult {
  health: Health;
  actions: ReliabilityAction[];
  openIncidents: { id: string; kind: string; status: string }[];
  freshnessLagMinutes: number | null;
}

export async function evaluateIntegration(
  db: Db,
  integrationId: string,
  now = new Date(),
): Promise<EvaluationResult> {
  const [integration] = await db.select().from(integrations).where(eq(integrations.id, integrationId));
  if (!integration) throw new Error('integration not found');
  const [contractRow] = await db
    .select()
    .from(integrationContracts)
    .where(eq(integrationContracts.version, integration.contractVersion));
  const contract = contractRow!.definition as IntegrationContractDefinition;
  const actions: ReliabilityAction[] = [];

  const runs = await db
    .select()
    .from(syncRuns)
    .where(and(eq(syncRuns.integrationId, integrationId), ne(syncRuns.status, 'running')))
    .orderBy(desc(syncRuns.createdAt))
    .limit(10);
  const lastRun = runs[0];
  let consecutiveFailures = 0;
  for (const r of runs) {
    if (r.status === 'failed' || r.status === 'interrupted') consecutiveFailures++;
    else break;
  }
  const conns = await db.select().from(connections).where(eq(connections.tenantId, integration.tenantId));
  const base = {
    tenantId: integration.tenantId,
    integrationId,
    implementationVersionId: integration.implementationVersionId,
  };
  const succeededAfter = (since: Date) =>
    runs.find(
      (r) =>
        (r.status === 'succeeded' || r.status === 'partial') &&
        r.mode !== 'redelivery' &&
        r.createdAt > since &&
        (r.evidence as { caughtUp?: boolean })?.caughtUp,
    );

  /* ---------------- 1. connection authorization ---------------- */
  const badConn = conns.find((c) => c.status === 'revoked' || c.status === 'error');
  const authFailure = lastRun?.status === 'failed' && AUTH_CLASSES.has(lastRun.errorClass ?? '');
  if (badConn || authFailure) {
    const provider =
      badConn?.providerId ??
      (lastRun?.errorMessage?.toLowerCase().includes('netsuite') ? 'netsuite' : 'shopify');
    const providerName = provider === 'netsuite' ? 'NetSuite' : 'Shopify';
    await openIncident(db, {
      ...base,
      kind: 'connection_auth',
      severity: 'critical',
      title: `${providerName} authorization is no longer valid`,
      reason: badConn?.verificationError ?? lastRun?.errorMessage ?? 'Provider rejected credentials',
      errorClass: lastRun?.errorClass ?? 'authentication',
      affectedScope: { provider, syncRunIds: runs.slice(0, consecutiveFailures).map((r) => r.id) },
      impact:
        'Orders are not being synchronized until authorization is restored. No orders are lost: syncing resumes from the last durable cursor.',
      customerSummary: `${providerName} rejected our access. Synchronization is paused safely; nothing has been lost.`,
      customerAction: `Re-authorize ${providerName} on the Connections page.`,
      evidence: { lastRunId: lastRun?.id, connectionStatus: badConn?.status },
      classifyAs: 'requires_action',
      classificationNote: 'Authentication/authorization failure: only the customer can restore access.',
    });
  } else {
    const open = await findOpenIncident(db, integrationId, 'connection_auth');
    const ok = open && succeededAfter(open.detectedAt);
    if (open && ok) {
      await resolveWithVerification(db, open.id, {
        actor: 'system',
        resolution: 'Authorization restored and a full sync completed.',
        verification: {
          syncRunId: ok.id,
          connections: conns.map((c) => ({ provider: c.providerId, status: c.status })),
        },
      });
    }
  }

  /* ---------------- 2. schema drift / 3. sync failures ---------------- */
  if (lastRun?.status === 'failed' && lastRun.errorClass === 'schema') {
    const [inc, created] = await openIncident(db, {
      ...base,
      kind: 'schema_drift',
      severity: 'high',
      title: 'Provider response no longer matches the integration implementation',
      reason: lastRun.errorMessage ?? 'Schema mismatch',
      errorClass: 'schema',
      affectedScope: {
        syncRunIds: runs.slice(0, consecutiveFailures).map((r) => r.id),
        cursorWatermark: integration.cursorWatermark,
      },
      impact:
        'New and changed orders since the last successful sync are delayed. Already-delivered orders are unaffected.',
      customerSummary:
        'Shopify changed how order data is returned. We detected it automatically and are preparing a fix; delayed orders will be delivered once it is released.',
      customerAction: null,
      evidence: { lastRunId: lastRun.id },
      classifyAs: 'investigating',
      classificationNote:
        'Deterministic recovery cannot fix a schema mismatch; internal maintenance engaged.',
    });
    if (created) actions.push({ type: 'assess_backlog', integrationId, incidentId: inc.id });
    if (!(await hasMaintenanceRun(db, inc.id)))
      actions.push({ type: 'maintenance', integrationId, incidentId: inc.id });
  } else if (
    lastRun &&
    (lastRun.status === 'failed' || lastRun.status === 'interrupted') &&
    !AUTH_CLASSES.has(lastRun.errorClass ?? '')
  ) {
    const cls = lastRun.errorClass ?? 'unknown';
    const recoverable = RECOVERABLE_CLASSES.has(cls) || lastRun.status === 'interrupted';
    const threshold = recoverable ? 2 : 1;
    if (consecutiveFailures >= threshold) {
      const [inc, created] = await openIncident(db, {
        ...base,
        kind: 'sync_failure',
        severity: consecutiveFailures >= 4 ? 'high' : 'medium',
        title: recoverable
          ? 'Synchronization is failing with temporary provider errors'
          : 'Synchronization is failing',
        reason: lastRun.errorMessage ?? 'Sync failed',
        errorClass: cls,
        affectedScope: {
          syncRunIds: runs.slice(0, consecutiveFailures).map((r) => r.id),
          consecutiveFailures,
        },
        impact:
          'Orders are delayed; none are skipped. The cursor has not advanced past any undelivered order.',
        customerSummary: recoverable
          ? 'A provider is returning temporary errors. We are retrying automatically; delayed orders will be delivered once it recovers.'
          : 'Synchronization stopped on an unexpected error. We are investigating.',
        customerAction: null,
        evidence: { lastRunId: lastRun.id },
        classifyAs: recoverable ? 'recoverable' : 'investigating',
        classificationNote: recoverable
          ? `Retryable (${cls}); automatic retries continue with backoff.`
          : `Non-retryable (${cls}); internal maintenance engaged.`,
      });
      if (recoverable) actions.push({ type: 'sync', integrationId, trigger: 'recovery' });
      else if (!(await hasMaintenanceRun(db, inc.id)))
        actions.push({ type: 'maintenance', integrationId, incidentId: inc.id });
      if (created) actions.push({ type: 'assess_backlog', integrationId, incidentId: inc.id });
    }
  }
  // Recovery verification for sync_failure / schema_drift: a caught-up successful run → reconcile.
  for (const kind of ['sync_failure', 'schema_drift'] as IncidentKind[]) {
    const open = await findOpenIncident(db, integrationId, kind);
    if (!open) continue;
    const ok = succeededAfter(open.detectedAt);
    if (!ok) continue;
    if (open.status !== 'verification') {
      if (open.status !== 'recovery') {
        await transitionIncident(db, open.id, 'recovery', {
          actor: 'system',
          note: `Sync resumed successfully (run ${ok.id.slice(0, 8)}, implementation ${ok.implementationVersionId ?? 'n/a'}).`,
          evidence: { syncRunId: ok.id },
        });
      }
      await transitionIncident(db, open.id, 'verification', {
        actor: 'system',
        note: 'Reconciling affected orders against NetSuite before closing.',
      });
    }
    actions.push({ type: 'reconcile', integrationId, incidentId: open.id, trigger: 'incident' });
  }

  /* ---------------- 4. freshness ---------------- */
  const maxDelayMs = contract.freshness.maxAcceptableDelayMinutes * 60_000;
  const reference = integration.lastSuccessfulSyncAt ?? (integration.enabled ? integration.createdAt : null);
  const lagMs = reference ? now.getTime() - reference.getTime() : null;
  if (integration.enabled && lagMs != null && lagMs > maxDelayMs) {
    await openIncident(db, {
      ...base,
      kind: 'freshness_breach',
      severity: 'high',
      title: `Data is older than the ${contract.freshness.maxAcceptableDelayMinutes}-minute freshness commitment`,
      reason: `Last successful sync ${integration.lastSuccessfulSyncAt?.toISOString() ?? 'never'}; lag ${Math.round(lagMs / 60000)} minutes.`,
      affectedScope: { lagMinutes: Math.round(lagMs / 60000), cursorWatermark: integration.cursorWatermark },
      impact: 'NetSuite does not yet contain the most recent Shopify orders.',
      customerSummary: 'Recent orders are taking longer than our freshness commitment to reach NetSuite.',
      customerAction: null,
      classifyAs: 'recoverable',
      classificationNote: 'Freshness breach; resolves when a full sync completes within the commitment.',
    });
  } else {
    const open = await findOpenIncident(db, integrationId, 'freshness_breach');
    if (open && lagMs != null && lagMs <= maxDelayMs) {
      await resolveWithVerification(db, open.id, {
        actor: 'system',
        resolution: 'Synchronization caught up within the freshness commitment.',
        verification: {
          lastSuccessfulSyncAt: integration.lastSuccessfulSyncAt?.toISOString(),
          lagMinutes: Math.round(lagMs / 60000),
        },
      });
    }
  }

  /* ---------------- 5. rejected records (customer action) ---------------- */
  const rejected = await db
    .select()
    .from(deliveries)
    .where(and(eq(deliveries.integrationId, integrationId), eq(deliveries.outcome, 'rejected')));
  if (rejected.length) {
    const unmapped = new Set<string>();
    for (const r of rejected)
      for (const m of (r.lastError ?? '').matchAll(/SKU (\S+) is not mapped/g)) unmapped.add(m[1]!);
    const action = unmapped.size
      ? `Map these SKUs to NetSuite items in the integration settings: ${[...unmapped].join(', ')}. Affected orders are delivered automatically afterwards.`
      : 'Review the rejected orders listed below; they need a business decision or NetSuite configuration change.';
    await openIncident(db, {
      ...base,
      kind: 'records_rejected',
      severity: 'medium',
      title: `${rejected.length} order(s) could not be delivered and need your input`,
      reason: 'Orders failed contract validation or were rejected by NetSuite.',
      errorClass: 'invalid_data',
      affectedScope: {
        orders: rejected
          .slice(0, 200)
          .map((r) => ({ name: r.sourceName, legacyId: r.sourceLegacyId, reason: r.lastError })),
      },
      impact: `${rejected.length} order(s) are not in NetSuite. All other orders continue to sync.`,
      customerSummary: `${rejected.length} order(s) need your input before they can be delivered.`,
      customerAction: action,
      classifyAs: 'requires_action',
      classificationNote: 'Invalid data: requires a customer decision; not retried blindly.',
    });
  } else {
    const open = await findOpenIncident(db, integrationId, 'records_rejected');
    if (open) {
      await resolveWithVerification(db, open.id, {
        actor: 'system',
        resolution: 'All previously rejected orders have been delivered or resolved.',
        verification: { rejectedCount: 0 },
      });
    }
  }

  /* ---------------- 6. scheduled reconciliation discrepancies ---------------- */
  const [lastRecon] = await db
    .select()
    .from(reconciliationRuns)
    .where(
      and(eq(reconciliationRuns.integrationId, integrationId), eq(reconciliationRuns.status, 'completed')),
    )
    .orderBy(desc(reconciliationRuns.startedAt))
    .limit(1);
  const discOpen = await findOpenIncident(db, integrationId, 'reconciliation_discrepancy');
  if (
    lastRecon &&
    lastRecon.outcome === 'consistent' &&
    discOpen &&
    lastRecon.startedAt > discOpen.detectedAt
  ) {
    await resolveWithVerification(db, discOpen.id, {
      actor: 'system',
      resolution: 'Reconciliation is consistent.',
      verification: { reconciliationRunId: lastRecon.id },
    });
  }

  /* ---------------- health ---------------- */
  const open = await db
    .select()
    .from(incidents)
    .where(and(eq(incidents.integrationId, integrationId), ne(incidents.status, 'resolved')));
  let health: Health;
  if (!integration.lastSuccessfulSyncAt && !open.length) health = 'unknown';
  else if (open.some((i) => i.severity === 'high' || i.severity === 'critical')) health = 'failing';
  else if (open.length) health = 'degraded';
  else health = 'healthy';
  await db.update(integrations).set({ health }).where(eq(integrations.id, integrationId));

  return {
    health,
    actions: dedupeActions(actions),
    openIncidents: open.map((i) => ({ id: i.id, kind: i.kind, status: i.status })),
    freshnessLagMinutes: lagMs != null ? Math.round(lagMs / 60000) : null,
  };
}

function dedupeActions(a: ReliabilityAction[]): ReliabilityAction[] {
  const seen = new Set<string>();
  return a.filter((x) => {
    const k = JSON.stringify(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function hasMaintenanceRun(db: Db, incidentId: string): Promise<boolean> {
  const rows = await db
    .select({ id: maintenanceRuns.id })
    .from(maintenanceRuns)
    .where(eq(maintenanceRuns.incidentId, incidentId))
    .limit(1);
  return rows.length > 0;
}

/**
 * Applies the result of a reconciliation: verifies/resolves the linked incident, or opens a
 * discrepancy incident, and returns follow-up actions (redelivery of missing orders).
 */
export async function applyReconciliationResult(
  db: Db,
  integrationId: string,
  incidentId: string | null,
  result: ReconcileResult,
): Promise<ReliabilityAction[]> {
  const [integration] = await db.select().from(integrations).where(eq(integrations.id, integrationId));
  const c = result.classification;
  const actions: ReliabilityAction[] = [];
  const summary = {
    reconciliationRunId: result.runId,
    outcome: result.outcome,
    expected: c.expected,
    matched: c.matched,
    missing: c.missing.length,
    duplicates: c.duplicates.length,
    inconsistent: c.inconsistent.length,
    stale: c.stale.length,
    unexpected: c.unexpected.length,
    unresolved: c.unresolved.length,
  };

  if (c.missing.length && result.outcome === 'discrepancies') {
    actions.push({
      type: 'redeliver',
      integrationId,
      legacyIds: c.missing.map((m) => m.legacyId),
      incidentId,
    });
  }

  if (incidentId) {
    const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
    if (inc && inc.status === 'verification') {
      const blocking = c.missing.length + c.duplicates.length + c.inconsistent.length;
      if ((result.outcome === 'consistent' || result.outcome === 'discrepancies') && blocking === 0) {
        await resolveWithVerification(db, inc.id, {
          actor: 'system',
          resolution: `Recovered. Reconciliation verified ${c.matched} of ${c.expected} expected orders present and consistent in NetSuite; no missing or duplicate records.`,
          verification: summary,
        });
      } else {
        await noteIncident(db, inc.id, `Verification incomplete: ${JSON.stringify(summary)}`, {
          customerVisible: false,
          evidence: summary,
        });
      }
    }
    return actions;
  }

  // Scheduled reconciliation: open a discrepancy incident for anything not explained elsewhere.
  if (
    integration &&
    result.outcome === 'discrepancies' &&
    (c.missing.length || c.duplicates.length || c.inconsistent.length || c.unexpected.length)
  ) {
    const operatorOnly = c.duplicates.length + c.inconsistent.length + c.unexpected.length > 0;
    await openIncident(db, {
      tenantId: integration.tenantId,
      integrationId,
      kind: 'reconciliation_discrepancy',
      severity: c.duplicates.length || c.inconsistent.length ? 'high' : 'medium',
      title: 'Reconciliation found orders that do not match NetSuite',
      reason: `missing ${c.missing.length}, duplicate ${c.duplicates.length}, inconsistent ${c.inconsistent.length}, unexpected ${c.unexpected.length}`,
      affectedScope: {
        missing: c.missing,
        duplicates: c.duplicates,
        inconsistent: c.inconsistent,
        unexpected: c.unexpected,
      },
      impact: 'Some orders may be absent or different in NetSuite.',
      customerSummary: operatorOnly
        ? 'We found NetSuite records that do not match Shopify. We are reviewing them; we never delete NetSuite records automatically.'
        : 'Some orders were missing from NetSuite. We are re-delivering them automatically.',
      customerAction: null,
      evidence: summary,
      classifyAs: operatorOnly ? 'investigating' : 'recoverable',
      classificationNote: operatorOnly
        ? 'Duplicates/inconsistencies need operator review (no destructive auto-repair).'
        : 'Missing orders are recoverable by idempotent redelivery.',
    });
  }
  return actions;
}

/** Records the backlog (affected orders) on an incident using the stable source identity read. */
export async function recordAffectedOrders(
  db: Db,
  incident: IncidentRow,
  orders: { name: string; legacyId: string; updatedAt: string }[],
) {
  await db
    .update(incidents)
    .set({
      affectedScope: {
        ...(incident.affectedScope as object),
        affectedOrders: orders.slice(0, 500),
        affectedOrderCount: orders.length,
      },
      impact: `${orders.length} order(s) updated since the last successful sync are waiting to be delivered.`,
      updatedAt: new Date(),
    })
    .where(eq(incidents.id, incident.id));
  await noteIncident(db, incident.id, `Identified ${orders.length} affected order(s) awaiting delivery.`, {
    customerVisible: true,
  });
}
