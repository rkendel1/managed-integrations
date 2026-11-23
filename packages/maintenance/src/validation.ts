/**
 * Independent validation of a repair candidate. Independence comes from construction, not trust:
 *  1. The candidate's diff is checked: any change outside agent-editable paths fails validation.
 *  2. A FRESH worktree is created at the base commit and only the editable-path changes are applied.
 *     The authoritative suite therefore comes from the base commit, never from the candidate.
 *  3. The authoritative suite files are hashed at the base commit and in the validation tree; they must match.
 *  4. Typecheck, acceptance (reproducing profile), regression tests run in the isolated sandbox.
 *  5. On success the implementation is bundled into an immutable artifact and registered as a version.
 * The candidate's own test results are recorded but never used for the decision.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { maintenanceRuns, repairCandidates, validationRuns, integrations, type Db } from '@mi/database';
import { describeError, type Logger } from '@mi/observability';
import { noteIncident } from '@mi/reliability';
import { buildImplementationArtifact, registerVersion } from './artifacts.ts';
import { git } from './exec.ts';
import {
  AGENT_EDITABLE_PREFIXES,
  isAgentEditable,
  PROTECTED_SUITE_PREFIXES,
  type FixtureProfile,
  type TestTarget,
} from './policy.ts';
import { installOffline, runTestsInSandbox, type SandboxConfig } from './sandbox.ts';

export interface ValidationDeps {
  db: Db;
  repoDir: string;
  workDir: string;
  artifactDir: string;
  sandbox: SandboxConfig;
  logger?: Logger;
}

async function suiteFiles(repoDir: string, commit: string): Promise<string[]> {
  const out = await git(repoDir, ['ls-tree', '-r', '--name-only', commit, '--', ...PROTECTED_SUITE_PREFIXES]);
  return out.split('\n').filter(Boolean).sort();
}

export async function hashSuiteAtCommit(repoDir: string, commit: string): Promise<string> {
  const h = createHash('sha256');
  for (const f of await suiteFiles(repoDir, commit)) {
    h.update(f);
    h.update(await git(repoDir, ['show', `${commit}:${f}`]));
  }
  return h.digest('hex');
}

async function hashSuiteInTree(repoDir: string, commit: string, tree: string): Promise<string> {
  const h = createHash('sha256');
  for (const f of await suiteFiles(repoDir, commit)) {
    h.update(f);
    h.update(await readFile(join(tree, f), 'utf8'));
  }
  return h.digest('hex');
}

/** Determines the provider profile that reproduces the failure, from the agent's recorded evidence. */
function reproductionProfile(agentResults: unknown): FixtureProfile {
  const runs =
    (agentResults as { runs?: { target: string; profile: FixtureProfile; passed: boolean }[] })?.runs ?? [];
  const failedFirst = runs.find((r) => !r.passed);
  return failedFirst?.profile ?? 'baseline';
}

