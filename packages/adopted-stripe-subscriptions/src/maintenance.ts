/**
 * Maintenance of the Stripe-dependent application when its PROVIDER changes (provider_contract_change).
 *
 *   detect     the application answered 200 but its record differs from what Stripe states, and the event's
 *              shape drifted from the first one seen for its type (contract_observations): both are facts;
 *   impact     which records, which fields, which operations; what is unaffected;
 *   correct    a reviewed patch from the catalog that addresses this provider contract (else: unsupported,
 *              escalated); validated by replaying this customer's own events before/after;
 *   activate   a change to the customer's application code is activated by an operator (the event waits);
 *   recover    every affected event runs again through the application's OWN processor on the corrected
 *              artifact (its webhook route would dedupe them: they were "processed"); events Stripe has that we
 *              never received are recovered from the Events API and run through the application;
 *   verify     every record of the period is read back against Stripe itself (live); accounting with the shared
 *              zero-loss rule; resolution only through the shared guard.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { adaptations, contractObservations, deliveries, deliveryAttempts, incidents, integrations, type Db } from '@mi/database';
import type { CredentialCipher, ProviderEndpointConfig } from '@mi/integration-shopify-netsuite';
import {
  acceptContract,
  accountTransactions,
  escalate,
  MAINTENANCE_ACTOR,
  note,
  openMaintenanceEvent,
  progressOf,
  recordAdaptation,
  recordPostActivation,
  setFacts,
  setProgress,
  type PopulationItem,
  type WorkServices,
} from '@mi/managed';
import { describeError } from '@mi/observability';
import { stripeFor } from '@mi/provider-connections';
import { resolutionBlockers, transitionIncident, type IncidentRow } from '@mi/reliability';
import { proposeAppPatch, validateAppAdaptation } from './adaptation.ts';
import { patchCatalog } from './artifact.ts';
import { APP_EVENT_TYPES } from './contract.ts';
import { executeAppDelivery, payloadOf, type StripeEventPayload } from './execute.ts';
import { instanceFor } from './host.ts';
import { recordAppEvent } from './ingest.ts';
import { STRIPE_SUBSCRIPTIONS_APP } from './provenance.ts';
import { compare, expectationOf, type Mismatch } from './verify.ts';

export interface AppMaintainDeps {
  db: Db;
  cipher: CredentialCipher;
  endpoints: ProviderEndpointConfig;
  services: WorkServices;
}
interface Progress {
  phase: 'correct' | 'await_activation' | 'recover' | 'verify';
  adaptationId: string;
  window: { from: string; to: string };
  recovered: string[];
  discovered: string[];
}
type Advance = { state: 'continue' | 'wait' | 'escalated' | 'resolved' | 'noop'; detail: string };

const CONTRACT = 'webhook event payload';

/** Opens (or joins) the provider-change event for a delivery whose verification failed. */
export async function recordProviderChange(db: Db, deliveryId: string, mismatches: Mismatch[]) {
  const [d] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, d!.integrationId));
  const contracts = await driftedContracts(db, integ!.id);
  const { incident, created } = await openMaintenanceEvent(db, {
    tenantId: integ!.tenantId,
    integrationId: integ!.id,
    kind: 'provider_contract_change',
    severity: 'high',
    title: 'Stripe changed the events your application reads',
    reason: `Verification failed for ${d!.sourceName}: ${mismatches.map((m) => m.field).join(', ')}`,
    customerSummary: 'Stripe now sends some details in a different place, so your application recorded them incorrectly.',
    customerNote: 'We noticed your application recorded some Stripe details incorrectly, and we are correcting it.',
    classifyAs: 'investigating',
    classificationNote: 'Provider contract drift with failed verification',
    boundary: 'provider',
    provider: 'stripe',
    finding: {
      provider: 'stripe',
      contract: CONTRACT,
      observed: { apiVersion: contracts[0]?.observedVersion ?? null },
      expected: { apiVersion: contracts[0]?.baselineVersion ?? null },
      contracts,
      mismatches: mismatches.slice(0, 20),
      firstTransaction: d!.sourceName,
      detectedAt: new Date().toISOString(),
    },
  });
  if (!created) await note(db, incident, `Also affected: ${d!.sourceName}`, false, { deliveryId });
  return incident;
}


