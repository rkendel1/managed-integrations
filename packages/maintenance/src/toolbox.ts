/**
 * The maintenance agent's restricted tool interface. Every call is policy-checked, budgeted and
 * recorded durably (maintenance_runs.tool_calls). The toolbox has no access to credentials,
 * production shell, cursor state, customer records or deployment: there is simply no tool for it.
 */
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { incidents, integrationContracts, integrations, maintenanceRuns, observations, repairCandidates, type Db } from '@mi/database';
import { redact } from '@mi/observability';
import { git, run, tail } from './exec.ts';
import {
  AGENT_EDITABLE_PREFIXES,
  assertEditable,
  assertReadable,
  FIXTURE_PROFILES,
  isAgentEditable,
  PolicyViolation,
  TEST_TARGETS,
  type FixtureProfile,
  type TestTarget,
} from './policy.ts';
import { runTestsInSandbox, type SandboxConfig, type SandboxRun } from './sandbox.ts';

export interface ToolCallRecord {
  n: number;
  tool: string;
  args: unknown;
  ok: boolean;
  result: string;
  ms: number;
  at: string;
}

export interface ToolboxDeps {
  db: Db;
  maintenanceRunId: string;
  incidentId: string | null;
  integrationId: string;
  worktree: string;
  baseCommit: string;
  baseVersionId: string;
  branch: string;
  sandbox: SandboxConfig;
  maxToolCalls?: number;
  onSubmitted?: (candidateId: string) => Promise<void>;
}

export const TOOL_DEFINITIONS = [
  { name: 'read_incident', description: 'Read the incident under investigation (sanitized).', input: {} },
  { name: 'read_observations', description: 'Read recent sanitized provider observations (errors, anomalies) for the integration.', input: { limit: 'number (<=50)' } },
  { name: 'read_contract', description: 'Read the integration reliability contract (read-only).', input: {} },
  { name: 'list_dir', description: 'List a directory in the repair worktree.', input: { path: 'repo-relative path' } },
  { name: 'read_file', description: 'Read a file in the repair worktree.', input: { path: 'repo-relative path' } },
  { name: 'search_source', description: 'Search the repair worktree for a fixed string.', input: { pattern: 'string', path: 'optional repo-relative dir' } },
  { name: 'read_provider_docs', description: 'List (no name) or read provider documentation snapshots under docs/provider-docs.', input: { name: 'optional relative file name' } },
  { name: 'edit_file', description: `Replace an exact string in an editable file (${AGENT_EDITABLE_PREFIXES.join(', ')}).`, input: { path: 'string', old: 'string', new: 'string', all: 'boolean' } },
  { name: 'write_file', description: 'Create or overwrite an editable file (implementation or regression test).', input: { path: 'string', content: 'string' } },
  { name: 'run_tests', description: `Run an allowlisted test target in the isolated sandbox. Targets: ${Object.keys(TEST_TARGETS).join(', ')}. Profiles: ${FIXTURE_PROFILES.join(', ')}.`, input: { target: 'string', profile: 'string' } },
  { name: 'git_diff', description: 'Show the diff of the worktree against the base implementation version.', input: {} },
  { name: 'submit_candidate', description: 'Commit editable changes and submit the repair candidate for independent validation and human review.', input: { hypothesis: 'string' } },
] as const;

export class MaintenanceToolbox {
  readonly calls: ToolCallRecord[] = [];
  readonly testRuns: SandboxRun[] = [];
  submittedCandidateId: string | null = null;
  private readonly max: number;

  constructor(private readonly d: ToolboxDeps) {
    this.max = d.maxToolCalls ?? 60;
  }

  /** Single entry point used by every planner. */
  async invoke(tool: string, args: Record<string, unknown> = {}): Promise<string> {
    if (this.calls.length >= this.max) throw new PolicyViolation(`Tool budget of ${this.max} calls exhausted`);
    const started = Date.now();
    let ok = true;
    let result: string;
    try {
      result = await this.dispatch(tool, args);
    } catch (err) {
      ok = false;
      result = `ERROR: ${(err as Error).message}`;
    }
    const rec: ToolCallRecord = {
      n: this.calls.length + 1,
      tool,
      args: redact(summarizeArgs(args)),
      ok,
      result: String(redact(result.slice(0, 1500))),
      ms: Date.now() - started,
      at: new Date().toISOString(),
    };
    this.calls.push(rec);
    await this.d.db.update(maintenanceRuns).set({ toolCalls: this.calls }).where(eq(maintenanceRuns.id, this.d.maintenanceRunId));
    return result;
  }

