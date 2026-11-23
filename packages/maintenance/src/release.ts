/**
 * Release safety: human approval → canary → promotion or automatic rollback → post-release
 * reconciliation. Every step is a durable state transition on the releases row.
 *
 * Canary semantics (single integration per tenant in this slice): the new version processes a
 * bounded number of real deliveries (canaryLimit) and those deliveries are reconciled against
 * NetSuite before the version is promoted. A failed canary leaves the previous version pinned.
 */
import { and, eq } from 'drizzle-orm';
import {
  auditLog,
  incidents,
  integrations,
  integrationVersions,
  maintenanceRuns,
  releases,
  repairCandidates,
  validationRuns,
  type Db,
} from '@mi/database';
import { describeError, type Logger } from '@mi/observability';
import type { IntegrationRuntime, RetryPolicy } from '@mi/integration-shopify-netsuite';
import {
  applyReconciliationResult,
  evaluateIntegration,
  noteIncident,
  reconcile,
  type ReliabilityAction,
} from '@mi/reliability';

export class ReleaseError extends Error {}

export const CANARY_LIMIT = 5;

/** Human approval of a validated candidate. Only callable from the operator API (never by the agent). */
export async function approveCandidate(
  db: Db,
  p: { candidateId: string; operatorUserId: string; note?: string },
): Promise<{ releaseId: string }> {
  return db.transaction(async (tx) => {
    const [cand] = await tx
      .select()
      .from(repairCandidates)
      .where(eq(repairCandidates.id, p.candidateId))
      .for('update');
    if (!cand) throw new ReleaseError('Candidate not found');
    if (cand.status !== 'validated' || !cand.integrationVersionId)
      throw new ReleaseError(`Candidate must be validated before approval (status: ${cand.status})`);
    const vals = await tx.select().from(validationRuns).where(eq(validationRuns.repairCandidateId, cand.id));
    if (!vals.some((v) => v.status === 'passed' && v.protectedPathsOk === true))
      throw new ReleaseError('No passing independent validation with intact protected suite');
    const [mr] = await tx.select().from(maintenanceRuns).where(eq(maintenanceRuns.id, cand.maintenanceRunId));
    const [integ] = await tx.select().from(integrations).where(eq(integrations.id, mr!.integrationId!));
    if (!integ) throw new ReleaseError('Integration not found');
    if (integ.canaryVersionId)
      throw new ReleaseError('Another canary is already in progress for this integration');
    const now = new Date();
    const [rel] = await tx
      .insert(releases)
      .values({
        repairCandidateId: cand.id,
        integrationVersionId: cand.integrationVersionId,
        previousVersionId: integ.implementationVersionId,
        integrationId: integ.id,
        status: 'approved',
        approvedBy: p.operatorUserId,
        approvedAt: now,
      })
      .returning();
    await tx
      .update(repairCandidates)
      .set({ status: 'approved', decidedBy: p.operatorUserId, decidedAt: now, decisionNote: p.note ?? null })
      .where(eq(repairCandidates.id, cand.id));
    await tx
      .update(integrations)
      .set({ canaryVersionId: cand.integrationVersionId, updatedAt: now })
      .where(eq(integrations.id, integ.id));
    await tx
      .update(maintenanceRuns)
      .set({
        humanDecisions: [
          ...((mr!.humanDecisions as unknown[]) ?? []),
          {
            decision: 'approved',
            by: p.operatorUserId,
            at: now.toISOString(),
            candidateId: cand.id,
            note: p.note ?? null,
          },
        ],
      })
      .where(eq(maintenanceRuns.id, mr!.id));
    await tx
      .insert(auditLog)
      .values({
        actorUserId: p.operatorUserId,
        actorRole: 'operator',
        action: 'candidate.approve',
        targetType: 'repair_candidate',
        targetId: cand.id,
        details: { releaseId: rel!.id, version: cand.integrationVersionId },
      });
    return { releaseId: rel!.id };
  });
}

export async function rejectCandidate(
  db: Db,
  p: { candidateId: string; operatorUserId: string; note: string },
): Promise<void> {
  const [cand] = await db.select().from(repairCandidates).where(eq(repairCandidates.id, p.candidateId));
  if (!cand) throw new ReleaseError('Candidate not found');
  if (!['submitted', 'validated', 'validation_failed'].includes(cand.status))
    throw new ReleaseError(`Cannot reject a candidate in status ${cand.status}`);
  const now = new Date();
  await db
    .update(repairCandidates)
    .set({ status: 'rejected', decidedBy: p.operatorUserId, decidedAt: now, decisionNote: p.note })
    .where(eq(repairCandidates.id, cand.id));
  const [mr] = await db.select().from(maintenanceRuns).where(eq(maintenanceRuns.id, cand.maintenanceRunId));
  await db
    .update(maintenanceRuns)
    .set({
      humanDecisions: [
        ...((mr!.humanDecisions as unknown[]) ?? []),
        {
          decision: 'rejected',
          by: p.operatorUserId,
          at: now.toISOString(),
          candidateId: cand.id,
          note: p.note,
        },
      ],
    })
    .where(eq(maintenanceRuns.id, mr!.id));
  await db
    .insert(auditLog)
    .values({
      actorUserId: p.operatorUserId,
      actorRole: 'operator',
      action: 'candidate.reject',
      targetType: 'repair_candidate',
      targetId: cand.id,
      details: { note: p.note },
    });
}

