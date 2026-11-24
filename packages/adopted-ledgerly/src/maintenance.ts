/**
 * Maintenance for Stripe → QuickBooks (integration-specific drivers on the generic event, accounting and
 * correction lifecycle). Deterministic; every step idempotent so the job can be re-run after a crash.
 *
 *  connection_auth (lost authorization — opened by monitoring or by an execution that could not authenticate)
 *    wait for the customer to reconnect → validate the new authorization → release held transactions →
 *    reconcile the affected window (recover missing ones from the Stripe Events API) → independent second
 *    check → account for every transaction → resolve only if the persisted evidence allows it.
 *  dependency_contract_change (the pinned code declares a provider contract the provider retired)
 *    investigate (code path) → propose the reviewed patch → validate → wait for an operator to activate →
 *    verify recent transactions → account → resolve.
 *  input_contract_change (a Stripe object no longer has what the adopted code reads)
 *    no reviewed correction exists: recorded as UNSUPPORTED, transactions stay held, routed to a person.
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import {
  adaptations,
  deliveries,
  deliveryAttempts,
  incidents,
  integrations,
  reconciliationItems,
  reconciliationRuns,
  type Db,
} from '@mi/database';
import type { CredentialCipher, ProviderEndpointConfig } from '@mi/integration-shopify-netsuite';
import {
  accountTransactions,
  escalate,
  MAINTENANCE_ACTOR,
  note,
  openMaintenanceEvent,
  openReauthorizationEvent,
  progressOf,
  recordAdaptation,
  recordPostActivation,
  releaseDeliveries,
  setFacts,
  setProgress,
  type AdaptationValidation,
  type TransactionAccounting,
  type WorkServices,
} from '@mi/managed';
import { describeError } from '@mi/observability';
import { resolutionBlockers, transitionIncident, type IncidentRow } from '@mi/reliability';
import {
  BASE_ARTIFACT,
  DEPENDENCIES,
  locate,
  proposePatch,
  requestedMinorVersion,
  runtimeFor,
  validateLedgerlyAdaptation,
} from './adaptation.ts';
import { upstreamDir } from './artifact.ts';
import { LEDGERLY_FLOW_TYPE } from './contract.ts';
import { STRIPE_QUICKBOOKS } from './descriptor.ts';
import { QuickBooksAccess, loadConnection, stripeFor } from './providers.ts';
import { LedgerlyReconciliationBusy, recoverLedgerlyItem, startLedgerlyReconciliation } from './reconcile.ts';

export type LedgerlyAdvance = {
  state: 'continue' | 'wait' | 'escalated' | 'resolved' | 'noop';
  detail: string;
};
interface Progress {
  phase?: 'release' | 'await_release' | 'reconcile' | 'await_reconcile' | 'verify' | 'await_verify';
  released?: string[];
  reconcileRunId?: string;
  verifyRunId?: string;
  window?: { from: string; to: string };
  attempts?: number;
  escalated?: string;
  awaitingDecision?: boolean;
}
export interface MaintainDeps {
  db: Db;
  cipher: CredentialCipher;
  endpoints: ProviderEndpointConfig;
  services: WorkServices;
}

const plural = (n: number, w = 'transaction') => `${n} ${w}${n === 1 ? '' : 's'}`;
export const MIN_SERVED_MINOR_VERSION = 75;

/* ================================================================== detection */

/** Held work because an authorization was lost → one reauthorization event (generic, @mi/managed). */
export async function recordAuthorizationLost(
  db: Db,
  integrationId: string,
  provider: 'stripe' | 'quickbooks',
  detail: string,
) {
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, integrationId));
  return openReauthorizationEvent(db, integ!, STRIPE_QUICKBOOKS, [
    { provider, state: /revoked|invalid_grant/i.test(detail) ? 'revoked' : 'expired', detail },
  ]);
}

