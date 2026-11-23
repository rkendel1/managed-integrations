/**
 * Trusted identity mapping: an authenticated application session (a row in `sessions`, joined to
 * `users`) becomes the AppPort `Session`/`Principal` a capability is authorized against.
 *
 * AppPort deliberately does not authenticate callers. The host resolves the caller from the
 * transport's credentials and hands AppPort the resulting identity, so every capability
 * invocation is authorized against exactly what this module derived — never against fields the
 * caller supplied in capability input.
 */
import type { JsonValue, Principal, Session } from '@appport/protocol';

/** Permissions are the AppPort authorization vocabulary for this application. */
export const AppPortPermissions = {
  /** Read integrations belonging to the caller's own tenant. */
  read: 'integrations.read',
  /** Read integrations for any tenant (operators only). */
  readAny: 'integrations.read:any',
  /** Request recovery operations (e.g. delivery retry) on the caller's own tenant. */
  operate: 'integrations.operate',
  /** Request recovery operations on any tenant (operators only). */
  operateAny: 'integrations.operate:any',
} as const;

export type AppPortPermission = (typeof AppPortPermissions)[keyof typeof AppPortPermissions];

/** The authenticated application caller, as resolved from the durable session cookie. */
export interface AuthenticatedCaller {
  userId: string;
  email: string;
  role: 'customer' | 'operator';
  tenantId: string | null;
  sessionId: string;
  sessionCreatedAt: Date;
  sessionExpiresAt: Date;
}

export interface AppPortIdentity {
  session: Session;
  principal: Principal;
}

/** Permissions are derived from the durable role and tenant, never from request input. */
export function permissionsFor(caller: AuthenticatedCaller): AppPortPermission[] {
  if (caller.role === 'operator') {
    return [
      AppPortPermissions.read,
      AppPortPermissions.readAny,
      AppPortPermissions.operate,
      AppPortPermissions.operateAny,
    ];
  }
  if (caller.tenantId) return [AppPortPermissions.read, AppPortPermissions.operate];
  return [];
}

/** Reads the tenant id from trusted principal attributes. */
export function tenantIdOf(principal: Principal | undefined): string | undefined {
  const value = principal?.attributes?.['tenantId'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Builds the AppPort session and principal for an authenticated caller.
 *
 * `session.id` is the durable application session id, so it is stable for the whole browser or
 * MCP client session (AppPort scopes idempotency keys to it).
 */
export function toAppPortIdentity(caller: AuthenticatedCaller, applicationId: string): AppPortIdentity {
  const attributes: Record<string, JsonValue> = {
    role: caller.role,
    ...(caller.tenantId ? { tenantId: caller.tenantId } : {}),
  };
  const principal: Principal = {
    id: caller.userId,
    type: 'user',
    displayName: caller.email,
    attributes,
  };
  const session: Session = {
    id: caller.sessionId,
    applicationId,
    createdAt: caller.sessionCreatedAt.toISOString(),
    expiresAt: caller.sessionExpiresAt.toISOString(),
    principal,
    permissions: permissionsFor(caller),
    attributes,
  };
  return { session, principal };
}
