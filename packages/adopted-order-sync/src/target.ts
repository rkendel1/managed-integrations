/**
 * Slice 7 — a TARGET-side change on Shopify → NetSuite that the adopted code cannot meet: the NetSuite account
 * becomes OneWorld and refuses every sales order without a subsidiary ("Please enter value(s) for:
 * Subsidiary"). The adopted adapter cannot send one at all. Three corrections, one maintenance event:
 *
 *   decision       which subsidiary the store's orders belong to — a business choice: the customer's;
 *   configuration  that choice, in the integration's versioned configuration (applied/reverted by hooks);
 *   patch          reviewed p0002: the adopted adapter accepts a subsidiaryId option and sends it
 *                  (operator activation: it changes the adopted code's behaviour).
 *
 * Validation is WHOLE-PATH: each held order goes through the adoption boundary (active source adapters), the
 * adopted mapping and the patched adapter against a recording NetSuite double that answers the customer's own
 * look-ups; the request must equal the unpatched one plus exactly the chosen subsidiary. Held orders are
 * released only when no other change of this integration still awaits its correction (blockingEvents): a
 * source change and this target change are corrected together or not at all.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, asc, eq, gte, inArray, ne } from 'drizzle-orm';
import { adaptations, deliveries, incidents, integrations, webhookReceipts, type Db } from '@mi/database';
import type { CredentialCipher } from '@mi/integration-shopify-netsuite';
import {
  accountTransactions,
  blockingEvents,
  CheckList,
  escalate,
  MAINTENANCE_ACTOR,
  note,
  openMaintenanceEvent,
  progressOf,
  recordAdaptation,
  recordValidation,
  requestDecision,
  setFacts,
  setProgress,
  startValidation,
  type DecisionSpec,
  type PopulationItem,
} from '@mi/managed';
import { resolutionBlockers, transitionIncident, type IncidentRow } from '@mi/reliability';
import { activateAdaptation, evaluateInput, payloadOf, runtimeFor, type SubsidiaryConfigSpec } from './adaptation.ts';
import { loadArtifact, patchCatalog } from './artifact.ts';
import { AdoptedConfigSchema } from './contract.ts';
import { ADOPTED } from './provenance.ts';
import type { AdoptedClients } from './reconcile.ts';

export const TARGET_KIND = 'target_contract_change' as const;
const CONTRACT = 'salesOrder write: required fields';
const BASE_ARTIFACT = { repository: ADOPTED.repository, commit: ADOPTED.commit, package: ADOPTED.packageName };

type Advance = { state: 'continue' | 'wait' | 'escalated' | 'resolved' | 'noop'; detail: string };
export interface TargetDeps {
  db: Db;
  cipher: CredentialCipher;
  clients: AdoptedClients;
  enqueueExecution(deliveryId: string, trigger: { kind: 'maintenance_recovery'; maintenanceEventId: string; reason: string }): Promise<void>;
  enqueueMaintenance?(incidentId: string): Promise<void>;
}
interface Progress {
  phase: 'decide' | 'configure' | 'patch' | 'await_activation' | 'release' | 'await_release' | 'verify';
  decisionId: string;
  configurationId: string;
  patchAdaptationId: string;
  released: string[];
  waitingFor: string[];
}

/** A NetSuite refusal for a field the adopted code does not send: one open event per integration. */
export async function recordTargetRequirement(db: Db, deliveryId: string, requiredField: string, message: string) {
  const [d] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, d!.integrationId));
  const { incident, created } = await openMaintenanceEvent(db, {
    tenantId: integ!.tenantId,
    integrationId: integ!.id,
    kind: TARGET_KIND,
    severity: 'high',
    title: `NetSuite now requires ${requiredField} on sales orders`,
    reason: message,
    customerSummary: `NetSuite now requires a ${requiredField.toLowerCase()} on every sales order. Orders are held safely until it is set.`,
    customerNote: `NetSuite started refusing your orders because it now requires a ${requiredField.toLowerCase()}. We are holding every order safely; nothing is lost.`,
    classifyAs: 'investigating',
    classificationNote: 'Target contract change (required field)',
    boundary: 'target',
    provider: 'netsuite',
    finding: {
      provider: 'netsuite',
      contract: CONTRACT,
      requiredField,
      observed: { message },
      firstTransaction: d!.sourceName,
      detectedAt: new Date().toISOString(),
    },
  });
  if (!created) await note(db, incident, `Also held: ${d!.sourceName}`, false, { deliveryId });
  return incident;
}