export interface RunReleaseDeps {
  db: Db;
  releaseId: string;
  buildRuntime: (integrationId: string, opts?: { useCanary?: boolean }) => Promise<IntegrationRuntime>;
  logger?: Logger;
  retry?: RetryPolicy;
  enqueue?: (actions: ReliabilityAction[]) => Promise<void>;
  canaryLimit?: number;
}

async function linkedIncidentId(db: Db, candidateId: string | null): Promise<string | null> {
  if (!candidateId) return null;
  const [cand] = await db.select().from(repairCandidates).where(eq(repairCandidates.id, candidateId));
  const [mr] = cand
    ? await db.select().from(maintenanceRuns).where(eq(maintenanceRuns.id, cand.maintenanceRunId))
    : [];
  return mr?.incidentId ?? null;
}

export async function runRelease(d: RunReleaseDeps): Promise<{ status: string }> {
  const { db } = d;
  const [rel] = await db.select().from(releases).where(eq(releases.id, d.releaseId));
  if (!rel) throw new ReleaseError('release not found');
  if (rel.status !== 'approved') return { status: rel.status };
  const incidentId = await linkedIncidentId(db, rel.repairCandidateId);

  /* ---------------- canary ---------------- */
  await db.update(releases).set({ status: 'canary', updatedAt: new Date() }).where(eq(releases.id, rel.id));
  await db
    .update(integrationVersions)
    .set({ releaseState: 'canary' })
    .where(eq(integrationVersions.id, rel.integrationVersionId));
  if (incidentId)
    await noteIncident(
      db,
      incidentId,
      `Fix approved by an operator. Canary release ${rel.integrationVersionId} started on a limited set of orders.`,
      { customerVisible: true },
    );

  let canaryOk = false;
  let canaryResult: Record<string, unknown> = {};
  try {
    const rt = await d.buildRuntime(rel.integrationId, { useCanary: true });
    if (rt.implementationVersionId !== rel.integrationVersionId)
      throw new ReleaseError('Runtime did not load the canary version');
    const run = await rt.engine.run({
      integrationId: rel.integrationId,
      trigger: 'release',
      mode: 'canary',
      canaryLimit: d.canaryLimit ?? CANARY_LIMIT,
    });
    if (run.status === 'skipped') throw new ReleaseError('Integration lease held; canary will be retried');
    canaryResult = {
      syncRunId: run.syncRunId,
      status: run.status,
      delivered: run.counts.delivered,
      errorClass: run.errorClass ?? null,
      errorMessage: run.errorMessage ?? null,
    };
    if (run.status !== 'failed') {
      // Verify what the canary delivered: reconcile its window against NetSuite.
      const from = run.cursorBefore ? new Date(Date.parse(run.cursorBefore) - 5 * 60_000) : undefined;
      const recon = await reconcile({
        db,
        shopify: rt.shopify,
        netsuite: rt.netsuite,
        integrationId: rel.integrationId,
        trigger: 'release',
        ...(from ? { windowFrom: from } : {}),
        ...(run.cursorAfter ? { windowTo: new Date(run.cursorAfter) } : {}),
        ...(d.retry ? { retry: d.retry } : {}),
      });
      const c = recon.classification;
      canaryResult.reconciliation = {
        runId: recon.runId,
        outcome: recon.outcome,
        matched: c.matched,
        missing: c.missing.length,
        duplicates: c.duplicates.length,
        inconsistent: c.inconsistent.length,
      };
      canaryOk =
        recon.sourceComplete &&
        recon.destinationComplete &&
        c.missing.length === 0 &&
        c.duplicates.length === 0 &&
        c.inconsistent.length === 0;
    }
  } catch (err) {
    if (err instanceof ReleaseError && /lease held/.test(err.message)) {
      await db.update(releases).set({ status: 'approved' }).where(eq(releases.id, rel.id));
      throw err; // job retry
    }
    canaryResult.error = describeError(err).message;
  }

  if (!canaryOk) {
    await rollbackCanary(
      db,
      rel.id,
      `Canary failed: ${JSON.stringify(canaryResult).slice(0, 500)}`,
      canaryResult,
    );
    if (incidentId)
      await noteIncident(
        db,
        incidentId,
        'Canary release did not pass verification and was rolled back automatically. The previous version remains active.',
        { customerVisible: true },
      );
    return { status: 'rolled_back' };
  }

  /* ---------------- promote ---------------- */
  await db.transaction(async (tx) => {
    await tx
      .update(integrations)
      .set({
        implementationVersionId: rel.integrationVersionId,
        canaryVersionId: null,
        updatedAt: new Date(),
      })
      .where(eq(integrations.id, rel.integrationId));
    await tx
      .update(integrationVersions)
      .set({ releaseState: 'released' })
      .where(eq(integrationVersions.id, rel.integrationVersionId));
    if (rel.previousVersionId)
      await tx
        .update(integrationVersions)
        .set({ releaseState: 'retired' })
        .where(eq(integrationVersions.id, rel.previousVersionId));
    await tx
      .update(releases)
      .set({
        status: 'released',
        canaryResult,
        canarySyncRunId: (canaryResult.syncRunId as string) ?? null,
        updatedAt: new Date(),
      })
      .where(eq(releases.id, rel.id));
    if (rel.repairCandidateId)
      await tx
        .update(repairCandidates)
        .set({ status: 'released' })
        .where(eq(repairCandidates.id, rel.repairCandidateId));
  });
  if (incidentId)
    await noteIncident(
      db,
      incidentId,
      `Canary verified. Version ${rel.integrationVersionId} promoted; catching up on delayed orders.`,
      { customerVisible: true },
    );

  /* ---------------- post-release: catch up, then reconcile ---------------- */
  const rt = await d.buildRuntime(rel.integrationId);
  const full = await rt.engine.run({ integrationId: rel.integrationId, trigger: 'release' });
  // Evaluation moves the incident into verification when the sync caught up.
  const ev = await evaluateIntegration(db, rel.integrationId);
  const [inc] = incidentId ? await db.select().from(incidents).where(eq(incidents.id, incidentId)) : [];
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, rel.integrationId));
  const backfillFrom = Date.parse((integ!.config as { backfillFrom: string }).backfillFrom);
  // Window covers everything that could have been affected: from 7 days before detection (bounded by backfill start).
  const windowFrom = inc
    ? new Date(Math.max(backfillFrom, inc.detectedAt.getTime() - 7 * 24 * 3600_000))
    : undefined;
  const recon = await reconcile({
    db,
    shopify: rt.shopify,
    netsuite: rt.netsuite,
    integrationId: rel.integrationId,
    trigger: 'release',
    incidentId,
    ...(windowFrom ? { windowFrom } : {}),
    ...(d.retry ? { retry: d.retry } : {}),
  });
  const follow = await applyReconciliationResult(db, rel.integrationId, incidentId, recon);
  await d.enqueue?.([...ev.actions.filter((a) => a.type !== 'reconcile'), ...follow]);
  await db
    .update(releases)
    .set({ postReleaseReconciliationId: recon.runId, updatedAt: new Date() })
    .where(eq(releases.id, rel.id));
  d.logger?.info(
    { releaseId: rel.id, fullSync: full.status, reconciliation: recon.outcome },
    'release completed',
  );
  return { status: 'released' };
}

