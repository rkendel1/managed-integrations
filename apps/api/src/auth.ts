/**
 * Session authentication: scrypt password hashes, opaque session tokens (only their sha256 is
 * stored), httpOnly cookies, and a per-session CSRF token required on every mutating request.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sessions, users, type Db } from '@mi/database';
import { sha256Hex } from '@mi/integration-shopify-netsuite';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
export const SESSION_COOKIE = 'mi_session';
const SESSION_TTL_MS = 12 * 3600_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

export interface SessionUser {
  id: string;
  email: string;
  role: 'customer' | 'operator';
  tenantId: string | null;
  csrfToken: string;
  /** AppPort needs a stable session id and its expiry for the identity it authorizes against. */
  sessionId: string;
  sessionCreatedAt: Date;
  sessionExpiresAt: Date;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

export async function createSession(
  db: Db,
  userId: string,
): Promise<{ token: string; csrfToken: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ id: sha256Hex(token), userId, csrfToken, expiresAt });
  return { token, csrfToken, expiresAt };
}

export async function loadSession(db: Db, token: string | undefined): Promise<SessionUser | undefined> {
  if (!token) return undefined;
  const [row] = await db
    .select({ s: sessions, u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sha256Hex(token)), gt(sessions.expiresAt, new Date())));
  if (!row) return undefined;
  return {
    id: row.u.id,
    email: row.u.email,
    role: row.u.role as SessionUser['role'],
    tenantId: row.u.tenantId,
    csrfToken: row.s.csrfToken,
    sessionId: row.s.id,
    sessionCreatedAt: row.s.createdAt,
    sessionExpiresAt: row.s.expiresAt,
  };
}

export async function destroySession(db: Db, token: string | undefined) {
  if (token) await db.delete(sessions).where(eq(sessions.id, sha256Hex(token)));
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** preHandler: requires a session with the given role, and a valid CSRF header on mutations. */
export function requireRole(db: Db, role: 'customer' | 'operator') {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await loadSession(db, req.cookies[SESSION_COOKIE]);
    if (!user) return reply.code(401).send({ error: 'Not authenticated' });
    if (user.role !== role) return reply.code(403).send({ error: 'Forbidden' });
    if (role === 'customer' && !user.tenantId) return reply.code(403).send({ error: 'No tenant' });
    if (!SAFE_METHODS.has(req.method)) {
      const header = req.headers['x-csrf-token'];
      const a = Buffer.from(String(header ?? ''));
      const b = Buffer.from(user.csrfToken);
      if (a.length !== b.length || !timingSafeEqual(a, b))
        return reply.code(403).send({ error: 'Invalid CSRF token' });
    }
    req.user = user;
  };
}
