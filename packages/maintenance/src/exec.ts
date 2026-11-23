import { execFile } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Runs a program with an argument vector (never a shell string), so agent-provided values can
 * never be interpreted as shell syntax. Output is captured and size-limited.
 */
export function run(
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string; maxBuffer?: number } = {},
): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: opts.maxBuffer ?? 20 * 1024 * 1024,
        killSignal: 'SIGKILL',
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        resolve({
          code: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          timedOut: !!e?.killed,
          durationMs: Date.now() - started,
        });
      },
    );
    if (opts.input != null) {
      child.stdin?.end(opts.input);
    }
  });
}

export async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const r = await run('git', ['-c', 'user.name=maintenance-agent', '-c', 'user.email=maintenance-agent@localhost', ...args], {
    cwd,
    timeoutMs: 60_000,
    ...(input != null ? { input } : {}),
  });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

/** Keeps the tail of long output (where test failures are reported). */
export function tail(s: string, max = 8000): string {
  return s.length <= max ? s : `…[truncated ${s.length - max} chars]…\n${s.slice(-max)}`;
}