/** Every Stripe object representation that drifted from its baseline: fields removed and added, versions. */
export async function driftedContracts(db: Db, integrationId: string) {
  const obs = await db
    .select()
    .from(contractObservations)
    .where(and(eq(contractObservations.integrationId, integrationId), eq(contractObservations.provider, 'stripe')))
    .orderBy(asc(contractObservations.firstSeenAt));
  const drifted = obs.filter((o) => o.status === 'observed');
  const fieldsOf = (o: (typeof obs)[number] | undefined) =>
    new Set([
      ...(((o?.sample as { shape?: { fields?: string[] } })?.shape?.fields) ?? []),
      ...((((o?.sample as { shape?: { itemFields?: string[] | null } })?.shape?.itemFields) ?? []).map((f) => `items.data[].${f}`)),
    ]);
  const contracts = drifted.map((o) => {
    const base = obs.find((b) => b.contract === o.contract && b.status === 'baseline');
    const was = fieldsOf(base);
    const now = fieldsOf(o);
    return {
      contract: o.contract,
      baselineVersion: base?.version ?? null,
      observedVersion: o.version,
      removed: [...was].filter((f) => !now.has(f)).sort(),
      added: [...now].filter((f) => !was.has(f)).sort(),
      firstSeenAt: o.firstSeenAt.toISOString(),
    };
  });
  return contracts;
}

async function affected(db: Db, integrationId: string) {
  return db
    .select()
    .from(deliveries)
    .where(and(eq(deliveries.integrationId, integrationId), eq(deliveries.outcome, 'failed'), eq(deliveries.lastErrorClass, 'verification')))
    .orderBy(asc(deliveries.sourceCreatedAt));
}