/** The pinned code declares a QuickBooks minor version Intuit no longer serves → a maintenance event. */
export async function checkDependencyContract(db: Db, integ: typeof integrations.$inferSelect) {
  const rt = await runtimeFor(db, integ.id);
  const declared = requestedMinorVersion(rt);
  if (declared === null || declared >= MIN_SERVED_MINOR_VERSION) return null;
  const dep = DEPENDENCIES[0]!;
  const reads = locate(upstreamDir(), dep);
  const { incident } = await openMaintenanceEvent(db, {
    tenantId: integ.tenantId,
    integrationId: integ.id,
    kind: 'dependency_contract_change',
    severity: 'low',
    title: 'QuickBooks retired the API minor version the integration requests',
    reason: `The running code requests minorversion=${declared}; QuickBooks serves ${MIN_SERVED_MINOR_VERSION} for any value below ${MIN_SERVED_MINOR_VERSION} since 2025-08-01.`,
    customerSummary:
      'QuickBooks retired the API version your integration asks for. Entries are still created correctly; we are updating the integration so it states the version QuickBooks actually uses.',
    customerNote:
      'QuickBooks retired the API version your integration asks for. Your entries are still created correctly (QuickBooks answers with its current version). We are updating the integration so it no longer depends on the retired version.',
    classifyAs: 'investigating',
    classificationNote: 'Dependency contract check of the pinned code against provider documentation.',
    finding: {
      provider: 'quickbooks',
      dependency: {
        integrationId: integ.id,
        flowType: integ.flowType,
        upstream: { repository: BASE_ARTIFACT.repository, commit: BASE_ARTIFACT.commit },
      },
      contract: dep.label,
      declared: String(declared),
      served: String(MIN_SERVED_MINOR_VERSION),
      codePath: reads.map((r) => ({ file: r.file, line: r.line, code: r.code })),
      evidence: [
        'docs/provider-docs/quickbooks/minor-versions.md',
        'https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/minor-versions',
      ],
      relevance: `${dep.effect}: the request runs as version ${MIN_SERVED_MINOR_VERSION} regardless of what the code declares`,
      runningArtifact: rt.artifact.id,
      detectedAt: new Date().toISOString(),
    },
  });
  return incident;
}

/** A Stripe object lacks what the adopted code reads: held work, one event (escalated: no reviewed correction). */
export async function recordInputContractBreak(db: Db, deliveryId: string, field: string) {
  const [d] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, d!.integrationId));
  const dep = DEPENDENCIES.find(
    (x) => field.includes(x.path) || x.path.includes(field.replace(/\[[^\]]*\]/g, '')),
  );
  const { incident } = await openMaintenanceEvent(db, {
    tenantId: integ!.tenantId,
    integrationId: integ!.id,
    kind: 'input_contract_change',
    severity: 'high',
    title: 'Stripe data no longer has what the integration reads',
    reason: `${field} missing for ${d!.sourceName}`,
    customerSummary:
      'A change in the data Stripe sends could affect your accounting entries. Affected transactions are held safely while we take care of it.',
    customerNote:
      'We noticed that Stripe changed the data it sends for some transactions. They are held safely; nothing incorrect was written to QuickBooks.',
    classifyAs: 'investigating',
    classificationNote: 'Input contract violated; affected transactions are held (nothing written).',
    finding: {
      provider: 'stripe',
      field,
      observed: { deliveryId, transaction: d!.sourceName },
      codePath: dep
        ? locate(upstreamDir(), dep).map((r) => ({ file: r.file, line: r.line, code: r.code }))
        : [],
      detectedAt: new Date().toISOString(),
    },
  });
  return incident;
}

/* ================================================================== accounting */