  private path(p: string): string {
    return join(this.d.worktree, p);
  }

  private async dispatch(tool: string, a: Record<string, unknown>): Promise<string> {
    switch (tool) {
      case 'read_incident': {
        if (!this.d.incidentId) return 'No incident linked.';
        const [i] = await this.d.db.select().from(incidents).where(eq(incidents.id, this.d.incidentId));
        if (!i) return 'Incident not found.';
        return JSON.stringify(redact({ kind: i.kind, status: i.status, severity: i.severity, title: i.title, reason: i.reason, errorClass: i.errorClass, affectedScope: i.affectedScope, detectedAt: i.detectedAt }), null, 2);
      }
      case 'read_observations': {
        const limit = Math.min(Number(a.limit ?? 20), 50);
        const rows = await this.d.db.select().from(observations).where(eq(observations.integrationId, this.d.integrationId)).orderBy(desc(observations.createdAt)).limit(limit);
        return JSON.stringify(
          rows.map((r) => redact({ at: r.createdAt, provider: r.provider, kind: r.kind, errorClass: r.errorClass, code: r.code, message: r.message, data: r.data, implementationVersionId: r.implementationVersionId })),
          null,
          2,
        );
      }
      case 'read_contract': {
        const [integ] = await this.d.db.select().from(integrations).where(eq(integrations.id, this.d.integrationId));
        const [c] = await this.d.db.select().from(integrationContracts).where(eq(integrationContracts.version, integ!.contractVersion));
        return JSON.stringify(c?.definition ?? {}, null, 2);
      }
      case 'list_dir': {
        const p = assertReadable(String(a.path ?? '.'));
        const entries = await readdir(this.path(p), { withFileTypes: true });
        return entries.filter((e) => e.name !== 'node_modules' && e.name !== '.git').map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n');
      }
      case 'read_file': {
        const p = assertReadable(String(a.path));
        const s = await stat(this.path(p));
        if (s.size > 128 * 1024) throw new PolicyViolation('File too large to read (128KB limit)');
        return await readFile(this.path(p), 'utf8');
      }
      case 'search_source': {
        const pattern = String(a.pattern ?? '');
        if (!pattern || pattern.length > 200) throw new PolicyViolation('pattern must be 1..200 chars');
        const dir = assertReadable(String(a.path ?? '.'));
        const r = await run('rg', ['--fixed-strings', '--line-number', '--glob', '!node_modules', '--glob', '!.env*', '--glob', '!var/**', '--max-count', '50', '--', pattern, dir], { cwd: this.d.worktree, timeoutMs: 20_000 });
        return r.code === 1 ? 'No matches.' : tail(r.stdout, 6000);
      }
      case 'read_provider_docs': {
        const base = 'docs/provider-docs';
        if (!a.name) {
          const out: string[] = [];
          const walk = async (rel: string) => {
            for (const e of await readdir(this.path(join(base, rel)), { withFileTypes: true })) {
              const r = join(rel, e.name);
              if (e.isDirectory()) await walk(r);
              else out.push(r);
            }
          };
          await walk('');
          return out.join('\n');
        }
        const p = assertReadable(join(base, String(a.name)));
        if (!p.startsWith(`${base}/`)) throw new PolicyViolation('Docs path escapes docs/provider-docs');
        return await readFile(this.path(p), 'utf8');
      }
      case 'edit_file': {
        const p = assertEditable(String(a.path));
        const before = await readFile(this.path(p), 'utf8');
        const oldS = String(a.old ?? '');
        const newS = String(a.new ?? '');
        if (!oldS) throw new PolicyViolation('old must be non-empty');
        const count = before.split(oldS).length - 1;
        if (count === 0) throw new Error('old string not found');
        if (count > 1 && !a.all) throw new Error(`old string occurs ${count} times; pass all=true to replace every occurrence`);
        await writeFile(this.path(p), a.all ? before.split(oldS).join(newS) : before.replace(oldS, newS));
        return `Replaced ${a.all ? count : 1} occurrence(s) in ${p}`;
      }
      case 'write_file': {
        const p = assertEditable(String(a.path));
        const content = String(a.content ?? '');
        if (content.length > 64 * 1024) throw new PolicyViolation('Content too large');
        await mkdir(dirname(this.path(p)), { recursive: true });
        await writeFile(this.path(p), content);
        return `Wrote ${content.length} bytes to ${p}`;
      }
      case 'run_tests': {
        const target = String(a.target) as TestTarget;
        const profile = String(a.profile ?? 'baseline') as FixtureProfile;
        if (!(target in TEST_TARGETS)) throw new PolicyViolation(`Unknown test target ${target}`);
        if (!FIXTURE_PROFILES.includes(profile)) throw new PolicyViolation(`Unknown profile ${profile}`);
        const r = await runTestsInSandbox(this.d.worktree, target, profile, this.d.sandbox);
        this.testRuns.push(r);
        return `${r.passed ? 'PASSED' : 'FAILED'} (${target}, profile=${profile}, ${r.durationMs}ms, isolated=${r.isolated})\n${r.summary}\n---\n${tail(r.output, 3000)}`;
      }
      case 'git_diff':
        return tail(await git(this.d.worktree, ['diff', this.d.baseCommit, '--', '.']), 12_000) || 'No changes.';
      case 'submit_candidate':
        return this.submit(String(a.hypothesis ?? ''));
      default:
        throw new PolicyViolation(`Unknown tool ${tool}`);
    }
  }

