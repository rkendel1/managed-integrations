/**
 * Monitoring (generic). Evaluates an integration against the signals its descriptor declares, from durable
 * facts — deliveries, attempts, reconciliation runs, maintenance events, corrections — plus a probe of the
 * connected systems supplied by the integration's runtime. A successful HTTP call or worker run is never
 * treated as health: "destination verification" needs a completed, consistent reconciliation.
 *
 * Output is a durable fact, not an alert stream: a `monitoring` observation is written only when a signal's
 * state changes, and the integration's `health` is updated. Lost authorization opens one maintenance event
 * that asks the customer to reconnect (the only monitoring signal that needs the customer).
 */
import { and, desc, eq, gt, inArray, lt, ne, sql } from 'drizzle-orm';
import {
  adaptations,
  deliveries,
  incidents,
  integrations,
  observations,
  reconciliationRuns,
  type Db,
} from '@mi/database';
import type { IntegrationDescriptor, MonitoringSignal } from './descriptor.ts';
import { MONITORING_SIGNALS, describedSignals } from './descriptor.ts';
import { openMaintenanceEvent } from './events.ts';

export type SignalState = 'ok' | 'attention' | 'failing' | 'not_monitored';

export interface CredentialState {
  provider: string;
  state: 'valid' | 'expired' | 'revoked' | 'missing' | 'unknown';
  detail: string;
}

/** What the integration's runtime observes directly in the connected systems. */
export interface Probe {
  source: { available: boolean; detail: string };
  destination: { available: boolean; detail: string };
  credentials: CredentialState[];
  /** Transactions the source shows for a recent window (to tell "quiet" from "not arriving"), or null. */
  recentSourceActivity: { count: number; from: string; to: string } | null;
}

export interface MonitoringFacts {
  at: string;
  integrationId: string;
  flowType: string;
  health: 'healthy' | 'degraded' | 'failing';
  signals: { signal: MonitoringSignal; state: SignalState; detail: string }[];
}

const DAY = 86_400_000;