export async function validateCandidate(
  deps: ValidationDeps,
  candidateId: string,
): Promise<{ status: 'passed' | 'failed' | 'error'; validationRunId: string }> {
  const { db } = deps;
  const [cand] = await db.select().from(repairCandidates).where(eq(repairCandidates.id, candidateId));
  if (!cand || !cand.commitSha) throw new Error('candidate not found or not committed');
  const [mr] = await db.select().from(maintenanceRuns).where(eq(maintenanceRuns.id, cand.maintenanceRunId));
  const [integ] = mr?.integrationId
    ? await db.select().from(integrations).where(eq(integrations.id, mr.integrationId))
    : [];
  const suiteSha = await hashSuiteAtCommit(deps.repoDir, cand.baseCommit);
  const [vr] = await db
    .insert(validationRuns)
    .values({
      repairCandidateId: cand.id,
      contractVersion: integ?.contractVersion ?? 'unknown',
      testSuiteSha256: suiteSha,
      candidateCommit: cand.commitSha,
      status: 'running',
    })
    .returning();
  await db.update(repairCandidates).set({ status: 'validating' }).where(eq(repairCandidates.id, cand.id));

  const tree = join(resolve(deps.workDir), `val-${vr!.id.slice(0, 8)}`);
  const results: Record<string, unknown> = {};
  let status: 'passed' | 'failed' | 'error' = 'failed';
  try {
    const changed = (await git(deps.repoDir, ['diff', '--name-only', cand.baseCommit, cand.commitSha]))
      .split('\n')
      .filter(Boolean);
    const violations = changed.filter((f) => !isAgentEditable(f));
    results.changedFiles = changed;
    if (violations.length) {
      results.protectedPathViolations = violations;
      await finish('failed', false);
      return { status: 'failed', validationRunId: vr!.id };
    }

    await git(deps.repoDir, ['worktree', 'add', '-q', '--detach', tree, cand.baseCommit]);
    const patch = await git(deps.repoDir, [
      'diff',
      '--binary',
      cand.baseCommit,
      cand.commitSha,
      '--',
      ...AGENT_EDITABLE_PREFIXES,
    ]);
    if (patch.trim()) await git(tree, ['apply', '--whitespace=nowarn', '-'], patch);
    const treeSha = await hashSuiteInTree(deps.repoDir, cand.baseCommit, tree);
    const protectedOk = treeSha === suiteSha;
    results.suiteSha256 = { base: suiteSha, validationTree: treeSha };
    if (!protectedOk) {
      await finish('failed', false);
      return { status: 'failed', validationRunId: vr!.id };
    }
    const install = await installOffline(tree);
    if (install.code !== 0)
      throw new Error(`offline install failed: ${(install.stdout + install.stderr).slice(-800)}`);

    const profile = reproductionProfile(cand.agentTestResults);
    results.reproductionProfile = profile;
    const suites: TestTarget[] = ['typecheck', 'unit', 'acceptance', 'regression'];
    const suiteResults: Record<string, unknown> = {};
    let allPassed = true;
    for (const s of suites) {
      const r = await runTestsInSandbox(tree, s, profile, deps.sandbox);
      suiteResults[s] = {
        passed: r.passed,
        isolated: r.isolated,
        durationMs: r.durationMs,
        summary: r.summary,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
      };
      if (!r.passed) allPassed = false;
    }
    results.suites = suiteResults;
    results.agentResultsIgnoredForDecision = true;

    if (allPassed) {
      const art = await buildImplementationArtifact(tree, deps.artifactDir, cand.commitSha);
      const versionId = await registerVersion(db, {
        sourceCommit: cand.commitSha,
        artifactPath: art.path,
        artifactSha256: art.sha256,
        releaseState: 'validated',
        parentVersionId: cand.baseVersionId,
      });
      results.artifact = { versionId, sha256: art.sha256 };
      await db
        .update(repairCandidates)
        .set({ integrationVersionId: versionId })
        .where(eq(repairCandidates.id, cand.id));
      await finish('passed', true);
    } else {
      await finish('failed', true);
    }
  } catch (err) {
    results.error = describeError(err).message;
    deps.logger?.error({ err: describeError(err) }, 'validation error');
    await finish('error', null);
  } finally {
    await git(deps.repoDir, ['worktree', 'remove', '--force', tree]).catch(() => undefined);
  }
  return { status, validationRunId: vr!.id };

  async function finish(s: 'passed' | 'failed' | 'error', protectedOk: boolean | null) {
    status = s;
    await db
      .update(validationRuns)
      .set({
        status: s,
        protectedPathsOk: protectedOk,
        results,
        finishedAt: new Date(),
        sandbox: { mode: deps.sandbox.mode, image: deps.sandbox.nodeImage },
      })
      .where(eq(validationRuns.id, vr!.id));
    await db
      .update(repairCandidates)
      .set({ status: s === 'passed' ? 'validated' : 'validation_failed' })
      .where(eq(repairCandidates.id, cand!.id));
    if (mr?.incidentId) {
      await noteIncident(
        db,
        mr.incidentId,
        s === 'passed'
          ? 'Repair candidate passed independent validation; awaiting human approval.'
          : `Repair candidate failed independent validation (${s}).`,
        { customerVisible: false },
      );
    }
  }
}