async function heldFor(db: Db, integrationId: string) {
  return db.select().from(deliveries).where(and(eq(deliveries.integrationId, integrationId), eq(deliveries.outcome, 'held'))).orderBy(asc(deliveries.createdAt));
}

/** The request the adapter would send for a canonical order: run against a recording NetSuite double. */
async function recordedRequests(
  modules: Awaited<ReturnType<typeof loadArtifact>>['modules'],
  orders: unknown[],
  lookups: { customers: { id: string; entityid: string }[]; items: { id: string; itemid: string }[] },
  subsidiaryId: string | undefined,
) {
  const bodies: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.includes('/query/v1/suiteql')) {
        const q = String((JSON.parse(raw) as { q: string }).q);
        const lit = [...q.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'"));
        const items = /FROM customer/.test(q)
          ? lookups.customers.filter((c) => lit.includes(c.entityid))
          : lookups.items.filter((i) => lit.includes(i.itemid));
        res.end(JSON.stringify({ items, hasMore: false }));
        return;
      }
      bodies.push(JSON.parse(raw));
      res.statusCode = 204;
      res.setHeader('location', `/services/rest/record/v1/salesOrder/${9000 + bodies.length}`);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const o of orders)
      await modules.syncOrder(modules.createNetSuiteAdapter({ baseUrl, accessToken: 'validation', ...(subsidiaryId ? { subsidiaryId } : {}) }), o);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  return bodies;
}

/** Whole-path validation of the reviewed patch with the configured subsidiary. */
export async function validateTargetPatch(deps: TargetDeps, adaptationId: string, subsidiaryId: string) {
  const { db } = deps;
  const row = await startValidation(db, adaptationId);
  const patch = patchCatalog().find((p) => p.id === (row.spec as { patchId: string }).patchId)!;
  const checks = new CheckList();
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, row.integrationId));
  const config = AdoptedConfigSchema.parse(integ!.config);
  const current = await runtimeFor(db, row.integrationId); // includes active source adapters
  const after = await loadArtifact([...current.artifact.patches.map((p) => patchCatalog().find((x) => x.id === p.id)!), patch]);
  // Held orders, through the WHOLE path: adoption boundary (adapters) → adopted mapping → adapter.
  const held = await heldFor(db, row.integrationId);
  const orders: unknown[] = [];
  const notMappable: string[] = [];
  for (const d of held) {
    const [r] = await db.select().from(webhookReceipts).where(eq(webhookReceipts.id, d.receiptId!));
    const input = evaluateInput(await payloadOf(deps.cipher, r!), current);
    if (input.violations.length) {
      notMappable.push(d.sourceName);
      continue;
    }
    orders.push(after.modules.toCanonicalOrder(input.payload, { customerByEmail: config.customerByEmail, defaultCustomer: config.defaultCustomer }));
  }
  checks.add(
    'every held order passes the whole path (source boundary and mapping)',
    held.length ? notMappable.length === 0 : null,
    held.length ? (notMappable.length ? `not yet mappable: ${notMappable.join(', ')}` : `${orders.length}/${held.length} held orders`) : 'no held orders',
  );
  // The customer's own look-ups, read-only from NetSuite.
  const codes = (o: unknown) => o as { customerCode: string; lines: { sku: string }[] };
  const inList = (v: string[]) => v.map((x) => `'${x.replace(/'/g, "''")}'`).join(', ') || "''";
  const customers = await deps.clients.netsuite.suiteqlAll<{ id: string; entityid: string }>(`SELECT id, entityid FROM customer WHERE entityid IN (${inList([...new Set(orders.map((o) => codes(o).customerCode))])})`, []);
  const items = await deps.clients.netsuite.suiteqlAll<{ id: string; itemid: string }>(`SELECT id, itemid FROM item WHERE itemid IN (${inList([...new Set(orders.flatMap((o) => codes(o).lines.map((l) => l.sku)))])})`, []);
  const subs = await deps.clients.netsuite.suiteqlAll<{ id: string; name: string }>("SELECT id, name FROM subsidiary WHERE isinactive = 'F' ORDER BY id", []);
  checks.add('the chosen subsidiary is active in NetSuite', subs.some((s) => s.id === subsidiaryId), `${subsidiaryId}: ${subs.find((s) => s.id === subsidiaryId)?.name ?? 'not found'}`);
  const before = await recordedRequests(current.artifact.modules, orders, { customers, items }, undefined);
  const withSub = await recordedRequests(after.modules, orders, { customers, items }, subsidiaryId);
  const without = await recordedRequests(after.modules, orders, { customers, items }, undefined);
  const plusOnly = withSub.every((b, i) => {
    const { subsidiary, ...rest } = b as { subsidiary?: { id: string } };
    return subsidiary?.id === subsidiaryId && JSON.stringify(rest) === JSON.stringify(before[i]);
  });
  checks.add(
    'each request equals the original plus exactly the chosen subsidiary',
    orders.length ? plusOnly && withSub.length === orders.length : null,
    orders.length ? `${withSub.length}/${orders.length} requests` : 'nothing to replay',
  );
  checks.add('without a configured subsidiary the request is the original', JSON.stringify(without) === JSON.stringify(before), `${without.length} requests compared`);
  checks.add('rollback target loads', true, current.artifact.id);
  return recordValidation(db, adaptationId, checks.checks, { before: current.artifact.id, after: after.id });
}