async function accountFor(
  db: Db,
  inc: IncidentRow,
  p: { reconcileRunId: string; verifyRunId: string; affectedSourceIds: string[]; detectedAt: Date },
): Promise<TransactionAccounting> {
  const [run] = await db.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, p.verifyRunId));
  const items = await db
    .select()
    .from(reconciliationItems)
    .where(eq(reconciliationItems.runId, p.verifyRunId));
  const first = await db
    .select()
    .from(reconciliationItems)
    .where(eq(reconciliationItems.runId, p.reconcileRunId));
  const discovered = new Set(
    first.filter((i) => i.classification === 'missing_delivery').map((i) => i.sourceOrderId),
  );
  const dels = items.length
    ? await db
        .select()
        .from(deliveries)
        .where(
          and(
            eq(deliveries.integrationId, inc.integrationId!),
            inArray(
              deliveries.sourceId,
              items.map((i) => i.sourceOrderId),
            ),
          ),
        )
    : [];
  const attempts = dels.length
    ? await db
        .select()
        .from(deliveryAttempts)
        .where(
          inArray(
            deliveryAttempts.deliveryId,
            dels.map((d) => d.id),
          ),
        )
    : [];
  return accountTransactions({
    window: { from: run!.windowFrom, to: run!.windowTo },
    sourceRunId: p.verifyRunId,
    readCompletely: run!.status === 'completed' && run!.outcome !== 'partial',
    detectedAt: p.detectedAt,
    affectedSourceIds: p.affectedSourceIds,
    items: items.map((i) => {
      const d = dels.find((x) => x.sourceId === i.sourceOrderId);
      const v = i.verification as { verified?: boolean; records?: number; detail?: string };
      return {
        sourceId: i.sourceOrderId,
        label: i.orderName,
        reference: i.sourceLegacyId,
        excluded: i.classification === 'excluded' ? (i.reason ?? 'excluded') : null,
        delivered: i.classification === 'delivered',
        discovered: discovered.has(i.sourceOrderId),
        attemptOutcomes: d
          ? attempts
              .filter((a) => a.deliveryId === d.id)
              .map((a) => (a.outcome === 'awaiting_authorization' ? 'held' : a.outcome))
          : [],
        deliveredAt: d?.deliveredAt ?? null,
        verification:
          v.verified === undefined
            ? null
            : { verified: v.verified, records: v.records ?? 0, detail: v.detail ?? '' },
      };
    }),
  });
}

/* ================================================================== shared tail: release → reconcile → recover → verify → account */

