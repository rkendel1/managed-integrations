/**
 * The authorization boundary for Managed Integrations capabilities.
 *
 * AppPort authorizes capabilities, not transports. This authorizer composes the standard
 * permission check with a resource-level tenant policy, so the same decision applies whether a
 * call arrives from the UI, MCP, or an internal consumer.
 */
import {
  authorizerFrom,
  combineAuthorizers,
  deny,
  grantsPermission,
  permissionAuthorizer,
  type Authorizer,
} from '@appport/authorization';
import type { JsonValue } from '@appport/protocol';
import { eq } from 'drizzle-orm';
import { deliveries, incidents, integrations, reconciliationRuns, type Db } from '@mi/database';
import { AppPortPermissions, tenantIdOf } from './identity.ts';

function requestedTenantId(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = (input as Record<string, JsonValue>)['tenantId'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Requires `integrations.read`, then confines the call to the caller's tenant.
 *
 * A principal with `integrations.read:any` (an operator) may target another tenant explicitly.
 * Everyone else may only reach their own; a mismatched `tenantId` input is refused at the
 * boundary rather than silently ignored.
 */
export function integrationsAuthorizer(): Authorizer {
  return combineAuthorizers([
    permissionAuthorizer(),
    authorizerFrom('tenant-boundary', (request) => {
      const principal = request.principal ?? request.session?.principal;
      if (!principal) return deny('Authentication is required', 'UNAUTHORIZED');

      const tenantId = tenantIdOf(principal);
      const granted = request.session?.permissions ?? [];
      const anyTenant = grantsPermission(granted, AppPortPermissions.readAny);
      if (!tenantId && !anyTenant) {
        return deny('The principal has no tenant context', 'FORBIDDEN');
      }

      const requested = requestedTenantId(request.input);
      if (requested && requested !== tenantId && !anyTenant) {
        return deny('The principal cannot read another tenant', 'FORBIDDEN');
      }
      return true;
    }),
  ]);
}

/**
 * Resource-level tenant policy: an `integrationId` or `deliveryId` in the (already validated) input
 * must belong to the caller's tenant, unless the caller holds the cross-tenant permission matching
 * the capability's requirement (`read:any` for observations, `operate:any` for operations).
 * Unknown ids are allowed through so the handler answers NOT_FOUND.
 */
export function resourceTenantAuthorizer(db: Db): Authorizer {
  return authorizerFrom('resource-tenant', async (request) => {
    const input = (request.input ?? {}) as {
      integrationId?: unknown;
      deliveryId?: unknown;
      runId?: unknown;
      eventId?: unknown;
    };
    const eventId = typeof input.eventId === 'string' ? input.eventId : undefined;
    const runId = typeof input.runId === 'string' ? input.runId : undefined;
    const integrationId = typeof input.integrationId === 'string' ? input.integrationId : undefined;
    const deliveryId = typeof input.deliveryId === 'string' ? input.deliveryId : undefined;
    if (!integrationId && !deliveryId && !runId && !eventId) return true;

    let resourceTenant: string | undefined;
    if (eventId) {
      const [row] = await db.select({ tenantId: incidents.tenantId }).from(incidents).where(eq(incidents.id, eventId));
      resourceTenant = row?.tenantId;
    } else if (deliveryId) {
      const [row] = await db
        .select({ tenantId: integrations.tenantId })
        .from(deliveries)
        .innerJoin(integrations, eq(integrations.id, deliveries.integrationId))
        .where(eq(deliveries.id, deliveryId));
      resourceTenant = row?.tenantId;
    } else if (runId) {
      const [row] = await db
        .select({ tenantId: integrations.tenantId })
        .from(reconciliationRuns)
        .innerJoin(integrations, eq(integrations.id, reconciliationRuns.integrationId))
        .where(eq(reconciliationRuns.id, runId));
      resourceTenant = row?.tenantId;
    } else if (integrationId) {
      const [row] = await db
        .select({ tenantId: integrations.tenantId })
        .from(integrations)
        .where(eq(integrations.id, integrationId));
      resourceTenant = row?.tenantId;
    }
    if (!resourceTenant) return true;

    const principal = request.principal ?? request.session?.principal;
    const granted = request.session?.permissions ?? [];
    const crossTenant = request.required.includes(AppPortPermissions.operate)
      ? AppPortPermissions.operateAny
      : AppPortPermissions.readAny;
    if (resourceTenant === tenantIdOf(principal) || grantsPermission(granted, crossTenant)) return true;
    return deny('The resource belongs to another tenant', 'FORBIDDEN');
  });
}