export async function evaluateSignals(
  db: Db,
  integ: typeof integrations.$inferSelect,
  descriptor: IntegrationDescriptor,
  probe: Probe | null,
  now = new Date(),
): Promise<MonitoringFacts> {
  const declared = describedSignals(descriptor);
  const out = new Map<MonitoringSignal, { state: SignalState; detail: string }>();
  const set = (s: MonitoringSignal, state: SignalState, detail: string) => out.set(s, { state, detail });

  if (probe) {
    set('source_available', probe.source.available ? 'ok' : 'failing', probe.source.detail);
    set('destination_available', probe.destination.available ? 'ok' : 'failing', probe.destination.detail);
    const lost = probe.credentials.filter((c) => c.state !== 'valid' && c.state !== 'unknown');
    set(
      'credentials',
      lost.length ? 'failing' : 'ok',
      lost.length ? lost.map((c) => `${c.provider}: ${c.detail}`).join('; ') : 'all authorizations valid',
    );
  } else {
    for (const s of ['source_available', 'destination_available', 'credentials'] as const)
      set(s, 'attention', 'systems could not be probed');
  }

  const counts = await db
    .select({
      outcome: deliveries.outcome,
      n: sql<number>`count(*)::int`,
      latest: sql<Date | null>`max(${deliveries.updatedAt})`,
    })
    .from(deliveries)
    .where(
      and(eq(deliveries.integrationId, integ.id), gt(deliveries.updatedAt, new Date(now.getTime() - DAY))),
    )
    .groupBy(deliveries.outcome);
  const n = (o: string) => counts.find((c) => c.outcome === o)?.n ?? 0;
  const [last] = await db
    .select({ at: deliveries.createdAt })
    .from(deliveries)
    .where(eq(deliveries.integrationId, integ.id))
    .orderBy(desc(deliveries.createdAt))
    .limit(1);
  const received = counts.reduce((a, c) => a + c.n, 0);
  const tx = descriptor.transactions.many;
  if (probe?.recentSourceActivity && probe.recentSourceActivity.count > 0 && received === 0)
    set(
      'activity',
      'attention',
      `${probe.recentSourceActivity.count} ${tx} in the source recently, none received by us in 24 hours`,
    );
  else
    set(
      'activity',
      'ok',
      last ? `last ${descriptor.transactions.one} received ${last.at.toISOString()}` : `no ${tx} yet`,
    );

  const [stuck] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(deliveries)
    .where(
      and(
        eq(deliveries.integrationId, integ.id),
        eq(deliveries.outcome, 'pending'),
        lt(deliveries.updatedAt, new Date(now.getTime() - 10 * 60_000)),
      ),
    );
  set(
    'processing',
    stuck!.n ? 'attention' : 'ok',
    stuck!.n ? `${stuck!.n} ${tx} waiting more than 10 minutes` : 'nothing waiting',
  );
  const held = n('held') + n('awaiting_authorization');
  set(
    'delayed',
    held || n('failed') ? 'attention' : 'ok',
    `${held} held safely, ${n('failed')} failed and retrying (24h)`,
  );
  set('rejected', n('rejected') ? 'attention' : 'ok', `${n('rejected')} rejected by the destination (24h)`);

  const [run] = await db
    .select()
    .from(reconciliationRuns)
    .where(and(eq(reconciliationRuns.integrationId, integ.id), eq(reconciliationRuns.status, 'completed')))
    .orderBy(desc(reconciliationRuns.finishedAt))
    .limit(1);
  const missing = (run?.missing as unknown[] | null)?.length ?? 0;
  const dups = (run?.duplicates as unknown[] | null)?.length ?? 0;
  set(
    'missing',
    run ? (missing ? 'attention' : 'ok') : 'attention',
    run ? `${missing} missing in the last check` : 'no completed check yet',
  );
  set(
    'duplicated',
    run ? (dups ? 'failing' : 'ok') : 'attention',
    run ? `${dups} duplicated in the last check` : 'no completed check yet',
  );
  const fresh = run?.finishedAt && run.finishedAt.getTime() > now.getTime() - DAY;
  set(
    'destination_verification',
    fresh && run!.outcome === 'consistent' ? 'ok' : 'attention',
    run ? `last check ${run.finishedAt?.toISOString()}: ${run.outcome}` : 'no completed check yet',
  );

  const open = await db
    .select({ kind: incidents.kind, evidence: incidents.evidence })
    .from(incidents)
    .where(and(eq(incidents.integrationId, integ.id), ne(incidents.status, 'resolved')));
  const contract = open.filter((i) => i.kind === 'input_contract_change').length;
  set(
    'contract_change',
    contract ? 'attention' : 'ok',
    contract ? `${contract} provider change(s) being handled` : 'no provider change open',
  );
  const unsupported = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(adaptations)
    .where(and(eq(adaptations.integrationId, integ.id), eq(adaptations.status, 'unsupported')));
  const escalated = open.filter(
    (i) => (i.evidence as { maintenance?: { escalated?: string } }).maintenance?.escalated,
  ).length;
  set(
    'commitment_boundary',
    escalated ? 'attention' : 'ok',
    escalated
      ? `${escalated} event(s) outside automatic correction, with a person`
      : `within automatic maintenance (${unsupported[0]!.n} unsupported change(s) on record)`,
  );

  const signals = MONITORING_SIGNALS.map((s) =>
    declared.has(s)
      ? { signal: s, ...out.get(s)! }
      : { signal: s, state: 'not_monitored' as const, detail: 'not monitored for this integration' },
  );
  const health = signals.some((s) => s.state === 'failing')
    ? 'failing'
    : signals.some((s) => s.state === 'attention')
      ? 'degraded'
      : 'healthy';
  return { at: now.toISOString(), integrationId: integ.id, flowType: integ.flowType, health, signals };
}

/** Latest persisted monitoring facts for an integration (null if never monitored). */
export async function latestMonitoring(db: Db, integrationId: string): Promise<MonitoringFacts | null> {
  const [row] = await db
    .select()
    .from(observations)
    .where(and(eq(observations.integrationId, integrationId), eq(observations.kind, 'monitoring')))
    .orderBy(desc(observations.createdAt))
    .limit(1);
  return (row?.data as MonitoringFacts | undefined) ?? null;
}

