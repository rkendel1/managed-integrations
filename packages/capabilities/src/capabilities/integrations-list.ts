/**
 * `integrations.list@1` — the first Managed Integrations capability.
 *
 * It is a request/response capability with an explicit input and output schema, an explicit
 * authorization requirement, and a handler that reads durable PostgreSQL state. Nothing here
 * knows about HTTP, MCP, React or the worker.
 */
import { defineCapability, type CapabilityDefinition } from '@appport/core';
import { errors } from '@appport/protocol';
import { s } from '@appport/schema';
import type { Db } from '@mi/database';
import { AppPortPermissions, tenantIdOf } from '../identity.ts';
import {
  INTEGRATION_LIFECYCLES,
  listIntegrationsForTenant,
  type IntegrationLifecycle,
} from '../repository.ts';

const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export interface IntegrationsListInput {
  /** Optional tenant scope. Honoured only for a principal holding `integrations.read:any`. */
  tenantId?: string;
}

export interface IntegrationsListOutput {
  tenant: { id: string; name: string };
  integrations: Array<{
    id: string;
    tenantId: string;
    flowId: string;
    displayName: string;
    lifecycle: IntegrationLifecycle;
    configVersion: number;
    createdAt: string;
    updatedAt: string;
  }>;
}

export const INTEGRATIONS_LIST = 'integrations.list';

export function createIntegrationsListCapability(
  db: Db,
): CapabilityDefinition<IntegrationsListInput, IntegrationsListOutput> {
  return defineCapability<IntegrationsListInput, IntegrationsListOutput>({
    name: INTEGRATIONS_LIST,
    version: 1,
    description: 'Lists the integrations visible to the authenticated principal, scoped to its tenant.',
    effect: 'observation',
    authorization: [AppPortPermissions.read],
    input: s.object({
      tenantId: s.optional(
        s.string({
          pattern: UUID_PATTERN,
          description:
            'Optional tenant scope. A caller without integrations.read:any may only name its own tenant.',
        }),
      ),
    }),
    output: s.object({
      tenant: s.object({ id: s.string(), name: s.string() }),
      integrations: s.array(
        s.object({
          id: s.string(),
          tenantId: s.string(),
          flowId: s.string(),
          displayName: s.string(),
          lifecycle: s.enum([...INTEGRATION_LIFECYCLES]),
          configVersion: s.integer({ minimum: 1 }),
          createdAt: s.string(),
          updatedAt: s.string(),
        }),
      ),
    }),
    async handler(input, context) {
      // The tenant comes from trusted identity. Input may narrow it, but the authorization
      // boundary has already refused any tenant the caller cannot reach.
      const tenantId = tenantIdOf(context.principal) ?? input.tenantId;
      if (!tenantId) {
        throw errors.forbidden('A tenantId is required for a principal without a tenant');
      }
      const result = await listIntegrationsForTenant(db, tenantId);
      if (!result) throw errors.notFound('Tenant not found');
      return result;
    },
  });
}
