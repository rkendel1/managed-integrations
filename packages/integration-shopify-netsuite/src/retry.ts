import { ProviderError } from '@mi/contracts';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Injected for deterministic tests. Returns a value in [0, 1). */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 30_000 };

export const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Exponential backoff with "full jitter": delay = random(0, min(max, base * 2^(attempt-1))).
 * A provider Retry-After (or throttle restore estimate) is a floor, never shortened by jitter.
 */
export function computeBackoffMs(attempt: number, policy: RetryPolicy, retryAfterMs?: number): number {
  const rnd = policy.random ?? Math.random;
  const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.floor(rnd() * cap);
  if (retryAfterMs != null && retryAfterMs > 0) return Math.max(retryAfterMs, jittered);
  return jittered;
}

/** Parses Retry-After as delta-seconds or HTTP-date. Returns milliseconds, or undefined. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

export interface AttemptRecord {
  attempt: number;
  error?: { class: string; message: string; status?: number };
  delayMs?: number;
}

/**
 * Runs `fn` with retries for retryable ProviderErrors only. Non-retryable errors are thrown
 * immediately. `onAttempt` receives every attempt for durable evidence.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY,
  onAttempt?: (rec: AttemptRecord) => void | Promise<void>,
): Promise<T> {
  const sleep = policy.sleep ?? realSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      const v = await fn(attempt);
      await onAttempt?.({ attempt });
      return v;
    } catch (err) {
      const pe = err instanceof ProviderError ? err : undefined;
      const retryable = pe?.retryable ?? false;
      const last = attempt >= policy.maxAttempts;
      const delayMs = retryable && !last ? computeBackoffMs(attempt, policy, pe?.details.retryAfterMs) : undefined;
      await onAttempt?.({
        attempt,
        error: {
          class: pe?.errorClass ?? 'unknown',
          message: err instanceof Error ? err.message : String(err),
          ...(pe?.details.status != null ? { status: pe.details.status } : {}),
        },
        ...(delayMs != null ? { delayMs } : {}),
      });
      if (!retryable || last) throw err;
      await sleep(delayMs!);
    }
  }
}