const stateKey = (f: MonitoringFacts) => f.signals.map((s) => `${s.signal}:${s.state}`).join('|');

/**
 * Evaluates, persists on change, updates health, and opens a reauthorization event when an authorization
 * was lost. Returns the facts and whether anything changed.
 */
export async function monitorIntegration(
  db: Db,
  integ: typeof integrations.$inferSelect,
  descriptor: IntegrationDescriptor,
  probe: Probe | null,
): Promise<{ facts: MonitoringFacts; changed: boolean; reauthorizationEventId: string | null }> {
  const facts = await evaluateSignals(db, integ, descriptor, probe);
  const prev = await latestMonitoring(db, integ.id);
  const changed = !prev || stateKey(prev) !== stateKey(facts);
  if (changed) {
    const attention = facts.signals.filter((s) => s.state === 'attention' || s.state === 'failing');
    await db.insert(observations).values({
      tenantId: integ.tenantId,
      integrationId: integ.id,
      provider: 'internal',
      kind: 'monitoring',
      message: attention.length
        ? `Monitoring: ${attention.map((s) => `${s.signal} ${s.state}`).join(', ')}`
        : 'Monitoring: all signals ok',
      data: facts as unknown as Record<string, unknown>,
    });
  }
  await db
    .update(integrations)
    .set({ health: facts.health, updatedAt: new Date() })
    .where(eq(integrations.id, integ.id));
  let reauthorizationEventId: string | null = null;
  const lost = probe?.credentials.filter((c) => c.state === 'expired' || c.state === 'revoked') ?? [];
  if (lost.length && describedSignals(descriptor).has('credentials')) {
    reauthorizationEventId = (await openReauthorizationEvent(db, integ, descriptor, lost)).id;
  }
  return { facts, changed, reauthorizationEventId };
}

const providerName = (d: IntegrationDescriptor, id: string) =>
  d.source.id === id ? d.source.name : d.destination.id === id ? d.destination.name : id;

/** One open event per integration: the customer must reconnect; work is held, not lost. */
export async function openReauthorizationEvent(
  db: Db,
  integ: typeof integrations.$inferSelect,
  descriptor: IntegrationDescriptor,
  lost: CredentialState[],
) {
  const names = lost.map((c) => providerName(descriptor, c.provider)).join(' and ');
  const { incident } = await openMaintenanceEvent(db, {
    tenantId: integ.tenantId,
    integrationId: integ.id,
    kind: 'connection_auth',
    severity: 'high',
    title: `${names} authorization lost`,
    reason: lost.map((c) => `${c.provider}: ${c.state} (${c.detail})`).join('; '),
    customerSummary: `Your ${names} connection needs to be renewed. ${descriptor.transactions.many[0]!.toUpperCase()}${descriptor.transactions.many.slice(1)} are held safely until then.`,
    customerNote: `Our access to ${names} stopped working (${lost.map((c) => c.state).join(', ')}). We hold every ${descriptor.transactions.one} safely until you reconnect; nothing is lost.`,
    customerAction: `Reconnect ${names}.`,
    classifyAs: 'requires_action',
    classificationNote: 'Authorization lost; only the customer can grant it again.',
    finding: {
      kind: 'authorization_lost',
      providers: lost,
      detectedAt: new Date().toISOString(),
      detector: 'monitoring (provider probe)',
    },
  });
  return incident;
}

/** Open reauthorization events, for the integration-specific recovery driver. */
export async function openReauthorizationEvents(db: Db, flowTypes: string[]) {
  if (!flowTypes.length) return [];
  return db
    .select({ id: incidents.id, integrationId: incidents.integrationId })
    .from(incidents)
    .innerJoin(integrations, eq(integrations.id, incidents.integrationId))
    .where(
      and(
        eq(incidents.kind, 'connection_auth'),
        ne(incidents.status, 'resolved'),
        inArray(integrations.flowType, flowTypes),
      ),
    );
}
