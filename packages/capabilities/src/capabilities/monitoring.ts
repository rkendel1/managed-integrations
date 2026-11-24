/**
 * monitoring.integration@1 (slice 6) — operators only (`integrations.read:any`). For one integration, what
 * it is (identity, adopted artifact, dependencies), what we can and cannot monitor, recover, verify and
 * correct for it, its limitations, and the latest durable monitoring facts. Customers see outcomes in the
 * portfolio instead; this is the operator's view of the same authoritative state.
 */
import { defineCapability, type CapabilityDefinition } from '@appport/core';
import { errors } from '@appport/protocol';
import { s } from '@appport/schema';
import { eq } from 'drizzle-orm';
import { integrations, type Db } from '@mi/database';
import { descriptorFor } from '@mi/integrations';
import { latestMonitoring } from '@mi/managed';
import { AppPortPermissions } from '../identity.ts';

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export function createMonitoringCapability(
  db: Db,
): CapabilityDefinition<{ integrationId: string }, Record<string, unknown>> {
  return defineCapability({
    name: 'monitoring.integration',
    version: 1,
    description:
      'Operators only. For one integration: its maintenance contract (identity, adopted code, provider dependencies, monitoring/recovery/verification/correction capabilities and limitations) and the latest durable monitoring facts per signal.',
    effect: 'observation',
    authorization: [AppPortPermissions.readAny],
    input: s.object({ integrationId: s.string({ pattern: UUID }) }),
    output: s.object({
      integrationId: s.string(),
      health: s.string(),
      contract: s.unknown(),
      monitoring: s.unknown(),
    }),
    async handler(input) {
      const [integ] = await db.select().from(integrations).where(eq(integrations.id, input.integrationId));
      if (!integ) throw errors.notFound('Integration not found');
      const d = descriptorFor(integ.flowType);
      return {
        integrationId: integ.id,
        health: integ.health,
        contract: d ?? null,
        monitoring: await latestMonitoring(db, integ.id),
      };
    },
  });
}
