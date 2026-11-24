/**
 * Maintenance of the QuickBooks-dependent application.
 *
 *  connection_auth      QuickBooks authorization lost (invalid_grant): requests are held BEFORE anything is sent;
 *                       after the customer reconnects they run, and every request of the period is verified in
 *                       QuickBooks (provider-side change: the customer's authorization).
 *  application_change   the application's upstream released a change (here: v0.12.0, node-quickbooks 2.0.50):
 *                       impact from the executed files and dependencies; the reviewed change is validated by
 *                       replay, activated by an operator, and verified on real work before resolving.
 */
import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import { adaptations, deliveries, deliveryAttempts, incidents, integrations, type Db } from '@mi/database';
import type { CredentialCipher, ProviderEndpointConfig } from '@mi/integration-shopify-netsuite';
import {
  accountTransactions,
  escalate,
  MAINTENANCE_ACTOR,
  note,
  openMaintenanceEvent,
  progressOf,
  recordPostActivation,
  setFacts,
  setProgress,
  type PopulationItem,
  type WorkServices,
} from '@mi/managed';
import { describeError } from '@mi/observability';
import { AuthorizationLost, QuickBooksAccess } from '@mi/provider-connections';
import { resolutionBlockers, transitionIncident, type IncidentRow } from '@mi/reliability';
import { proposeDependencyChange, validateDependencyChange } from './adaptation.ts';
import { dependencyChangeCatalog } from './artifact.ts';
import { executeRequest, readInvoice, verifyInvoice, type InvoiceInput } from './invoke.ts';
import { QBO_TOOLS_APP } from './provenance.ts';

export interface QboMaintainDeps {
  db: Db;
  cipher: CredentialCipher;
  endpoints: ProviderEndpointConfig;
  services: WorkServices;
}
type Advance = { state: 'continue' | 'wait' | 'escalated' | 'resolved' | 'noop'; detail: string };

/** Every request of a period, each verified against QuickBooks now (the shared zero-loss rule). */
async function accountRequests(deps: QboMaintainDeps, inc: IncidentRow, from: Date, affected: string[]) {
  const rows = await deps.db
    .select()
    .from(deliveries)
    .where(and(eq(deliveries.integrationId, inc.integrationId!), gte(deliveries.createdAt, from)))
    .orderBy(asc(deliveries.createdAt));
  const attempts = rows.length ? await deps.db.select().from(deliveryAttempts).where(inArray(deliveryAttempts.deliveryId, rows.map((r) => r.id))) : [];
  const items: PopulationItem[] = [];
  for (const d of rows) {
    const input = (d.summary as { input: InvoiceInput }).input;
    const inv = d.destinationId ? await readInvoice(deps, inc.tenantId!, d.destinationId) : null;
    const v = verifyInvoice(input, inv);
    items.push({
      sourceId: d.sourceId,
      label: d.sourceName,
      reference: d.destinationId ?? d.sourceLegacyId,
      excluded: d.outcome === 'rejected' ? `refused by QuickBooks or the application: ${d.lastError ?? ''}`.slice(0, 200) : null,
      delivered: d.outcome === 'delivered',
      discovered: false,
      attemptOutcomes: attempts.filter((a) => a.deliveryId === d.id).map((a) => (a.outcome === 'awaiting_authorization' ? 'held' : a.outcome)),
      deliveredAt: d.deliveredAt,
      verification: { verified: v.verified, records: inv ? 1 : 0, detail: v.verified ? `invoice ${d.destinationId} in QuickBooks as requested` : v.problems.join('; ') },
    });
  }
  return accountTransactions({
    window: { from, to: new Date() },
    sourceRunId: `requests:${from.toISOString()}`,
    readCompletely: true,
    items,
    affectedSourceIds: affected,
    detectedAt: new Date((inc.finding as { detectedAt: string }).detectedAt),
  });
}