export async function advanceAppMaintenance(deps: AppMaintainDeps, incidentId: string): Promise<Advance> {
  const { db } = deps;
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!inc || inc.status === 'resolved') return { state: 'noop', detail: 'nothing to do' };
  if (inc.kind !== 'provider_contract_change') return { state: 'noop', detail: `not handled: ${inc.kind}` };
  const prog = progressOf<Progress>(inc);
  if ((inc.evidence as { maintenance?: { escalated?: string } }).maintenance?.escalated)
    return { state: 'escalated', detail: 'waiting for an operator' };
  const integrationId = inc.integrationId!;

  // The impact is a living fact until the correction activates: events still arriving can widen it.
  if (!inc.impactAssessment || prog.phase === 'await_activation') {
    const rows = await affected(db, integrationId);
    const fields = [...new Set(rows.flatMap((r) => ((r.validation as { mismatches?: Mismatch[] }).mismatches ?? []).map((m) => m.field)))];
    await setFacts(db, inc.id, {
      impactAssessment: {
        boundary: 'provider',
        provider: 'stripe',
        contract: CONTRACT,
        contracts: await driftedContracts(db, integrationId),
        affectedRecords: rows.map((r) => r.sourceName),
        fields,
        operations: ['webhook processing: src/webhooks/stripeEventProcessor.ts (the application’s own records)'],
        codePath: 'src/webhooks/stripeEventProcessor.ts reads sub.current_period_end, inv.subscription, inv.paid',
        unaffected:
          'Checkout Sessions and PaymentIntents the application creates (its client sends its pinned API version 2025-02-24.acacia); events whose payload still carries the old fields',
        assessedAt: new Date().toISOString(),
      },
    });
    if (!inc.impactAssessment) {
      await setProgress(db, inc.id, {
        phase: 'correct',
        window: { from: new Date((rows[0]?.sourceCreatedAt ?? new Date()).getTime() - 3600_000).toISOString(), to: '' },
        recovered: [],
        discovered: [],
      });
      return { state: 'continue', detail: 'impact assessed' };
    }
  }

  if ((prog.phase ?? 'correct') === 'correct') {
    const finding = inc.finding as { contract: string };
    const candidate = patchCatalog().find((p) => p.addresses.provider === 'stripe' && p.addresses.contract === finding.contract);
    if (!candidate) {
      await recordAdaptation(db, {
        integrationId,
        maintenanceEventId: inc.id,
        kind: 'unsupported',
        boundary: 'provider',
        provider: 'stripe',
        artifact: { repository: STRIPE_SUBSCRIPTIONS_APP.repository, commit: STRIPE_SUBSCRIPTIONS_APP.commit },
        dependency: { provider: 'stripe', contract: finding.contract },
        codePath: {},
        spec: { reason: 'no reviewed correction addresses this provider change' },
        rationale: 'No reviewed correction addresses this provider change',
        actor: MAINTENANCE_ACTOR,
      });
      return escalate(db, inc, 'no reviewed correction addresses this Stripe change (unsupported)');
    }
    const proposed = await proposeAppPatch(db, {
      integrationId,
      patchId: candidate.id,
      actor: MAINTENANCE_ACTOR,
      reason: 'Proposed by maintenance for the observed Stripe contract change.',
      maintenanceEventId: inc.id,
    });
    const v = await validateAppAdaptation(db, deps.cipher, proposed.id);
    await setFacts(db, inc.id, { validation: { ...(v.validation as object), adaptationId: v.id } });
    if (v.status !== 'validated') return escalate(db, inc, `correction ${candidate.id} failed validation`);
    await setProgress(db, inc.id, { phase: 'await_activation', adaptationId: v.id });
    await note(db, inc, `Correction ${candidate.id} validated; it changes your application’s code, so an operator activates it.`, false, { adaptationId: v.id });
    return { state: 'wait', detail: 'validated; awaiting operator activation' };
  }

  if (prog.phase === 'await_activation') {
    const [a] = await db.select().from(adaptations).where(eq(adaptations.id, prog.adaptationId!));
    if (a?.status === 'rejected' || a?.status === 'rolled_back') return escalate(db, inc, `correction ${a.status}`);
    if (a?.status !== 'active') return { state: 'wait', detail: 'awaiting operator activation' };
    await setFacts(db, inc.id, {
      correction: {
        adaptationId: a.id,
        kind: 'patch',
        patchId: (a.spec as { patchId: string }).patchId,
        boundary: 'application code (reviewed patch on a content-addressed copy; the pinned files are unchanged)',
        upstreamModified: false,
        derivedAt: a.createdAt.toISOString(),
        activatedAt: a.activatedAt!.toISOString(),
      },
    });
    // The drifted variants are now answered: they become accepted contract variants (history kept).
    const drifted = await db
      .select()
      .from(contractObservations)
      .where(and(eq(contractObservations.integrationId, integrationId), eq(contractObservations.status, 'observed'), eq(contractObservations.provider, 'stripe')));
    for (const o of drifted) await acceptContract(db, integrationId, o.contract, o.fingerprint);
    await setProgress(db, inc.id, { phase: 'recover' });
    await note(db, inc, 'The correction is active. Your application’s records are being corrected.', true, { step: 'corrected' });
    return { state: 'continue', detail: 'correction active' };
  }

  if (prog.phase === 'recover') {
    const inst = await instanceFor(deps, integrationId);
    const recovered: string[] = [...(prog.recovered ?? [])];
    for (const d of await affected(db, integrationId)) {
      const { event } = await payloadOf(db, deps.cipher, d.receiptId!);
      const startedAt = new Date();
      await inst.processStripeEvent(event);
      const x = expectationOf(event.data.object);
      const mm = x ? compare(x, await inst.store.get(x.model, x.key)) : [];
      const ok = mm.length === 0;
      await db.transaction(async (tx) => {
        await tx
          .update(deliveries)
          .set({
            outcome: ok ? 'delivered' : 'failed',
            lastErrorClass: ok ? null : 'verification',
            lastError: ok ? null : `still differs: ${mm.map((m) => m.field).join(', ')}`,
            validation: ok ? { verified: true, recoveredBy: inc.id } : { mismatches: mm },
            ...(ok ? { deliveredAt: new Date() } : {}),
            updatedAt: new Date(),
          })
          .where(eq(deliveries.id, d.id));
        await tx.insert(deliveryAttempts).values({
          deliveryId: d.id,
          attemptNo: d.attempts + 1,
          outcome: ok ? 'delivered' : 'failed',
          errorClass: ok ? null : 'verification',
          implementationVersionId: inst.artifact.id,
          evidence: { trigger: { kind: 'maintenance_recovery', maintenanceEventId: inc.id }, artifact: inst.artifact.id, via: 'processStripeEvent', mismatches: mm },
          startedAt,
          finishedAt: new Date(),
        });
      });
      if (ok) recovered.push(d.id);
    }
    // Completeness against Stripe: every event of the period Stripe has must be one the application received.
    const window = { from: new Date(prog.window!.from), to: new Date() };
    const discovered: string[] = [...(prog.discovered ?? [])];
    try {
      const listed = await listStripeEvents(deps, inc.tenantId!, window);
      const [integ] = await db.select().from(integrations).where(eq(integrations.id, integrationId));
      const known = new Set(
        (await db.select({ s: deliveries.sourceId }).from(deliveries).where(eq(deliveries.integrationId, integrationId))).map((r) => r.s),
      );
      for (const e of listed.filter((x) => !known.has(x.id))) {
        const r = await recordAppEvent(db, deps.cipher, integ!, e, Buffer.from(JSON.stringify(e)), 'reconciliation');
        if (r.deliveryId) {
          await executeAppDelivery({ ...deps, deliveryId: r.deliveryId, trigger: { kind: 'maintenance_recovery', maintenanceEventId: inc.id } });
          discovered.push(e.id);
        }
      }
      await setProgress(db, inc.id, { phase: 'verify', recovered, discovered, window: { from: window.from.toISOString(), to: window.to.toISOString() } });
    } catch (err) {
      await setProgress(db, inc.id, { recovered });
      return { state: 'wait', detail: `Stripe Events API unavailable: ${describeError(err).message}` };
    }
    return { state: 'continue', detail: `recovered ${recovered.length}, discovered ${discovered.length}` };
  }

  // verify: every record of the period read back against Stripe itself.
  const window = { from: new Date(prog.window!.from), to: new Date(prog.window!.to) };
  let listed: StripeEventPayload[];
  try {
    listed = await listStripeEvents(deps, inc.tenantId!, window);
  } catch (err) {
    return { state: 'wait', detail: `Stripe unavailable: ${describeError(err).message}` };
  }
  const ids = listed.map((e) => e.id);
  const rows = ids.length
    ? await db.select().from(deliveries).where(and(eq(deliveries.integrationId, integrationId), inArray(deliveries.sourceId, ids)))
    : [];
  const attempts = rows.length
    ? await db.select().from(deliveryAttempts).where(inArray(deliveryAttempts.deliveryId, rows.map((r) => r.id)))
    : [];
  const inst = await instanceFor(deps, integrationId);
  const stripe = await stripeFor(db, deps.cipher, deps.endpoints, inc.tenantId!);
  const live = new Map<string, Record<string, unknown>>();
  const items: PopulationItem[] = [];
  for (const e of listed) {
    const d = rows.find((r) => r.sourceId === e.id);
    const objId = String(e.data.object['id']);
    const kind = String(e.data.object['object']);
    let verification: PopulationItem['verification'] = null;
    if (['subscription', 'invoice', 'payment_intent'].includes(kind)) {
      if (!live.has(objId))
        live.set(
          objId,
          (kind === 'subscription'
            ? await stripe.sdk.subscriptions.retrieve(objId)
            : kind === 'invoice'
              ? await stripe.sdk.invoices.retrieve(objId)
              : await stripe.sdk.paymentIntents.retrieve(objId)) as unknown as Record<string, unknown>,
        );
      const x = expectationOf(live.get(objId)!)!;
      const mm = compare(x, await inst.store.get(x.model, x.key));
      verification = { verified: mm.length === 0, records: 1, detail: mm.length ? `differs from Stripe: ${mm.map((m) => m.field).join(', ')}` : `${x.model} equals Stripe (${Object.keys(x.fields).join(', ')})` };
    } else verification = { verified: d?.outcome === 'delivered', records: d ? 1 : 0, detail: 'no record kept by the application for this event (received and acknowledged)' };
    items.push({
      sourceId: e.id,
      label: d?.sourceName ?? e.type,
      reference: objId,
      excluded: null,
      delivered: d?.outcome === 'delivered',
      discovered: (prog.discovered ?? []).includes(e.id),
      attemptOutcomes: attempts.filter((a) => a.deliveryId === d?.id).map((a) => a.outcome),
      deliveredAt: d?.deliveredAt ?? null,
      verification,
    });
  }
  const affectedIds = (prog.recovered ?? []).length
    ? (await db.select({ s: deliveries.sourceId }).from(deliveries).where(inArray(deliveries.id, prog.recovered!))).map((r) => r.s)
    : [];
  const accounting = accountTransactions({
    window,
    sourceRunId: `stripe-events:${window.from.toISOString()}..${window.to.toISOString()}`,
    readCompletely: true,
    items,
    affectedSourceIds: affectedIds,
    detectedAt: new Date((inc.finding as { detectedAt: string }).detectedAt),
  });
  await setFacts(db, inc.id, { accounting });
  const evidence = {
    passed: accounting.zeroLoss,
    population: accounting.population,
    transactionsVerified: accounting.verified,
    duplicates: accounting.duplicates,
    method: 'Stripe Events API for the period; every record the application keeps read back against Stripe (live retrieve)',
  };
  const [fresh] = await db.select().from(incidents).where(eq(incidents.id, inc.id));
  const blockers = resolutionBlockers(fresh!, evidence);
  if (blockers.length) return escalate(db, fresh!, `not resolved: ${blockers.join('; ')}`);
  let cur: IncidentRow = fresh!;
  for (const s of ['recovery', 'verification'] as const)
    if (cur.status !== s && cur.status !== 'verification')
      cur = await transitionIncident(db, inc.id, s, { actor: MAINTENANCE_ACTOR, note: s === 'recovery' ? 'Recovery in progress' : 'Verifying against Stripe', customerVisible: false });
  await transitionIncident(db, inc.id, 'resolved', {
    actor: MAINTENANCE_ACTOR,
    note: `All ${accounting.verified} Stripe events of the affected period are recorded by your application exactly as Stripe states them.`,
    resolution: 'Reviewed correction activated; affected records re-processed by the application and verified against Stripe.',
    verification: evidence,
    evidence: { step: 'verified', verified: accounting.verified },
  });
  if (prog.adaptationId)
    await recordPostActivation(db, prog.adaptationId, { maintenanceEventId: inc.id, verifiedAt: new Date().toISOString(), population: accounting.population, verified: accounting.verified, unresolved: accounting.unresolved, duplicates: accounting.duplicates, zeroLoss: accounting.zeroLoss });
  return { state: 'resolved', detail: 'verified' };
}

/** Stripe's own list of the events of a period (the population), as the application's endpoint receives them. */
async function listStripeEvents(deps: AppMaintainDeps, tenantId: string, w: { from: Date; to: Date }) {
  const stripe = await stripeFor(deps.db, deps.cipher, deps.endpoints, tenantId);
  const out: StripeEventPayload[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await stripe.sdk.events.list({
      created: { gte: Math.floor(w.from.getTime() / 1000), lte: Math.ceil(w.to.getTime() / 1000) },
      types: [...APP_EVENT_TYPES],
      limit: 100,
      ...(after ? { starting_after: after } : {}),
    });
    out.push(...(page.data as unknown as StripeEventPayload[]));
    if (!page.has_more) break;
    after = page.data.at(-1)!.id;
  }
  return out.reverse();
}