export async function advanceTargetChange(deps: TargetDeps, incidentId: string): Promise<Advance> {
  const { db } = deps;
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!inc || inc.status === 'resolved') return { state: 'noop', detail: 'nothing to do' };
  const prog = progressOf<Progress>(inc);
  if ((inc.evidence as { maintenance?: { escalated?: string } }).maintenance?.escalated) return { state: 'escalated', detail: 'waiting for an operator' };
  const integrationId = inc.integrationId!;
  const f = inc.finding as { requiredField: string };

  if (!prog.phase) {
    const held = await heldFor(db, integrationId);
    await setFacts(db, inc.id, {
      impactAssessment: {
        boundary: 'target',
        provider: 'netsuite',
        contract: CONTRACT,
        requiredField: f.requiredField,
        affectedTransactions: held.map((d) => d.sourceName),
        operations: ['salesOrder upsert (PUT /record/v1/salesOrder/eid:…)'],
        codePath: 'src/adapters/netsuite.js builds the sales order body; it has no subsidiary option',
        unaffected: 'orders already in NetSuite keep their subsidiary; Shopify reads are unaffected',
      },
    });
    const subs = await deps.clients.netsuite.suiteqlAll<{ id: string; name: string }>("SELECT id, name FROM subsidiary WHERE isinactive = 'F' ORDER BY id", []);
    if (!subs.length) return escalate(db, inc, 'NetSuite lists no active subsidiary');
    const d = await requestDecision(db, {
      integrationId,
      maintenanceEventId: inc.id,
      boundary: 'target',
      provider: 'netsuite',
      question: 'NetSuite now needs to know which subsidiary your Shopify orders belong to. Which one?',
      options: subs.map((s) => ({ id: s.id, label: s.name })),
      authority: 'customer',
      rationale: 'Which legal entity a sale belongs to is a business decision: only the customer can make it',
      actor: MAINTENANCE_ACTOR,
      dependency: { provider: 'netsuite', contract: CONTRACT },
    });
    await db.update(incidents).set({ customerAction: 'Choose the subsidiary for your Shopify orders.', updatedAt: new Date() }).where(eq(incidents.id, inc.id));
    await transitionIncident(db, inc.id, 'requires_action', { actor: MAINTENANCE_ACTOR, note: 'Waiting for the customer to choose a subsidiary', customerVisible: false });
    await setProgress(db, inc.id, { phase: 'decide', decisionId: d.id });
    return { state: 'wait', detail: 'awaiting the customer’s decision' };
  }

  if (prog.phase === 'decide') {
    const [d] = await db.select().from(adaptations).where(eq(adaptations.id, prog.decisionId!));
    if (d?.status !== 'active') return { state: 'wait', detail: 'awaiting the customer’s decision' };
    const spec = d.spec as unknown as DecisionSpec;
    const [integ] = await db.select().from(integrations).where(eq(integrations.id, integrationId));
    const from = (integ!.config as { subsidiaryId?: string }).subsidiaryId ?? null;
    const cfg: SubsidiaryConfigSpec = { type: 'subsidiary', from, to: spec.choice!, name: spec.options.find((o) => o.id === spec.choice)?.label ?? spec.choice!, decisionId: d.id };
    const row = await recordAdaptation(db, {
      integrationId, maintenanceEventId: inc.id, kind: 'configuration', boundary: 'target', provider: 'netsuite',
      artifact: BASE_ARTIFACT, dependency: { provider: 'netsuite', contract: CONTRACT }, codePath: { configuration: 'subsidiaryId' },
      spec: cfg as unknown as Record<string, unknown>, rationale: `Create orders in ${cfg.name} (customer decision ${d.id})`, actor: MAINTENANCE_ACTOR,
    });
    const v = await startValidation(db, row.id);
    const subs = await deps.clients.netsuite.suiteqlAll<{ id: string }>("SELECT id, name FROM subsidiary WHERE isinactive = 'F' ORDER BY id", []);
    const checks = new CheckList();
    checks.add('decided by the customer', spec.choice === cfg.to, `decision ${d.id}`);
    checks.add('the subsidiary is active in NetSuite', subs.some((s) => s.id === cfg.to), cfg.name);
    checks.add('the original adopted code ignores the setting (safe before the patch)', true, 'createNetSuiteAdapter at the pinned commit takes { baseUrl, accessToken } only');
    const validated = await recordValidation(db, v.id, checks.checks, { before: `config:subsidiary=${from ?? 'none'}`, after: `config:subsidiary=${cfg.to}` });
    if (validated.status !== 'validated') return escalate(db, inc, 'the chosen subsidiary failed validation');
    await activateAdaptation(db, row.id, MAINTENANCE_ACTOR, `Customer decision ${d.id}`);
    await transitionIncident(db, inc.id, 'investigating', { actor: MAINTENANCE_ACTOR, note: 'Subsidiary chosen; preparing the code change', customerVisible: false }).catch(() => undefined);
    await db.update(incidents).set({ customerAction: null, updatedAt: new Date() }).where(eq(incidents.id, inc.id));
    await note(db, inc, `You chose ${cfg.name}. We are preparing and testing the change before switching it on.`, true, { step: 'decided' });
    await setProgress(db, inc.id, { phase: 'patch', configurationId: row.id });
    return { state: 'continue', detail: 'configuration active' };
  }

  if (prog.phase === 'patch') {
    // Whole-path validation: held orders must pass every boundary. While another change of this integration
    // (e.g. a Shopify payload change) still awaits its correction, they cannot — validation waits for it.
    const blocking = await blockingEvents(db, integrationId, inc.id);
    if (blocking.length) {
      const kinds = blocking.map((b) => b.kind);
      if (JSON.stringify(kinds) !== JSON.stringify(prog.waitingFor ?? []))
        await note(db, inc, `Validation waits for the other open change (${kinds.join(', ')}): the held orders must pass the whole path.`, false, { blocking: blocking.map((b) => b.id) });
      await setProgress(db, inc.id, { waitingFor: kinds });
      return { state: 'wait', detail: `validation waits for ${kinds.join(', ')}` };
    }
    const patch = patchCatalog().find((p) => 'requiredField' in p.addresses && p.addresses.requiredField === f.requiredField);
    if (!patch) return escalate(db, inc, `no reviewed correction sends ${f.requiredField}`);
    const row = await recordAdaptation(db, {
      integrationId, maintenanceEventId: inc.id, kind: 'patch', boundary: 'integration', provider: 'netsuite',
      artifact: BASE_ARTIFACT, dependency: { addresses: patch.addresses }, codePath: { file: patch.file, originalBehavior: patch.originalBehavior },
      spec: { patchId: patch.id, file: patch.file, baseSha256: patch.baseSha256, resultSha256: patch.resultSha256, find: patch.find, replace: patch.replace },
      rationale: `${patch.title}. Proposed by maintenance for NetSuite's new requirement.`, actor: MAINTENANCE_ACTOR,
    });
    const [cfgRow] = await db.select().from(adaptations).where(eq(adaptations.id, prog.configurationId!));
    const v = await validateTargetPatch(deps, row.id, (cfgRow!.spec as unknown as SubsidiaryConfigSpec).to);
    await setFacts(db, inc.id, { validation: { ...(v.validation as object), adaptationId: v.id } });
    if (v.status !== 'validated') return escalate(db, inc, `${patch.id} failed validation`);
    await setProgress(db, inc.id, { phase: 'await_activation', patchAdaptationId: v.id });
    await note(db, inc, 'We prepared and tested the change with your held orders. An engineer is reviewing it before we switch it on.', true, { step: 'reviewing' });
    return { state: 'wait', detail: 'validated; awaiting operator activation' };
  }

  if (prog.phase === 'await_activation') {
    const [p] = await db.select().from(adaptations).where(eq(adaptations.id, prog.patchAdaptationId!));
    if (p?.status === 'rejected' || p?.status === 'rolled_back') return escalate(db, inc, `correction ${p.status}`);
    if (p?.status !== 'active') return { state: 'wait', detail: 'awaiting operator activation' };
    await setFacts(db, inc.id, {
      correction: {
        kind: 'configuration+patch', decisionId: prog.decisionId, configurationId: prog.configurationId, adaptationId: p.id,
        patchId: (p.spec as { patchId: string }).patchId,
        boundary: 'target configuration (subsidiary) and a reviewed patch to the adopted adapter (content-addressed copy; pinned files unchanged)',
        upstreamModified: false, derivedAt: p.createdAt.toISOString(), activatedAt: p.activatedAt!.toISOString(),
      },
    });
    await setProgress(db, inc.id, { phase: 'release' });
    return { state: 'continue', detail: 'corrections active' };
  }

  if (prog.phase === 'release') {
    // Whole path or nothing: another change of this integration still awaiting its correction blocks release.
    const blocking = await blockingEvents(db, integrationId, inc.id);
    if (blocking.length) {
      const kinds = blocking.map((b) => b.kind);
      if (JSON.stringify(kinds) !== JSON.stringify(prog.waitingFor ?? []))
        await note(db, inc, `Held orders wait for the other open change (${kinds.join(', ')}) to be corrected too.`, false, { blocking: blocking.map((b) => b.id) });
      await setProgress(db, inc.id, { waitingFor: kinds });
      return { state: 'wait', detail: `waiting for ${kinds.join(', ')}` };
    }
    const released = await db
      .update(deliveries)
      .set({ outcome: 'pending', updatedAt: new Date() })
      .where(and(eq(deliveries.integrationId, integrationId), eq(deliveries.outcome, 'held')))
      .returning({ id: deliveries.id });
    if (inc.status !== 'recovery') await transitionIncident(db, inc.id, 'recovery', { actor: MAINTENANCE_ACTOR, note: 'We switched the fix on.', customerVisible: false }).catch(() => undefined);
    await setProgress(db, inc.id, { phase: 'await_release', released: [...(prog.released ?? []), ...released.map((r) => r.id)] });
    for (const r of released) await deps.enqueueExecution(r.id, { kind: 'maintenance_recovery', maintenanceEventId: inc.id, reason: 'Released after the NetSuite correction' });
    return { state: 'continue', detail: `released ${released.length}` };
  }

  if (prog.phase === 'await_release') {
    const rows = (prog.released ?? []).length ? await db.select().from(deliveries).where(inArray(deliveries.id, prog.released!)) : [];
    if (rows.some((r) => ['pending', 'running'].includes(r.outcome))) return { state: 'wait', detail: 'held orders executing' };
    await setProgress(db, inc.id, { phase: 'verify' });
    return { state: 'continue', detail: 'released orders ran' };
  }

  // verify: every order of the period read back from NetSuite — subsidiary, items, quantities, prices.
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, integrationId));
  const sub = (integ!.config as { subsidiaryId?: string }).subsidiaryId;
  const from = new Date(new Date((inc.finding as { detectedAt: string }).detectedAt).getTime() - 3600_000);
  const rows = await db.select().from(deliveries).where(and(eq(deliveries.integrationId, integrationId), gte(deliveries.createdAt, from))).orderBy(asc(deliveries.createdAt));
  const items: PopulationItem[] = [];
  for (const d of rows) {
    const rec = d.outcome === 'delivered' ? await deps.clients.netsuite.getSalesOrderByExternalId(`shopify-${d.sourceLegacyId}`) : null;
    const s = (rec?.['subsidiary'] as { id?: string } | undefined)?.id;
    // Orders written before the change keep whatever they were written with (never rewritten): they must
    // exist. Orders written since must be in the subsidiary the customer chose.
    const before = !!d.deliveredAt && d.deliveredAt < new Date((inc.finding as { detectedAt: string }).detectedAt) && !(prog.released ?? []).includes(d.id);
    const ok = !!rec && (before || s === sub);
    items.push({
      sourceId: d.sourceId, label: d.sourceName, reference: d.sourceLegacyId, excluded: d.outcome === 'rejected' ? `refused: ${d.lastError ?? ''}`.slice(0, 200) : null,
      delivered: d.outcome === 'delivered', discovered: false,
      attemptOutcomes: (prog.released ?? []).includes(d.id) ? ['held', d.outcome] : [d.outcome], deliveredAt: d.deliveredAt,
      verification: { verified: ok, records: rec ? 1 : 0, detail: ok ? `sales order in NetSuite${before ? ' (written before the change, unchanged)' : `, subsidiary ${s}`}` : rec ? `subsidiary ${s ?? 'none'}` : 'not in NetSuite' },
    });
  }
  const affected = (prog.released ?? []).length ? (await db.select({ s: deliveries.sourceId }).from(deliveries).where(inArray(deliveries.id, prog.released!))).map((r) => r.s) : [];
  const accounting = accountTransactions({ window: { from, to: new Date() }, sourceRunId: `orders-received:${from.toISOString()}`, readCompletely: true, items, affectedSourceIds: affected, detectedAt: new Date((inc.finding as { detectedAt: string }).detectedAt) });
  await setFacts(db, inc.id, { accounting });
  const evidence = { passed: accounting.zeroLoss, population: accounting.population, transactionsVerified: accounting.verified, duplicates: accounting.duplicates, method: 'every order received in the period read back from NetSuite by external id (subsidiary, existence)' };
  const [fresh] = await db.select().from(incidents).where(eq(incidents.id, inc.id));
  const blockers = resolutionBlockers(fresh!, evidence);
  if (blockers.length) return escalate(db, fresh!, `not resolved: ${blockers.join('; ')}`);
  if (fresh!.status !== 'verification') await transitionIncident(db, inc.id, 'verification', { actor: MAINTENANCE_ACTOR, note: 'Verifying in NetSuite', customerVisible: false }).catch(() => undefined);
  await transitionIncident(db, inc.id, 'resolved', {
    actor: MAINTENANCE_ACTOR,
    note: `NetSuite accepts your orders again. All ${accounting.verified} orders of the period are in NetSuite, in the subsidiary you chose.`,
    resolution: 'Customer chose the subsidiary; reviewed patch p0002 sends it; held orders released and verified.',
    verification: evidence,
    evidence: { step: 'verified', verified: accounting.verified },
  });
  // Other changes that waited on this one can continue.
  const others = await db.select({ id: incidents.id }).from(incidents).where(and(eq(incidents.integrationId, integrationId), ne(incidents.status, 'resolved'), ne(incidents.id, inc.id)));
  for (const o of others) await deps.enqueueMaintenance?.(o.id);
  return { state: 'resolved', detail: 'verified' };
}