async function recoverAndVerify(
  deps: MaintainDeps,
  inc: IncidentRow,
  prog: Progress,
  windowFrom: Date,
  resolution: string,
  postActivationOf?: string,
): Promise<LedgerlyAdvance> {
  const { db } = deps;
  const phase = prog.phase ?? 'release';
  if (phase === 'release') {
    const released = await releaseDeliveries(db, inc.integrationId!, ['awaiting_authorization', 'held']);
    for (const r of released)
      await deps.services.enqueueExecution(r.id, {
        kind: 'maintenance_recovery',
        maintenanceEventId: inc.id,
      });
    await setProgress(db, inc.id, { phase: 'await_release', released: released.map((r) => r.id) });
    if (released.length)
      await note(
        db,
        inc,
        `We released ${plural(released.length)} that were held safely and are posting them to QuickBooks now.`,
        true,
        { step: 'released', released: released.length },
      );
    return { state: 'continue', detail: `${released.length} released` };
  }
  if (phase === 'await_release') {
    const ids = prog.released ?? [];
    const rows = ids.length
      ? await db.select({ outcome: deliveries.outcome }).from(deliveries).where(inArray(deliveries.id, ids))
      : [];
    if (rows.some((r) => ['pending', 'running'].includes(r.outcome)))
      return { state: 'wait', detail: 'released transactions executing' };
    if (rows.some((r) => r.outcome === 'awaiting_authorization'))
      return escalate(db, inc, 'authorization lost again while releasing held transactions');
    await setProgress(db, inc.id, { phase: 'reconcile' });
    return { state: 'continue', detail: 'released transactions executed' };
  }
  const startRun = async (
    window: { from: Date; to: Date },
    key: 'reconcileRunId' | 'verifyRunId',
    next: Progress['phase'],
  ) => {
    try {
      const s = await startLedgerlyReconciliation(db, {
        integrationId: inc.integrationId!,
        trigger: 'incident',
        requestedBy: MAINTENANCE_ACTOR,
        window,
        incidentId: inc.id,
      });
      await setProgress(db, inc.id, {
        [key]: s.runId,
        phase: next,
        window: { from: window.from.toISOString(), to: window.to.toISOString() },
      });
      await deps.services.enqueueReconciliation(s.runId);
      return { state: 'continue' as const, detail: 'check started' };
    } catch (err) {
      if (err instanceof LedgerlyReconciliationBusy)
        return { state: 'wait' as const, detail: 'another reconciliation is running' };
      throw err;
    }
  };
  const runDone = async (runId: string) => {
    const [run] = await db.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, runId));
    return run && run.status !== 'running' ? run : null;
  };
  // Stripe timestamps are whole seconds: the window ends now, so a transaction from this second is included.
  if (phase === 'reconcile')
    return startRun({ from: windowFrom, to: new Date() }, 'reconcileRunId', 'await_reconcile');
  if (phase === 'await_reconcile') {
    const run = await runDone(prog.reconcileRunId!);
    if (!run) return { state: 'wait', detail: 'reconciliation running' };
    if (run.outcome === 'partial') {
      if ((prog.attempts ?? 0) >= 3)
        return escalate(db, inc, 'reconciliation could not read the affected window completely');
      await setProgress(db, inc.id, { phase: 'reconcile', attempts: (prog.attempts ?? 0) + 1 });
      return { state: 'wait', detail: 'reconciliation partial; retrying' };
    }
    const missing = await db
      .select()
      .from(reconciliationItems)
      .where(
        and(
          eq(reconciliationItems.runId, run.id),
          eq(reconciliationItems.classification, 'missing_delivery'),
        ),
      );
    for (const it of missing)
      await recoverLedgerlyItem({
        db,
        cipher: deps.cipher,
        endpoints: deps.endpoints,
        itemId: it.id,
        requestedBy: MAINTENANCE_ACTOR,
      });
    if (missing.length)
      await note(
        db,
        inc,
        `${plural(missing.length)} never reached us; we found ${missing.length === 1 ? 'it' : 'them'} by checking Stripe directly and posted ${missing.length === 1 ? 'it' : 'them'}.`,
        true,
        { step: 'recovered', missing: missing.length },
      );
    await setProgress(db, inc.id, { phase: 'verify' });
    return { state: 'continue', detail: `${missing.length} recovered` };
  }
  if (phase === 'verify') {
    const w = prog.window!;
    return startRun({ from: new Date(w.from), to: new Date(w.to) }, 'verifyRunId', 'await_verify');
  }
  // await_verify → account → resolve
  const run = await runDone(prog.verifyRunId!);
  if (!run) return { state: 'wait', detail: 'verification running' };
  const released = prog.released?.length
    ? await db
        .select({ sourceId: deliveries.sourceId })
        .from(deliveries)
        .where(inArray(deliveries.id, prog.released))
    : [];
  const accounting = await accountFor(db, inc, {
    reconcileRunId: prog.reconcileRunId!,
    verifyRunId: run.id,
    affectedSourceIds: released.map((r) => r.sourceId),
    detectedAt: new Date((inc.finding as { detectedAt: string }).detectedAt),
  });
  await setFacts(db, inc.id, { accounting });
  const evidence = {
    passed: accounting.zeroLoss,
    verifyRunId: run.id,
    runOutcome: run.outcome,
    transactionsVerified: accounting.verified,
    population: accounting.population,
    duplicates: accounting.duplicates,
    method:
      'second reconciliation against the Stripe Events API + QuickBooks entries by DocNumber (balanced, accounts and amounts)',
  };
  const [fresh] = await db.select().from(incidents).where(eq(incidents.id, inc.id));
  const blockers = resolutionBlockers(fresh!, evidence);
  if (blockers.length) return escalate(db, fresh!, `not resolved: ${blockers.join('; ')}`);
  let cur = fresh!;
  for (const s of ['recovery', 'verification'] as const)
    if (cur.status !== s && cur.status !== 'verification')
      cur = await transitionIncident(db, inc.id, s, {
        actor: MAINTENANCE_ACTOR,
        note: s === 'recovery' ? 'Recovery in progress' : 'Verifying against durable evidence',
        customerVisible: false,
      });
  await transitionIncident(db, inc.id, 'resolved', {
    actor: MAINTENANCE_ACTOR,
    note: `All ${plural(accounting.verified)} from the affected period are in QuickBooks exactly once, balanced, with the amounts Stripe reports.`,
    resolution,
    verification: evidence,
    evidence: { step: 'verified', verified: accounting.verified, duplicates: accounting.duplicates },
  });
  if (postActivationOf)
    await recordPostActivation(db, postActivationOf, {
      maintenanceEventId: inc.id,
      verifiedAt: new Date().toISOString(),
      population: accounting.population,
      verified: accounting.verified,
      unresolved: accounting.unresolved,
      duplicates: accounting.duplicates,
      zeroLoss: accounting.zeroLoss,
      verificationRunId: run.id,
    });
  return { state: 'resolved', detail: 'verified and resolved' };
}