async function resolve(deps: QboMaintainDeps, inc: IncidentRow, accounting: ReturnType<typeof accountTransactions>, text: string, resolution: string) {
  const { db } = deps;
  await setFacts(db, inc.id, { accounting });
  const evidence = { passed: accounting.zeroLoss, population: accounting.population, transactionsVerified: accounting.verified, duplicates: accounting.duplicates, method: 'every request of the period: its invoice read back from QuickBooks by id' };
  const [fresh] = await db.select().from(incidents).where(eq(incidents.id, inc.id));
  const blockers = resolutionBlockers(fresh!, evidence);
  if (blockers.length) return escalate(db, fresh!, `not resolved: ${blockers.join('; ')}`);
  let cur: IncidentRow = fresh!;
  for (const s of ['recovery', 'verification'] as const)
    if (cur.status !== s && cur.status !== 'verification')
      cur = await transitionIncident(db, inc.id, s, { actor: MAINTENANCE_ACTOR, note: s === 'recovery' ? 'Recovery in progress' : 'Verifying in QuickBooks', customerVisible: false });
  await transitionIncident(db, inc.id, 'resolved', { actor: MAINTENANCE_ACTOR, note: text, resolution, verification: evidence, evidence: { step: 'verified', verified: accounting.verified } });
  return { state: 'resolved' as const, detail: 'verified' };
}

async function advanceReauthorization(deps: QboMaintainDeps, inc: IncidentRow): Promise<Advance> {
  const { db } = deps;
  const qbo = new QuickBooksAccess(db, deps.cipher, deps.endpoints, inc.tenantId!);
  try {
    const { creds } = await qbo.current();
    await qbo.query('select * from CompanyInfo');
    await setFacts(db, inc.id, {
      correction: { kind: 'reauthorization', boundary: 'provider authorization (OAuth 2.0); no code changed', provider: 'quickbooks', realmId: creds.realmId, activatedAt: new Date().toISOString() },
      validation: { passed: true, checks: [{ name: 'QuickBooks answers with the renewed authorization', status: 'passed', detail: 'CompanyInfo query succeeded' }] },
    });
  } catch (err) {
    if (err instanceof AuthorizationLost) return { state: 'wait', detail: 'waiting for the customer to reconnect QuickBooks' };
    return { state: 'wait', detail: `QuickBooks unavailable: ${describeError(err).message}` };
  }
  // Held requests sent nothing: they run now, once.
  const held = await db.select().from(deliveries).where(and(eq(deliveries.integrationId, inc.integrationId!), eq(deliveries.outcome, 'awaiting_authorization'))).orderBy(asc(deliveries.createdAt));
  const released = [...(progressOf<{ released: string[] }>(inc).released ?? [])];
  for (const d of held) {
    await executeRequest(deps, d.id, { kind: 'maintenance_recovery', maintenanceEventId: inc.id });
    released.push(d.sourceId);
  }
  await setProgress(db, inc.id, { released });
  const from = new Date(new Date((inc.finding as { detectedAt: string }).detectedAt).getTime() - 3600_000);
  const accounting = await accountRequests(deps, inc, from, released);
  return resolve(deps, inc, accounting, `QuickBooks is connected again. All ${accounting.verified} requests of the period created their invoice exactly once, as requested.`, 'Customer reconnected QuickBooks; held requests ran and were verified.');
}

/** Upstream released a reviewed change not yet applied to this customer's application: open the event. */
export async function checkUpstream(db: Db, integ: typeof integrations.$inferSelect) {
  const done = await db.select().from(adaptations).where(eq(adaptations.integrationId, integ.id));
  const seen = new Set(done.map((r) => (r.spec as { dependencyChangeId?: string }).dependencyChangeId).filter(Boolean));
  const next = dependencyChangeCatalog().find((c) => !seen.has(c.id));
  if (!next) return null;
  const { incident } = await openMaintenanceEvent(db, {
    tenantId: integ.tenantId,
    integrationId: integ.id,
    kind: 'application_change',
    severity: 'low',
    title: `quickbooks-mcp released v${QBO_TOOLS_APP.nextRelease.version}`,
    reason: next.reason,
    customerSummary: 'A new version of your QuickBooks tools was released. We are checking it before you use it.',
    customerNote: 'A new version of your QuickBooks tools was released. We check exactly what changed, test it with your own requests, and only then switch.',
    classifyAs: 'investigating',
    classificationNote: 'Upstream release of the adopted application',
    boundary: 'integration',
    finding: {
      upstream: { repository: QBO_TOOLS_APP.repository, from: { version: QBO_TOOLS_APP.version, commit: QBO_TOOLS_APP.commit }, to: QBO_TOOLS_APP.nextRelease },
      executedFilesChanged: [],
      dependencyChanges: [{ name: next.dependency, from: next.from, to: next.to }],
      evidence: next.evidence,
      change: next.id,
      detectedAt: new Date().toISOString(),
    },
  });
  return incident;
}

