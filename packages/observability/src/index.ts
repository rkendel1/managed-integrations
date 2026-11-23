import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import pino, { type Logger } from 'pino';

/**
 * Correlation context carried through async execution (API request, job, sync run).
 * traceId uses W3C trace-context format (32 hex) so it can be adopted by OpenTelemetry later.
 */
export interface CorrelationContext {
  correlationId: string;
  traceId: string;
  tenantId?: string;
  integrationId?: string;
  syncRunId?: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

export function newCorrelationId(): string {
  return randomUUID();
}

export function withCorrelation<T>(ctx: Partial<CorrelationContext>, fn: () => T): T {
  const parent = storage.getStore();
  const merged: CorrelationContext = {
    correlationId: ctx.correlationId ?? parent?.correlationId ?? newCorrelationId(),
    traceId: ctx.traceId ?? parent?.traceId ?? newTraceId(),
    ...(parent ?? {}),
    ...stripUndefined(ctx),
  } as CorrelationContext;
  return storage.run(merged, fn);
}

export function currentCorrelation(): CorrelationContext | undefined {
  return storage.getStore();
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Keys whose values are always secret. Matching is case-insensitive and substring based
 * so that `shopifyAccessToken`, `refresh_token`, `client_secret`, `Authorization` are all caught.
 */
const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|authorization|cookie|api[-_]?key|private[-_]?key|assertion|credential|ciphertext|encryption[-_]?key)/i;

/** Values that look like secrets even when the key is innocent. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bshp(at|ca|pa|ss|rt)_[A-Za-z0-9]{8,}\b/g, // Shopify token prefixes
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export const REDACTED = '[REDACTED]';

export function redactString(value: string): string {
  let out = value;
  for (const p of SECRET_VALUE_PATTERNS) out = out.replace(p, REDACTED);
  return out;
}

/**
 * Deep-redacts an arbitrary value. Used for logs, observations, evidence and anything
 * that may be shown to the maintenance agent. Never mutates the input.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[TRUNCATED]';
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_PATTERN.test(k) && v != null && v !== '' ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

export function createLogger(name: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    name,
    level,
    base: { service: name },
    redact: {
      paths: [
        '*.token',
        '*.accessToken',
        '*.refreshToken',
        '*.password',
        '*.secret',
        '*.clientSecret',
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-shopify-access-token"]',
        'headers.authorization',
        'headers["x-shopify-access-token"]',
      ],
      censor: REDACTED,
    },
    mixin() {
      const c = storage.getStore();
      return c ? { ...c } : {};
    },
    hooks: {
      logMethod(args, method) {
        // Redact any free-form strings (error messages can echo request bodies).
        const cleaned = args.map((a) => (typeof a === 'string' ? redactString(a) : redact(a)));
        return method.apply(this, cleaned as Parameters<typeof method>);
      },
    },
  });
}

export type { Logger };

/** Compact error serialisation that never includes secrets. */
export function describeError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: redactString(err.message) };
  return { name: 'NonError', message: redactString(String(err)) };
}