/* ================================================================== drivers */

async function advanceReauthorization(
  deps: MaintainDeps,
  inc: IncidentRow,
  prog: Progress,
): Promise<LedgerlyAdvance> {
  const { db } = deps;
  const finding = inc.finding as { detectedAt: string; providers: { provider: 'stripe' | 'quickbooks' }[] };
  const detectedAt = new Date(finding.detectedAt);
  if (!inc.correction) {
    // Only the customer can grant access again: wait for a connection re-authorized after the event.
    const back: { provider: string; at: Date; by: string }[] = [];
    for (const { provider } of finding.providers) {
      const c = await loadConnection(db, inc.tenantId, provider);
      if (
        !c ||
        c.status === 'revoked' ||
        !c.credentialsCiphertext ||
        (c.lastVerifiedAt?.getTime() ?? 0) < detectedAt.getTime()
      )
        return { state: 'noop', detail: `waiting for the customer to reconnect ${provider}` };
      back.push({ provider, at: c.lastVerifiedAt!, by: 'customer' });
    }
    // Validate the new authorization before anything is released.
    const checks: AdaptationValidation['checks'] = [];
    const add = (name: string, ok: boolean, detail: string) =>
      checks.push({ name, status: ok ? 'passed' : 'failed', detail });
    for (const b of back)
      add(
        `${b.provider === 'quickbooks' ? 'QuickBooks' : 'Stripe'} authorized again by the customer`,
        true,
        `connection re-authorized ${b.at.toISOString()}`,
      );
    try {
      const qbo = new QuickBooksAccess(db, deps.cipher, deps.endpoints, inc.tenantId);
      const conn = (await loadConnection(db, inc.tenantId, 'quickbooks'))!;
      await qbo.refresh(conn.id, true);
      add('token refresh works with the new authorization', true, 'QuickBooks issued and rotated tokens');
      const ci = await qbo.query<{ CompanyInfo?: { CompanyName: string }[] }>('select * from CompanyInfo');
      add(
        'QuickBooks company reachable',
        !!ci.CompanyInfo?.length,
        ci.CompanyInfo?.[0]?.CompanyName ?? 'no company',
      );
      await (await stripeFor(db, deps.cipher, deps.endpoints, inc.tenantId)).sdk.accounts.retrieve();
      add('Stripe reachable', true, 'Stripe account answered');
    } catch (err) {
      add('authorization works', false, describeError(err).message);
    }
    const passed = checks.every((c) => c.status === 'passed');
    const validation: AdaptationValidation = {
      passed,
      requiresDecision: false,
      checks,
      postActivation: null,
      artifact: { before: '', after: '' },
      validatedAt: new Date().toISOString(),
    };
    const held = await db
      .select({ id: deliveries.id })
      .from(deliveries)
      .where(
        and(
          eq(deliveries.integrationId, inc.integrationId!),
          eq(deliveries.outcome, 'awaiting_authorization'),
        ),
      );
    await setFacts(db, inc.id, {
      investigation: {
        heldTransactions: held.length,
        providers: finding.providers.map((p) => p.provider),
        since: finding.detectedAt,
      },
      validation,
      ...(passed
        ? {
            correction: {
              kind: 'reauthorization',
              derivable: true,
              boundary: 'customer authorization (OAuth); no code changed',
              upstreamModified: false,
              derivedAt: new Date().toISOString(),
              activatedAt: back
                .map((b) => b.at)
                .sort((a, b) => b.getTime() - a.getTime())[0]!
                .toISOString(),
            },
          }
        : {}),
    });
    if (!passed) return { state: 'noop', detail: 'new authorization does not work yet' };
    await transitionIncident(db, inc.id, 'recovery', {
      actor: MAINTENANCE_ACTOR,
      note: 'Authorization restored by the customer; recovering held transactions',
      customerVisible: false,
    });
    await note(
      db,
      inc,
      'Thank you — your connection works again. We checked it before sending anything.',
      true,
      { step: 'tested', checks },
    );
    return { state: 'continue', detail: 'authorization validated' };
  }
  const window = new Date(Math.min(detectedAt.getTime() - 3600_000, ...(await heldSince(db, inc))));
  return recoverAndVerify(
    deps,
    inc,
    prog,
    window,
    'Customer re-authorized access; held transactions delivered and verified.',
  );
}