async function advanceApplicationChange(deps: QboMaintainDeps, inc: IncidentRow): Promise<Advance> {
  const { db } = deps;
  const prog = progressOf<{ phase: string; adaptationId: string }>(inc);
  const f = inc.finding as { change: string; dependencyChanges: { name: string; from: string; to: string }[] };
  if (!prog.phase) {
    await setFacts(db, inc.id, {
      impactAssessment: {
        boundary: 'integration',
        dependencies: f.dependencyChanges,
        executedFilesChanged: 0,
        operations: ['create_invoice: every request the application sends to QuickBooks (customer and item queries, invoice create)'],
        codePath: 'node_modules/node-quickbooks (the application’s QuickBooks client)',
        affected: 'requests made after activation',
        unaffected: 'invoices already created; the application’s own code (unchanged)',
      },
    });
    const proposed = await proposeDependencyChange(db, { integrationId: inc.integrationId!, changeId: f.change, actor: MAINTENANCE_ACTOR, reason: 'Proposed by maintenance for the upstream release.', maintenanceEventId: inc.id });
    let v;
    try {
      v = await validateDependencyChange(db, deps.cipher, deps.endpoints, proposed.id);
    } catch (err) {
      return { state: 'wait', detail: `validation could not run: ${describeError(err).message}` };
    }
    await setFacts(db, inc.id, { validation: { ...(v.validation as object), adaptationId: v.id } });
    if (v.status !== 'validated') return escalate(db, inc, `${f.change} failed validation`);
    await setProgress(db, inc.id, { phase: 'await_activation', adaptationId: v.id });
    await note(db, inc, `${f.change} validated with your own requests; an operator activates it.`, false, { adaptationId: v.id });
    return { state: 'wait', detail: 'validated; awaiting operator activation' };
  }
  const [a] = await db.select().from(adaptations).where(eq(adaptations.id, prog.adaptationId!));
  if (a?.status === 'rejected' || a?.status === 'rolled_back') return escalate(db, inc, `correction ${a.status}`);
  if (a?.status !== 'active') return { state: 'wait', detail: 'awaiting operator activation' };
  await setFacts(db, inc.id, { correction: { adaptationId: a.id, kind: 'patch', dependencyChangeId: f.change, boundary: 'application dependency set (artifact); the pinned files are unchanged', upstreamModified: false, derivedAt: a.createdAt.toISOString(), activatedAt: a.activatedAt!.toISOString() } });
  // Verified on real work: at least one request on the new artifact, read back from QuickBooks.
  const after = await db.select().from(deliveries).where(and(eq(deliveries.integrationId, inc.integrationId!), gte(deliveries.createdAt, a.activatedAt!)));
  if (!after.some((d) => d.outcome === 'delivered')) {
    await setProgress(db, inc.id, { phase: 'await_work' });
    return { state: 'wait', detail: 'waiting for a request on the new version' };
  }
  const accounting = await accountRequests(deps, inc, a.activatedAt!, []);
  const r = await resolve(deps, inc, accounting, `Your QuickBooks tools run the new version. ${accounting.verified} request(s) since then created their invoice as requested.`, `${f.change} activated and verified on real requests.`);
  if (r.state === 'resolved') await recordPostActivation(db, a.id, { maintenanceEventId: inc.id, verifiedAt: new Date().toISOString(), population: accounting.population, verified: accounting.verified, zeroLoss: accounting.zeroLoss });
  return r;
}

export async function advanceQboMaintenance(deps: QboMaintainDeps, incidentId: string): Promise<Advance> {
  const [inc] = await deps.db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!inc || inc.status === 'resolved') return { state: 'noop', detail: 'nothing to do' };
  if ((inc.evidence as { maintenance?: { escalated?: string } }).maintenance?.escalated) return { state: 'escalated', detail: 'waiting for an operator' };
  if (inc.kind === 'connection_auth') return advanceReauthorization(deps, inc);
  if (inc.kind === 'application_change') return advanceApplicationChange(deps, inc);
  return { state: 'noop', detail: `not handled: ${inc.kind}` };
}