async function rollbackCanary(
  db: Db,
  releaseId: string,
  reason: string,
  canaryResult: Record<string, unknown>,
) {
  const [rel] = await db.select().from(releases).where(eq(releases.id, releaseId));
  await db.transaction(async (tx) => {
    await tx
      .update(integrations)
      .set({ canaryVersionId: null, updatedAt: new Date() })
      .where(and(eq(integrations.id, rel!.integrationId)));
    await tx
      .update(integrationVersions)
      .set({ releaseState: 'rolled_back' })
      .where(eq(integrationVersions.id, rel!.integrationVersionId));
    await tx
      .update(releases)
      .set({ status: 'rolled_back', rollbackReason: reason, canaryResult, updatedAt: new Date() })
      .where(eq(releases.id, releaseId));
    if (rel!.repairCandidateId)
      await tx
        .update(repairCandidates)
        .set({ status: 'rolled_back' })
        .where(eq(repairCandidates.id, rel!.repairCandidateId));
  });
}

/** Operator-initiated rollback of a released version to the version it replaced. */
export async function rollbackRelease(
  db: Db,
  p: { releaseId: string; operatorUserId: string; reason: string },
): Promise<void> {
  const [rel] = await db.select().from(releases).where(eq(releases.id, p.releaseId));
  if (!rel) throw new ReleaseError('release not found');
  if (rel.status !== 'released')
    throw new ReleaseError(`Only a released release can be rolled back (status: ${rel.status})`);
  if (!rel.previousVersionId) throw new ReleaseError('No previous version to roll back to');
  await db.transaction(async (tx) => {
    await tx
      .update(integrations)
      .set({ implementationVersionId: rel.previousVersionId, updatedAt: new Date() })
      .where(eq(integrations.id, rel.integrationId));
    await tx
      .update(integrationVersions)
      .set({ releaseState: 'released' })
      .where(eq(integrationVersions.id, rel.previousVersionId!));
    await tx
      .update(integrationVersions)
      .set({ releaseState: 'rolled_back' })
      .where(eq(integrationVersions.id, rel.integrationVersionId));
    await tx
      .update(releases)
      .set({ status: 'rolled_back', rollbackReason: p.reason, updatedAt: new Date() })
      .where(eq(releases.id, rel.id));
    await tx
      .insert(auditLog)
      .values({
        actorUserId: p.operatorUserId,
        actorRole: 'operator',
        action: 'release.rollback',
        targetType: 'release',
        targetId: rel.id,
        details: { reason: p.reason, restored: rel.previousVersionId },
      });
  });
}
