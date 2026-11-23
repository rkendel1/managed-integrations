/**
 * Isolated test execution for repair candidates.
 *
 * Docker mode (default): a disposable PostgreSQL sidecar and a test container on a dedicated
 * `--internal` network (no route to the internet or production), source mounted read-only,
 * all capabilities dropped, memory/CPU/pid limits and a wall-clock timeout. Both containers
 * and the network are destroyed afterwards; captured output is returned for durable evidence.
 *
 * Host mode exists only for development machines without Docker and is labelled NOT ISOLATED
 * in every result it produces.
 */
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { run, tail, type ExecResult } from './exec.ts';
import { TEST_TARGETS, type FixtureProfile, type TestTarget } from './policy.ts';

export interface SandboxConfig {
  mode: 'docker' | 'host';
  nodeImage: string;
  postgresImage: string;
  memory: string;
  cpus: string;
  timeoutMs: number;
  /** Host mode only. */
  hostDatabaseUrl?: string;
}

export const DEFAULT_SANDBOX: SandboxConfig = {
  mode: (process.env.SANDBOX_MODE as 'docker' | 'host') ?? 'docker',
  nodeImage: process.env.SANDBOX_NODE_IMAGE ?? 'mirror.gcr.io/library/node:22-bookworm-slim',
  postgresImage: process.env.SANDBOX_POSTGRES_IMAGE ?? 'mirror.gcr.io/library/postgres:16-alpine',
  memory: '2g',
  cpus: '2',
  timeoutMs: 10 * 60_000,
  ...(process.env.SANDBOX_HOST_DATABASE_URL
    ? { hostDatabaseUrl: process.env.SANDBOX_HOST_DATABASE_URL }
    : {}),
};

export interface SandboxRun {
  target: TestTarget;
  profile: FixtureProfile;
  passed: boolean;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  isolated: boolean;
  summary: string;
  output: string;
}

function summarize(out: string): string {
  const clean = out.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = clean.split('\n').filter((l) => /Test Files|Tests\s|error TS|FAIL|×/.test(l));
  return lines.slice(0, 20).join('\n').trim() || clean.trim().split('\n').slice(-3).join('\n');
}

/** Installs dependencies into a worktree from the local pnpm store only (no network). */
export async function installOffline(worktree: string): Promise<ExecResult> {
  const r = await run('pnpm', ['install', '--offline', '--frozen-lockfile'], {
    cwd: worktree,
    timeoutMs: 180_000,
  });
  await mkdir(join(worktree, 'node_modules', '.vite-temp'), { recursive: true });
  await mkdir(join(worktree, 'node_modules', '.vite'), { recursive: true });
  return r;
}

export async function runTestsInSandbox(
  worktree: string,
  target: TestTarget,
  profile: FixtureProfile,
  cfg: SandboxConfig = DEFAULT_SANDBOX,
): Promise<SandboxRun> {
  const cmd = [...TEST_TARGETS[target]];
  if (cfg.mode === 'host') {
    const r = await run(cmd[0]!, cmd.slice(1), {
      cwd: worktree,
      timeoutMs: cfg.timeoutMs,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NO_COLOR: '1',
        SHOPIFY_FIXTURE_PROFILE: profile,
        DATABASE_URL_TEST: cfg.hostDatabaseUrl ?? '',
      },
    });
    const output = tail(`${r.stdout}\n${r.stderr}`, 20_000);
    return {
      target,
      profile,
      passed: r.code === 0,
      exitCode: r.code,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
      isolated: false,
      summary: `[NOT ISOLATED: host mode]\n${summarize(output)}`,
      output,
    };
  }

  const id = randomBytes(4).toString('hex');
  const net = `mi-sbx-${id}`;
  const pg = `mi-sbx-pg-${id}`;
  const started = Date.now();
  try {
    const n = await run('docker', ['network', 'create', '--internal', net], { timeoutMs: 30_000 });
    if (n.code !== 0) throw new Error(`sandbox network: ${n.stderr}`);
    const p = await run(
      'docker',
      [
        'run',
        '-d',
        '--rm',
        '--name',
        pg,
        '--network',
        net,
        '--memory',
        '512m',
        '-e',
        'POSTGRES_USER=sandbox',
        '-e',
        'POSTGRES_PASSWORD=sandbox',
        '-e',
        'POSTGRES_DB=sandbox',
        '--tmpfs',
        '/var/lib/postgresql/data',
        cfg.postgresImage,
      ],
      { timeoutMs: 60_000 },
    );
    if (p.code !== 0) throw new Error(`sandbox postgres: ${p.stderr}`);
    for (let i = 0; i < 60; i++) {
      const ready = await run('docker', ['exec', pg, 'pg_isready', '-U', 'sandbox', '-d', 'sandbox'], {
        timeoutMs: 10_000,
      });
      if (ready.code === 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const r = await run(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        net,
        '--memory',
        cfg.memory,
        '--cpus',
        cfg.cpus,
        '--pids-limit',
        '512',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--tmpfs',
        '/tmp:rw,size=512m',
        '--tmpfs',
        '/work/node_modules/.vite-temp:rw',
        '--tmpfs',
        '/work/node_modules/.vite:rw',
        '-v',
        `${worktree}:/work:ro`,
        '-w',
        '/work',
        '-e',
        `DATABASE_URL_TEST=postgres://sandbox:sandbox@${pg}:5432/sandbox`,
        '-e',
        `SHOPIFY_FIXTURE_PROFILE=${profile}`,
        '-e',
        'HOME=/tmp',
        '-e',
        'NO_COLOR=1',
        cfg.nodeImage,
        ...cmd,
      ],
      { timeoutMs: cfg.timeoutMs },
    );
    const output = tail(`${r.stdout}\n${r.stderr}`, 20_000);
    return {
      target,
      profile,
      passed: r.code === 0 && !r.timedOut,
      exitCode: r.code,
      timedOut: r.timedOut,
      durationMs: Date.now() - started,
      isolated: true,
      summary: summarize(output),
      output,
    };
  } finally {
    await run('docker', ['rm', '-f', pg], { timeoutMs: 30_000 });
    await run('docker', ['network', 'rm', net], { timeoutMs: 30_000 });
  }
}