async function heldSince(db: Db, inc: IncidentRow): Promise<number[]> {
  const prog = progressOf<Progress>(inc);
  const ids = prog.released ?? [];
  if (!ids.length) return [];
  const rows = await db
    .select({ at: deliveries.sourceCreatedAt })
    .from(deliveries)
    .where(inArray(deliveries.id, ids));
  return rows.map((r) => r.at.getTime() - 60_000);
}

async function advanceDependency(
  deps: MaintainDeps,
  inc: IncidentRow,
  prog: Progress,
): Promise<LedgerlyAdvance> {
  const { db } = deps;
  const finding = inc.finding as {
    codePath: unknown[];
    declared: string;
    served: string;
    detectedAt: string;
  };
  if (!inc.investigation) {
    const rt = await runtimeFor(db, inc.integrationId!);
    await setFacts(db, inc.id, {
      investigation: {
        codePaths: finding.codePath,
        runningArtifact: rt.artifact.id,
        risk: 'none observed: QuickBooks serves the current version; the code no longer states what it depends on',
        declared: finding.declared,
        served: finding.served,
      },
    });
    return { state: 'continue', detail: 'investigated' };
  }
  let correction = inc.correction as {
    adaptationId?: string;
    kind: string;
    patchId?: string;
    activatedAt?: string;
  } | null;
  if (!correction) {
    const row = await proposePatch(db, {
      integrationId: inc.integrationId!,
      patchId: 'p0001-qbo-minor-version-75',
      actor: MAINTENANCE_ACTOR,
      reason: `maintenance event ${inc.id}`,
      maintenanceEventId: inc.id,
    });
    correction = { adaptationId: row.id, kind: 'patch', patchId: 'p0001-qbo-minor-version-75' };
    await setFacts(db, inc.id, {
      correction: {
        ...correction,
        derivable: true,
        boundary: 'reviewed patch applied to a content-addressed copy of the pinned upstream package',
        upstreamModified: false,
        derivedAt: new Date().toISOString(),
      },
    });
    return { state: 'continue', detail: 'patch proposed' };
  }
  const [row] = await db.select().from(adaptations).where(eq(adaptations.id, correction.adaptationId!));
  if (!row) return escalate(db, inc, 'correction record missing');
  if (['rejected', 'rolled_back', 'unsupported'].includes(row.status))
    return escalate(db, inc, `correction ${row.status}`);
  if (row.status === 'proposed' || row.status === 'validating') {
    const v = await validateLedgerlyAdaptation(db, deps.cipher, deps.endpoints, row.id);
    await setFacts(db, inc.id, { validation: v.validation });
    if (v.status !== 'validated') return escalate(db, inc, 'validation failed');
    await note(
      db,
      inc,
      'We tested the update against your earlier transactions and the entries already in QuickBooks; it changes nothing in your books.',
      true,
      { step: 'tested' },
    );
    return { state: 'continue', detail: 'validated' };
  }
  if (row.status === 'validated') {
    // Patches are never switched on automatically.
    if (!prog.awaitingDecision) {
      await setProgress(db, inc.id, { awaitingDecision: true });
      await note(
        db,
        inc,
        'A reviewed update is validated and waiting for an engineer to switch it on.',
        false,
        { step: 'reviewing' },
      );
    }
    return { state: 'noop', detail: 'waiting for an operator to activate the reviewed patch' };
  }
  // active
  if (!correction.activatedAt) {
    await setFacts(db, inc.id, {
      correction: { ...(inc.correction as object), activatedAt: row.activatedAt!.toISOString() },
    });
    return { state: 'continue', detail: 'activation recorded' };
  }
  // Verified only once real work has run through the corrected code: until a transaction is delivered by
  // the patched artifact there is nothing to verify, and an empty population can never support a claim.
  if (!prog.phase) {
    const rt = await runtimeFor(db, inc.integrationId!);
    const ran = await db
      .select({ id: deliveryAttempts.id })
      .from(deliveryAttempts)
      .innerJoin(deliveries, eq(deliveries.id, deliveryAttempts.deliveryId))
      .where(
        and(
          eq(deliveries.integrationId, inc.integrationId!),
          eq(deliveryAttempts.implementationVersionId, rt.artifact.id),
          eq(deliveryAttempts.outcome, 'delivered'),
        ),
      )
      .limit(1);
    if (!ran.length)
      return { state: 'noop', detail: `waiting for a transaction to run on ${rt.artifact.id}` };
  }
  const since = new Date(Math.min(Date.parse(finding.detectedAt), Date.now()) - 24 * 3600_000);
  return recoverAndVerify(
    deps,
    inc,
    prog.phase ? prog : { ...prog, phase: 'reconcile' },
    since,
    'Reviewed patch activated; recent transactions verified in QuickBooks.',
    row.id,
  );
}

