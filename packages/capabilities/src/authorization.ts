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
