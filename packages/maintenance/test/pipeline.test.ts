/**
 * End-to-end maintenance pipeline against the deterministic fixtures:
 * healthy → (fixture) schema drift → detection → incident → agent (playbook) in isolated worktree →
 * candidate → independent validation in the Docker sandbox → human approval → canary → release →
 * post-release reconciliation → incident resolved.
 *
 * Runs against a disposable clone of this repository (repair branches never touch the real repo).
 * Requires Docker; skipped with an explicit message otherwise.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { incidentEvents, incidents, integrations, maintenanceRuns, releases, repairCandidates, validationRuns } from '@mi/database';
import { buildRuntime } from '@mi/integration-shopify-netsuite';
import { evaluateIntegration } from '@mi/reliability';
import { approveCandidate, buildVersionFromCommit, DEFAULT_SANDBOX, PlaybookPlanner, runMaintenance, runRelease, validateCandidate } from '../src/index.ts';
import { createHarness, FAST_RETRY, testCipher, type Harness } from '../../../test/support/harness.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const dockerOk = (() => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!dockerOk)('maintenance pipeline (requires Docker)', () => {
  let h: Harness;
  let work: string;
  let clone: string;
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'mi-pipeline-'));
    clone = join(work, 'repo');
    execFileSync('git', ['clone', '-q', '--no-hardlinks', REPO, clone]);
    h = await createHarness();
  }, 120_000);
  afterAll(async () => {
    await h?.close();
    rmSync(work, { recursive: true, force: true });
  });

  it('detects drift, repairs via isolated agent, validates independently, releases with canary, and verifies', async () => {
    const { db } = h.dbh;
    const artifactDir = join(work, 'artifacts');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clone }).toString().trim();
    const baseVersion = await buildVersionFromCommit(db, { repoDir: clone, workDir: join(work, 'wt'), artifactDir, commit: head, releaseState: 'released' });
    await db.update(integrations).set({ implementationVersionId: baseVersion }).where(eq(integrations.id, h.integrationId));
    const rt = (opts?: { useCanary?: boolean }) =>
      buildRuntime({ db, cipher: testCipher, endpoints: h.endpoints, workerId: 'pipeline-test', retry: FAST_RETRY }, h.integrationId, opts);

    // 1-3. Healthy: deliver with the released artifact.
    h.shopify.control.seedOrders(6, { start: new Date(Date.now() - 3600_000), stepMs: 60_000 });
    const healthy = await (await rt()).engine.run({ integrationId: h.integrationId, trigger: 'schedule' });
    expect(healthy.status).toBe('succeeded');
    expect(h.netsuite.state.salesOrders.size).toBe(6);

    // 4-7. Controlled upstream change (FIXTURE) → failure → detection → incident.
    h.shopify.control.setVariant('drift');
    h.shopify.control.seedOrders(4, { start: new Date(Date.now() - 600_000), stepMs: 30_000 });
    const failed = await (await rt()).engine.run({ integrationId: h.integrationId, trigger: 'schedule' });
    expect(failed.status).toBe('failed');
    expect(failed.errorClass).toBe('schema');
    const ev = await evaluateIntegration(db, h.integrationId);
    expect(ev.actions.some((a) => a.type === 'maintenance')).toBe(true);
    const [inc] = await db.select().from(incidents).where(eq(incidents.kind, 'schema_drift'));
    expect(inc!.status).toBe('investigating');

    // 9-12. Maintenance agent in an isolated worktree (deterministic playbook planner).
    const [mr] = await db.insert(maintenanceRuns).values({ incidentId: inc!.id, integrationId: h.integrationId, trigger: 'incident', status: 'queued', baseVersionId: baseVersion }).returning();
    const sandbox = { ...DEFAULT_SANDBOX, mode: 'docker' as const };
    const m = await runMaintenance({ db, repoDir: clone, workDir: join(work, 'wt'), sandbox, planner: new PlaybookPlanner() }, mr!.id);
    const [mrRow] = await db.select().from(maintenanceRuns).where(eq(maintenanceRuns.id, mr!.id));
    expect(m.status, JSON.stringify({ outcome: mrRow!.outcome, tools: (mrRow!.toolCalls as { tool: string; ok: boolean; result: string }[]).map((t) => `${t.tool}:${t.ok}:${t.result.slice(0, 300)}`) }, null, 1)).toBe('candidate_submitted');
    const [cand] = await db.select().from(repairCandidates).where(eq(repairCandidates.id, m.candidateId!));
    expect(cand!.changedFiles.every((f) => f.startsWith('packages/integration-shopify-netsuite/src/implementation/') || f.startsWith('packages/integration-shopify-netsuite/test/regression/'))).toBe(true);
    expect(cand!.changedFiles.some((f) => f.includes('/test/acceptance/'))).toBe(false);
    expect(cand!.diff).toContain('preDiscountUnitPriceSet');
    const [mrDone] = await db.select().from(maintenanceRuns).where(eq(maintenanceRuns.id, mr!.id));
    expect((mrDone!.toolCalls as unknown[]).length).toBeGreaterThan(5);

    // 13. Independent validation (fresh tree from base + editable changes only, Docker sandbox).
    const v = await validateCandidate({ db, repoDir: clone, workDir: join(work, 'wt'), artifactDir, sandbox }, cand!.id);
    expect(v.status).toBe('passed');
    const [vr] = await db.select().from(validationRuns).where(eq(validationRuns.id, v.validationRunId));
    expect(vr!.protectedPathsOk).toBe(true);
    expect((vr!.results as { reproductionProfile: string }).reproductionProfile).toBe('drift');

    // Approval cannot be skipped: an unvalidated path is refused (checked in release.test), here a human approves.
    const operatorId = '00000000-0000-4000-8000-000000000001';
    const { releaseId } = await approveCandidate(db, { candidateId: cand!.id, operatorUserId: operatorId, note: 'reviewed diff + validation' });

    // 15-18. Canary → promote → catch-up → post-release reconciliation → resolved.
    const rel = await runRelease({ db, releaseId, buildRuntime: (_id, o) => rt(o), retry: FAST_RETRY, canaryLimit: 2 });
    expect(rel.status).toBe('released');
    const [relRow] = await db.select().from(releases).where(eq(releases.id, releaseId));
    expect(relRow!.postReleaseReconciliationId).not.toBeNull();
    const [integ] = await db.select().from(integrations).where(eq(integrations.id, h.integrationId));
    expect(integ!.implementationVersionId).toBe(cand!.integrationVersionId);
    expect(integ!.canaryVersionId).toBeNull();
    expect(h.netsuite.state.salesOrders.size).toBe(10);

    const [resolved] = await db.select().from(incidents).where(eq(incidents.id, inc!.id));
    expect(resolved!.status).toBe('resolved');
    expect((resolved!.verification as { missing: number; duplicates: number }).missing).toBe(0);
    const timeline = (await db.select().from(incidentEvents).where(eq(incidentEvents.incidentId, inc!.id))).map((e) => e.toStatus);
    expect(timeline).toEqual(expect.arrayContaining(['detected', 'classified', 'investigating', 'recovery', 'verification', 'resolved']));
  }, 900_000);
});