  private async submit(hypothesis: string): Promise<string> {
    if (this.submittedCandidateId) throw new PolicyViolation('Candidate already submitted');
    if (hypothesis.trim().length < 20) throw new PolicyViolation('A hypothesis (>=20 chars) is required');
    const status = await git(this.d.worktree, ['status', '--porcelain', '--untracked-files=all']);
    const changed = status
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3).trim());
    if (!changed.length) throw new Error('No changes to submit');
    const forbidden = changed.filter((p) => !isAgentEditable(p));
    if (forbidden.length) throw new PolicyViolation(`Changes outside editable paths cannot be submitted: ${forbidden.join(', ')}`);
    await git(this.d.worktree, ['add', '--', ...AGENT_EDITABLE_PREFIXES.map((p) => p.replace(/\/$/, ''))]);
    await git(this.d.worktree, ['commit', '-q', '-m', `repair candidate (maintenance run ${this.d.maintenanceRunId})\n\n${hypothesis}`]);
    const commitSha = (await git(this.d.worktree, ['rev-parse', 'HEAD'])).trim();
    const diff = await git(this.d.worktree, ['diff', this.d.baseCommit, commitSha]);
    const files = (await git(this.d.worktree, ['diff', '--name-only', this.d.baseCommit, commitSha])).split('\n').filter(Boolean);
    const [cand] = await this.d.db
      .insert(repairCandidates)
      .values({
        maintenanceRunId: this.d.maintenanceRunId,
        baseVersionId: this.d.baseVersionId,
        baseCommit: this.d.baseCommit,
        branch: this.d.branch,
        commitSha,
        diff,
        changedFiles: files,
        hypothesis,
        agentTestResults: { runs: this.testRuns.map((r) => ({ target: r.target, profile: r.profile, passed: r.passed, isolated: r.isolated, summary: r.summary, durationMs: r.durationMs })) },
        status: 'submitted',
      })
      .returning();
    this.submittedCandidateId = cand!.id;
    await this.d.onSubmitted?.(cand!.id);
    return `Submitted candidate ${cand!.id} at ${commitSha.slice(0, 12)} (${files.length} files). It will be validated independently; the agent cannot approve or deploy it.`;
  }
}

function summarizeArgs(a: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) out[k] = typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…(${v.length} chars)` : v;
  return out;
}
