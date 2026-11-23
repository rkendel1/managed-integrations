/**
 * Maintenance run orchestration: bounded context assembly, isolated worktree, planner loop,
 * durable outcome. The worktree runtime directory is destroyed afterwards; the branch/commit,
 * diff, tool log and test evidence are retained.
 */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { incidents, integrationVersions, maintenanceRuns, observations, type Db } from '@mi/database';
import { describeError, redact, type Logger } from '@mi/observability';
import { noteIncident } from '@mi/reliability';
import { git } from './exec.ts';
import { AGENT_EDITABLE_PREFIXES, FIXTURE_PROFILES } from './policy.ts';
import type { MaintenancePlanner } from './planners.ts';
import { installOffline, type SandboxConfig } from './sandbox.ts';
import { MaintenanceToolbox } from './toolbox.ts';

export interface MaintenanceDeps {
  db: Db;
  repoDir: string;
  workDir: string;
  sandbox: SandboxConfig;
  planner: MaintenancePlanner;
  logger?: Logger;
  onCandidate?: (candidateId: string) => Promise<void>;
}

export async function runMaintenance(deps: MaintenanceDeps, maintenanceRunId: string): Promise<{ status: string; candidateId: string | null }> {
  const { db } = deps;
  const [mr] = await db.select().from(maintenanceRuns).where(eq(maintenanceRuns.id, maintenanceRunId));
  if (!mr) throw new Error('maintenance run not found');
  if (mr.status !== 'queued') return { status: mr.status, candidateId: null };
  const [base] = mr.baseVersionId ? await db.select().from(integrationVersions).where(eq(integrationVersions.id, mr.baseVersionId)) : [];
  if (!base) {
    await db.update(maintenanceRuns).set({ status: 'failed', outcome: 'No base implementation version recorded; cannot create an isolated workspace.', finishedAt: new Date() }).where(eq(maintenanceRuns.id, mr.id));
    return { status: 'failed', candidateId: null };
  }

  // Bounded, sanitized context: what the agent is told up front (it can read more via tools).
  const [inc] = mr.incidentId ? await db.select().from(incidents).where(eq(incidents.id, mr.incidentId)) : [];
  const obs = await db.select().from(observations).where(eq(observations.integrationId, mr.integrationId!)).orderBy(desc(observations.createdAt)).limit(10);
  const context = redact({
    incident: inc ? { id: inc.id, kind: inc.kind, reason: inc.reason, errorClass: inc.errorClass } : null,
    recentObservations: obs.map((o) => ({ kind: o.kind, code: o.code, message: o.message.slice(0, 300) })),
    baseVersion: { id: base.id, sourceCommit: base.sourceCommit },
    editablePaths: AGENT_EDITABLE_PREFIXES,
    fixtureProfiles: FIXTURE_PROFILES,
    secretsAvailable: false,
  }) as object;

  const branch = `repair/${mr.id.slice(0, 8)}`;
  const worktree = join(resolve(deps.workDir), `mr-${mr.id.slice(0, 8)}`);
  await db.update(maintenanceRuns).set({ status: 'investigating', planner: deps.planner.name, context, startedAt: new Date(), agentSessionRef: branch }).where(eq(maintenanceRuns.id, mr.id));
  if (mr.incidentId) await noteIncident(db, mr.incidentId, `Maintenance investigation started (planner: ${deps.planner.name}) on isolated branch ${branch}.`);

  const started = Date.now();
  let candidateId: string | null = null;
  let status = 'failed';
  try {
    await mkdir(resolve(deps.workDir), { recursive: true });
    await git(deps.repoDir, ['worktree', 'add', '-q', '-b', branch, worktree, base.sourceCommit]);
    const install = await installOffline(worktree);
    if (install.code !== 0) throw new Error(`offline dependency install failed: ${(install.stdout + install.stderr).slice(-800)}`);

    const toolbox = new MaintenanceToolbox({
      db,
      maintenanceRunId: mr.id,
      incidentId: mr.incidentId,
      integrationId: mr.integrationId!,
      worktree,
      baseCommit: base.sourceCommit,
      baseVersionId: base.id,
      branch,
      sandbox: deps.sandbox,
      ...(deps.onCandidate ? { onSubmitted: deps.onCandidate } : {}),
    });
    const result = await deps.planner.run(toolbox);
    candidateId = toolbox.submittedCandidateId;
    status = result.outcome;
    await db
      .update(maintenanceRuns)
      .set({
        status,
        hypothesis: result.hypothesis,
        outcome: result.summary,
        cost: { ...result.cost, wallMs: Date.now() - started, toolCalls: toolbox.calls.length, sandboxTestRuns: toolbox.testRuns.length },
        toolCalls: toolbox.calls,
        finishedAt: new Date(),
      })
      .where(eq(maintenanceRuns.id, mr.id));
    if (mr.incidentId) {
      await noteIncident(
        db,
        mr.incidentId,
        candidateId ? 'A repair candidate was produced and submitted for independent validation and human review.' : `Maintenance did not produce a candidate: ${result.summary}`,
        { customerVisible: !!candidateId },
      );
    }
  } catch (err) {
    deps.logger?.error({ err: describeError(err) }, 'maintenance run failed');
    await db.update(maintenanceRuns).set({ status: 'failed', outcome: describeError(err).message, finishedAt: new Date(), cost: { wallMs: Date.now() - started } }).where(eq(maintenanceRuns.id, mr.id));
  } finally {
    // Destroy the runtime workspace; the branch and commit remain as durable evidence.
    await git(deps.repoDir, ['worktree', 'remove', '--force', worktree]).catch(() => undefined);
  }
  return { status, candidateId };
}
