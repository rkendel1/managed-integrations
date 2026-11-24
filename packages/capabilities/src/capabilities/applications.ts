/**
 * applications.invoke@1 (slice 7): runs one of a hosted application's own operations for its customer —
 * e.g. quickbooks-mcp's create_invoice tool, or the subscriptions app's checkout-session route — through the
 * managed runtime: recorded once per request id, run with the customer's provider connection, verified at the
 * provider. Over MCP this is how an agent uses a hosted MCP application's tools. Customers only: an operator
 * never acts in a customer's provider account through this capability.
 */
import { defineCapability, type CapabilityDefinition } from '@appport/core';
import { errors } from '@appport/protocol';
import { s } from '@appport/schema';
import { eq } from 'drizzle-orm';
import { integrations, type Db } from '@mi/database';
import type { IntegrationRegistry } from '@mi/managed';
import { AppPortPermissions, tenantIdOf } from '../identity.ts';

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

type In = { integrationId: string; operation: string; requestId: string; input: Record<string, unknown> };
type Out = { deliveryId: string; outcome: string; replayed: boolean; output: Record<string, unknown>; verification: Record<string, unknown> };

export function createApplicationInvokeCapability(db: Db, registry: IntegrationRegistry): CapabilityDefinition<In, Out> {
  return defineCapability({
    name: 'applications.invoke',
    version: 1,
    description:
      'Runs one operation of a managed application for your account (for example create_invoice of your QuickBooks tools). The same requestId never runs twice; the result is checked in the provider.',
    effect: 'consequential',
    authorization: [AppPortPermissions.operate],
    input: s.object({
      integrationId: s.string({ pattern: UUID }),
      operation: s.string({ minLength: 1, maxLength: 100 }),
      requestId: s.string({ minLength: 1, maxLength: 200 }),
      input: s.record(s.unknown()),
    }),
    output: s.object({
      deliveryId: s.string(),
      outcome: s.string(),
      replayed: s.boolean(),
      output: s.record(s.unknown()),
      verification: s.record(s.unknown()),
    }),
    async handler(input, context) {
      const tenantId = tenantIdOf(context.principal);
      if (!tenantId) throw errors.forbidden('Only the customer can run their application’s operations');
      const [integ] = await db.select().from(integrations).where(eq(integrations.id, input.integrationId));
      if (!integ || integ.tenantId !== tenantId) throw errors.notFound('Integration not found');
      if (integ.lifecycle !== 'active') throw errors.conflict('This application is not under management yet');
      const rt = registry.get(integ.flowType);
      if (!rt?.invoke) throw errors.invalidInput('This integration has no operations to run');
      try {
        return await rt.invoke({ integrationId: integ.id, operation: input.operation, input: input.input, requestId: input.requestId, principalId: context.principal?.id ?? 'unknown' });
      } catch (err) {
        if (err instanceof Error && /^Unknown operation/.test(err.message)) throw errors.invalidInput(err.message);
        throw err;
      }
    },
  });
}
