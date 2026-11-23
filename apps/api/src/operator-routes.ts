/**
 * Operator console API: an exception inbox and the decisions only a human may make
 * (approve/reject candidates, roll back releases). Every decision is audited.
 */
import { desc, eq, inArray, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FLOW_TYPE, QUEUES } from '@mi/contracts';
import {
  auditLog,
  incidentEvents,
  incidents,
  integrations,
  maintenanceRuns,
  reconciliationRuns,
  releases,
  repairCandidates,
  syncRuns,
  tenants,
  validationRuns,
} from '@mi/database';
import { approveCandidate, rejectCandidate, ReleaseError, rollbackRelease } from '@mi/maintenance';
import { requireRole } from './auth.ts';
import type { ApiDeps } from './app.ts';

const uuid = z.string().uuid();

export async function registerOperatorRoutes(app: FastifyInstance, deps: ApiDeps) {
  const { db } = deps;
  const auth = requireRole(db, 'operator');
  const tenantName = async () => new Map((await db.select().from(tenants)).map((t) => [t.id, t.name]));

  /** What needs a human, ordered by urgency. Each item says what, who, why and which decision. */
  app.get('/api/operator/inbox', { preHandler: auth }, async () => {
    const names = await tenantName();
    const items: {
      kind: string;
      priority: number;
      title: string;
      customer: string;
      why: string;
      decision: string;
      link: string;
      at: Date;
    }[] = [];
    const open = await db.select().from(incidents).where(ne(incidents.status, 'resolved'));
    for (const i of open) {
      const sev = { critical: 0, high: 1, medium: 2, low: 3 }[i.severity] ?? 3;
      items.push({
        kind: 'incident',
        priority: sev,
        title: i.title,
        customer: names.get(i.tenantId) ?? i.tenantId,
        why: `${i.kind} · ${i.status} · ${i.reason.slice(0, 160)}`,
        decision:
          i.status === 'requires_action'
            ? i.customerAction
              ? 'Waiting on customer — follow up if stale'
              : 'Operator action required'
            : i.status === 'investigating'
              ? 'Maintenance in progress — review candidate when validated'
              : 'Automatic recovery in progress — monitor',
        link: `/ops/incidents/${i.id}`,
        at: i.detectedAt,
      });
    }
    const cands = await db
      .select()
      .from(repairCandidates)
      .where(inArray(repairCandidates.status, ['validated', 'validation_failed', 'submitted', 'validating']));
    for (const c of cands) {
      items.push({
        kind: 'candidate',
        priority: c.status === 'validated' ? 0 : 2,
        title:
          c.status === 'validated'
            ? 'Repair candidate validated — approval needed'
            : `Repair candidate ${c.status.replace('_', ' ')}`,
        customer: '',
        why: c.hypothesis.slice(0, 200),
        decision:
          c.status === 'validated'
            ? 'Review diff and validation, then approve or reject'
            : c.status === 'validation_failed'
              ? 'Reject, or investigate manually'
              : 'Wait for validation',
        link: `/ops/candidates/${c.id}`,
        at: c.createdAt,
      });
    }
    const failedMr = await db
      .select()
      .from(maintenanceRuns)
      .where(inArray(maintenanceRuns.status, ['failed', 'no_candidate']));
    for (const m of failedMr) {
      items.push({
        kind: 'maintenance',
        priority: 1,
        title: `Maintenance produced no candidate (${m.status})`,
        customer: '',
        why: (m.outcome ?? '').slice(0, 200),
        decision: 'Investigate manually',
        link: `/ops/maintenance/${m.id}`,
        at: m.createdAt,
      });
    }
    const rels = await db
      .select()
      .from(releases)
      .where(inArray(releases.status, ['canary', 'rolled_back']));
    for (const r of rels) {
      items.push({
        kind: 'release',
        priority: r.status === 'rolled_back' ? 1 : 2,
        title: `Release ${r.integrationVersionId} ${r.status}`,
        customer: '',
        why: r.rollbackReason ?? 'Canary in progress',
        decision: r.status === 'rolled_back' ? 'Review canary evidence' : 'Monitor canary',
        link: `/ops/releases`,
        at: r.updatedAt,
      });
    }
    return items.sort((a, b) => a.priority - b.priority || b.at.getTime() - a.at.getTime());
  });

  app.get('/api/operator/tenants', { preHandler: auth }, async () => {
    const ts = await db.select().from(tenants);
    const integs = await db.select().from(integrations);
    const open = await db.select().from(incidents).where(ne(incidents.status, 'resolved'));
    return ts.map((t) => ({
      id: t.id,
      name: t.name,
      lifecycle: t.lifecycle,
      integrations: integs
        .filter((i) => i.tenantId === t.id)
        .map((i) => ({
          id: i.id,
          flowType: i.flowType,
          displayName: i.displayName,
          health: i.health,
          enabled: i.enabled,
          implementationVersionId: i.implementationVersionId,
          canaryVersionId: i.canaryVersionId,
          lastSuccessfulSyncAt: i.lastSuccessfulSyncAt,
          cursorWatermark: i.cursorWatermark,
          openIncidents: open.filter((o) => o.integrationId === i.id).length,
        })),
    }));
  });

  app.get('/api/operator/incidents', { preHandler: auth }, async () =>
    db.select().from(incidents).orderBy(desc(incidents.detectedAt)).limit(200),
  );

  app.get('/api/operator/incidents/:id', { preHandler: auth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!uuid.safeParse(id).success) return reply.code(404).send({ error: 'Not found' });
    const [inc] = await db.select().from(incidents).where(eq(incidents.id, id));
    if (!inc) return reply.code(404).send({ error: 'Not found' });
    const events = await db
      .select()
      .from(incidentEvents)
      .where(eq(incidentEvents.incidentId, id))
      .orderBy(incidentEvents.createdAt);
    const mrs = await db.select().from(maintenanceRuns).where(eq(maintenanceRuns.incidentId, id));
    const cands = mrs.length
      ? await db
          .select()
          .from(repairCandidates)
          .where(
            inArray(
              repairCandidates.maintenanceRunId,
              mrs.map((m) => m.id),
            ),
          )
      : [];
    const recons = await db.select().from(reconciliationRuns).where(eq(reconciliationRuns.incidentId, id));
    return {
      incident: inc,
      events,
      maintenanceRuns: mrs.map((m) => ({
        id: m.id,
        status: m.status,
        planner: m.planner,
        outcome: m.outcome,
        createdAt: m.createdAt,
      })),
      candidates: cands.map((c) => ({ id: c.id, status: c.status, createdAt: c.createdAt })),
      reconciliations: recons,
    };
  });

  app.get('/api/operator/maintenance-runs/:id', { preHandler: auth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!uuid.safeParse(id).success) return reply.code(404).send({ error: 'Not found' });
    const [m] = await db.select().from(maintenanceRuns).where(eq(maintenanceRuns.id, id));
    return m ?? reply.code(404).send({ error: 'Not found' });
  });

  app.get('/api/operator/candidates/:id', { preHandler: auth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!uuid.safeParse(id).success) return reply.code(404).send({ error: 'Not found' });
    const [c] = await db.select().from(repairCandidates).where(eq(repairCandidates.id, id));
    if (!c) return reply.code(404).send({ error: 'Not found' });
    const vals = await db
      .select()
      .from(validationRuns)
      .where(eq(validationRuns.repairCandidateId, id))
      .orderBy(desc(validationRuns.startedAt));
    const [mr] = await db.select().from(maintenanceRuns).where(eq(maintenanceRuns.id, c.maintenanceRunId));
    const rels = await db.select().from(releases).where(eq(releases.repairCandidateId, id));
    return {
      candidate: c,
      validations: vals,
      maintenanceRun: mr
        ? {
            id: mr.id,
            incidentId: mr.incidentId,
            planner: mr.planner,
            hypothesis: mr.hypothesis,
            cost: mr.cost,
            toolCalls: mr.toolCalls,
          }
        : null,
      releases: rels,
    };
  });

  app.post('/api/operator/candidates/:id/approve', { preHandler: auth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = z.object({ note: z.string().max(2000).optional() }).safeParse(req.body ?? {});
    if (!uuid.safeParse(id).success || !body.success)
      return reply.code(400).send({ error: 'Invalid request' });
    try {
      const { releaseId } = await approveCandidate(db, {
        candidateId: id,
        operatorUserId: req.user!.id,
        ...(body.data.note ? { note: body.data.note } : {}),
      });
      await deps.boss.send(QUEUES.release, { releaseId });
      return { releaseId };
    } catch (err) {
      if (err instanceof ReleaseError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/operator/candidates/:id/reject', { preHandler: auth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = z.object({ note: z.string().min(3).max(2000) }).safeParse(req.body ?? {});
    if (!uuid.safeParse(id).success || !body.success)
      return reply.code(400).send({ error: 'A rejection note is required' });
    try {
      await rejectCandidate(db, { candidateId: id, operatorUserId: req.user!.id, note: body.data.note });
      return { status: 'rejected' };
    } catch (err) {
      if (err instanceof ReleaseError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/operator/releases', { preHandler: auth }, async () =>
    db.select().from(releases).orderBy(desc(releases.createdAt)).limit(100),
  );

  app.post('/api/operator/releases/:id/rollback', { preHandler: auth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = z.object({ reason: z.string().min(3).max(2000) }).safeParse(req.body ?? {});
    if (!uuid.safeParse(id).success || !body.success)
      return reply.code(400).send({ error: 'A rollback reason is required' });
    try {
      await rollbackRelease(db, { releaseId: id, operatorUserId: req.user!.id, reason: body.data.reason });
      return { status: 'rolled_back' };
    } catch (err) {
      if (err instanceof ReleaseError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/operator/integrations/:id/reconcile', { preHandler: auth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!uuid.safeParse(id).success) return reply.code(404).send({ error: 'Not found' });
    const [target] = await db
      .select({ flowType: integrations.flowType })
      .from(integrations)
      .where(eq(integrations.id, id));
    if (!target) return reply.code(404).send({ error: 'Not found' });
    if (target.flowType !== FLOW_TYPE) {
      return reply
        .code(409)
        .send({
          error: 'Adopted integrations are reconciled through the AppPort capability reconciliation.start',
        });
    }
    await deps.boss.send(QUEUES.reconcile, { integrationId: id, incidentId: null, trigger: 'manual' });
    await db.insert(auditLog).values({
      actorUserId: req.user!.id,
      actorRole: 'operator',
      action: 'integration.reconcile',
      targetType: 'integration',
      targetId: id,
    });
    return { queued: true };
  });

  app.post('/api/operator/integrations/:id/sync', { preHandler: auth }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!uuid.safeParse(id).success) return reply.code(404).send({ error: 'Not found' });
    await deps.boss.send(
      QUEUES.sync,
      { integrationId: id, trigger: 'manual', mode: 'auto' },
      { singletonKey: `sync:${id}` },
    );
    await db.insert(auditLog).values({
      actorUserId: req.user!.id,
      actorRole: 'operator',
      action: 'integration.sync',
      targetType: 'integration',
      targetId: id,
    });
    return { queued: true };
  });

  /** Unit economics derived from durable state (spec §23). Human hours are not tracked automatically. */
  app.get('/api/operator/metrics', { preHandler: auth }, async () => {
    const incs = await db.select().from(incidents);
    const resolved = incs.filter((i) => i.resolvedAt);
    const mttrMin = resolved.length
      ? Math.round(
          resolved.reduce((s, i) => s + (i.resolvedAt!.getTime() - i.detectedAt.getTime()), 0) /
            resolved.length /
            60000,
        )
      : null;
    const mrs = await db.select().from(maintenanceRuns);
    const autoResolved = resolved.filter((i) => !mrs.some((m) => m.incidentId === i.id));
    const cands = await db.select().from(repairCandidates);
    const vals = await db.select().from(validationRuns);
    const runs = await db.select({ status: syncRuns.status }).from(syncRuns);
    const tenantCount = (await db.select().from(tenants)).length || 1;
    const modelUsd = mrs.reduce(
      (s, m) => s + Number((m.cost as { estimatedUsd?: number })?.estimatedUsd ?? 0),
      0,
    );
    const humanDecisions = mrs.reduce((s, m) => s + ((m.humanDecisions as unknown[]) ?? []).length, 0);
    return {
      tenants: tenantCount,
      incidents: {
        total: incs.length,
        open: incs.length - resolved.length,
        perTenant: Number((incs.length / tenantCount).toFixed(2)),
        mttrMinutes: mttrMin,
      },
      recovery: {
        resolved: resolved.length,
        automaticallyRecovered: autoResolved.length,
        automaticRecoveryRate: resolved.length
          ? Number((autoResolved.length / resolved.length).toFixed(2))
          : null,
      },
      maintenance: {
        runs: mrs.length,
        candidates: cands.length,
        agentRepairRate: mrs.length
          ? Number((mrs.filter((m) => m.status === 'candidate_submitted').length / mrs.length).toFixed(2))
          : null,
        validationPassRate: vals.length
          ? Number((vals.filter((v) => v.status === 'passed').length / vals.length).toFixed(2))
          : null,
        modelCostUsd: Number(modelUsd.toFixed(4)),
        humanDecisions,
      },
      syncRuns: { total: runs.length, failed: runs.filter((r) => r.status === 'failed').length },
      notMeasured: [
        'Human intervention hours (log manually in RUNBOOK)',
        'Hosting cost',
        'Contribution margin',
        'Onboarding time',
      ],
    };
  });

  app.get('/api/operator/audit', { preHandler: auth }, async () =>
    db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(200),
  );
}