async function advanceInputContract(deps: MaintainDeps, inc: IncidentRow): Promise<LedgerlyAdvance> {
  const { db } = deps;
  if (inc.correction) return { state: 'escalated', detail: 'unsupported change; with a person' };
  const f = inc.finding as { field: string; codePath: unknown[] };
  const reason = `No reviewed correction exists for a Stripe change that removes ${f.field}; affected transactions stay held for a person to decide.`;
  const row = await recordAdaptation(db, {
    integrationId: inc.integrationId!,
    maintenanceEventId: inc.id,
    kind: 'unsupported',
    artifact: BASE_ARTIFACT,
    dependency: { provider: 'stripe', field: f.field },
    codePath: { reads: f.codePath },
    spec: { reason },
    rationale: reason,
    actor: MAINTENANCE_ACTOR,
  });
  await setFacts(db, inc.id, {
    investigation: { codePaths: f.codePath },
    correction: {
      adaptationId: row.id,
      kind: 'unsupported',
      derivable: false,
      reason,
      upstreamModified: false,
      derivedAt: new Date().toISOString(),
    },
  });
  return escalate(db, inc, reason);
}

/** Advances one Stripe → QuickBooks maintenance event by one step. */
export async function advanceLedgerlyMaintenance(
  deps: MaintainDeps,
  incidentId: string,
): Promise<LedgerlyAdvance> {
  const { db } = deps;
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!inc || inc.status === 'resolved') return { state: 'noop', detail: 'nothing to do' };
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, inc.integrationId!));
  if (integ?.flowType !== LEDGERLY_FLOW_TYPE) return { state: 'noop', detail: 'not this integration' };
  const prog = progressOf<Progress>(inc) as Progress;
  if (prog.escalated) return { state: 'escalated', detail: prog.escalated };
  if (inc.kind === 'connection_auth') return advanceReauthorization(deps, inc, prog);
  if (inc.kind === 'dependency_contract_change') return advanceDependency(deps, inc, prog);
  if (inc.kind === 'input_contract_change') return advanceInputContract(deps, inc);
  return { state: 'noop', detail: `no driver for ${inc.kind}` };
}

/** Open events for this integration kind (crash safety: the sweep re-drives them). */
export async function openLedgerlyEvents(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: incidents.id })
    .from(incidents)
    .innerJoin(integrations, eq(integrations.id, incidents.integrationId))
    .where(and(eq(integrations.flowType, LEDGERLY_FLOW_TYPE), ne(incidents.status, 'resolved')));
  return rows.map((r) => r.id);
}
