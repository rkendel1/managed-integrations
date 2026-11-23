/**
 * Wires the AppPort capaability runtime to the API's durable session store.
 *
 * The browser and MCP clients both authenticate with the existing httpOnly session cookie. The
 * cookie is verified against PostgreSQL on every capability call, so signing out or expiring a
 * session immediately removes authority from every projection.
 */
import {
  APPPORT_APPLICATION,
  createAppPortRuntime,
  toAppPortIdentity,
  type AppPortLogger,
  type AppPortRuntime,
  type CallerHeaders,
} from '@mi/capabilities';
import type { Db } from '@mi/database';
import { loadSession, SESSION_COOKIE } from './auth.ts';

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Minimal cookie reader; session tokens are base64url and need no decoding. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function pinoToAppPortLogger(log: {
  debug: (obj: object, msg: string) => void;
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}): AppPortLogger {
  const write = (method: 'debug' | 'info' | 'warn' | 'error') => (message: string, fields?: object) =>
    log[method]({ appport: true, ...(fields ?? {}) }, message);
  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
  };
}

export function createApiAppPortRuntime(deps: {
  db: Db;
  logger?: AppPortLogger;
}): AppPortRuntime {
  const resolveIdentity = async (headers: CallerHeaders) => {
    const token = readCookie(firstHeader(headers['cookie']), SESSION_COOKIE);
    const user = await loadSession(deps.db, token);
    if (!user) return undefined;
    return toAppPortIdentity(
      {
        userId: user.id,
        email: user.email,
        role: user.role,
        tenantId: user.tenantId,
        sessionId: user.sessionId,
        sessionCreatedAt: user.sessionCreatedAt,
        sessionExpiresAt: user.sessionExpiresAt,
      },
      APPPORT_APPLICATION.id,
    );
  };

  return createAppPortRuntime({
    db: deps.db,
    resolveIdentity,
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
}
