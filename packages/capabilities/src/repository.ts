/**
 * Durable read model for the `integrations.list` capability.
 *
 * Every query is constrained by a tenant id supplied by the authorization boundary, never by a
 * caller's claim: the capability handler passes the tenant derived from trusted identity.
 */
import { asc, eq } from 'drizzle-orm';
import { integrations, tenants, type Db } from '@mi/database';

export const INTEGRATION_LIFECYCLES = ['setup', 'active', 'paused'] as const;
export type IntegrationLifecycle = (typeof INTEGRATION_LIFECYCLES)[number];

export interface IntegrationSummary {
  id: string;
  tenantId: string;
  flowId: string;
  displayName: string;
  lifecycle: IntegrationLifecycle;
  configVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface TenantIntegrationList {
  tenant: { id: string; name: string };
  integrations: IntegrationSummary[];
}

/**
 * Lists the integrations of one tenant, newest first.
 *
 * Returns `undefined` when the tenant itself does not exist, so the capability can answer
 * `NOT_FOUND` without revealing whether another tenant exists.
 */
export async function listIntegrationsForTenant(
  db: Db,
  tenantId: string,
): Promise<TenantIntegrationList | undefined> {
  const rows = await db
    .select({
      id: integrations.id,
      tenantId: integrations.tenantId,
      flowId: integrations.flowType,
      displayName: integrations.displayName,
      lifecycle: integrations.lifecycle,
      configVersion: integrations.configVersion,
      createdAt: integrations.createdAt,
      updatedAt: integrations.updatedAt,
      tenantName: tenants.name,
    })
    .from(integrations)
    .innerJoin(tenants, eq(tenants.id, integrations.tenantId))
    .where(eq(integrations.tenantId, tenantId))
    .orderBy(asc(integrations.createdAt), asc(integrations.id));

  if (rows.length === 0) {
    const [tenant] = await db
      .select({ id: tenants.id, name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    return tenant ? { tenant, integrations: [] } : undefined;
  }

  const first = rows[0]!;
  return {
    tenant: { id: first.tenantId, name: first.tenantName },
    integrations: rows.map((row) => ({
      id: row.id,
      tenantId: row.tenantId,
      flowId: row.flowId,
      displayName: row.displayName,
      lifecycle: asLifecycle(row.lifecycle),
      configVersion: row.configVersion,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

function asLifecycle(value: string): IntegrationLifecycle {
  return (INTEGRATION_LIFECYCLES as readonly string[]).includes(value)
    ? (value as IntegrationLifecycle)
    : 'setup';
}
