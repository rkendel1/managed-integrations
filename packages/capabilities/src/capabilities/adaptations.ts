/**
 * Operator capabilities over the correction registry (slice 5). Operators only: every capability here
 * requires a cross-tenant permission (`integrations.read:any` / `integrations.operate:any`) that customers
 * never hold, so the customer product cannot propose, activate or roll back code changes.
 *
 *  adaptations.inspect@1   what exact code runs for an integration, what it depends on, and why
 *  adaptations.propose@1   propose a REVIEWED patch from the catalog (adapters are proposed by maintenance)
 *  adaptations.validate@1  (re)run validation — in the worker, against the providers
 *  adaptations.activate@1  switch a validated correction on (explicit decision for limited validations)
 *  adaptations.rollback@1  switch an active correction off; the previous known-good runtime runs again
 *  adaptations.reject@1    decline a proposed or validated correction
 */
import { defineCapability, type CapabilityDefinition } from '@appport/core';
import { errors } from '@appport/protocol';
import { s } from '@appport/schema';
import { eq } from 'drizzle-orm';
import { adaptations, type Db } from '@mi/database';
import { AdaptationError, type IntegrationRegistry } from '@mi/managed';
import { AppPortPermissions } from '../identity.ts';

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
export type EnqueueAdaptationValidation = (adaptationId: string) => Promise<void>;

/** The integration that owns an adaptation (or an integration) decides what its corrections mean. */
async function opsFor(
  registry: IntegrationRegistry | undefined,
  by: { integrationId?: string; adaptationId?: string },
) {
  const rt = by.integrationId
    ? await registry?.forIntegration(by.integrationId)
    : by.adaptationId
      ? await registry?.forAdaptation(by.adaptationId)
      : undefined;
  if (!rt) throw errors.notFound('Integration or adaptation not found');
  return rt;
}

const actorOf = (principal: { id?: string } | undefined) => principal?.id ?? 'operator:unknown';
const reason = s.string({ minLength: 3, maxLength: 500 });
const mapError = (err: unknown): never => {
  if (err instanceof AdaptationError) {
    if (err.code === 'NOT_FOUND') throw errors.notFound(err.message);
    if (err.code === 'CONFLICT') throw errors.conflict(err.message);
    throw errors.invalidInput(err.message);
  }
  throw err;
};
const view = (r: typeof adaptations.$inferSelect) => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  maintenanceEventId: r.maintenanceEventId,
  spec: r.spec,
  rationale: r.rationale,
  validation: r.validation,
  history: r.history,
  activatedAt: r.activatedAt?.toISOString() ?? null,
  rolledBackAt: r.rolledBackAt?.toISOString() ?? null,
});
const rowSchema = s.object({
  id: s.string(),
  kind: s.string(),
  status: s.string(),
  maintenanceEventId: s.nullable(s.string()),
  spec: s.unknown(),
  rationale: s.string(),
  validation: s.unknown(),
  history: s.unknown(),
  activatedAt: s.nullable(s.string()),
  rolledBackAt: s.nullable(s.string()),
});

export function createAdaptationsInspectCapability(
  registry: IntegrationRegistry | undefined,
): CapabilityDefinition<{ integrationId: string }, Record<string, unknown>> {
  return defineCapability({
    name: 'adaptations.inspect',
    version: 1,
    description:
      'Operators only. For one integration: the adopted code (repository, pinned commit, file hashes checked now), the artifact actually running (with any patches), the provider contracts the code depends on and where it reads them, every adapter and patch with its provenance, validation and history, and the reviewed patch catalog.',
    effect: 'observation',
    authorization: [AppPortPermissions.readAny],
    input: s.object({ integrationId: s.string({ pattern: UUID }) }),
    output: s.object({
      adopted: s.unknown(),
      pinnedFiles: s.unknown(),
      running: s.unknown(),
      problem: s.nullable(s.string()),
      contracts: s.unknown(),
      adaptations: s.array(rowSchema),
      catalog: s.unknown(),
    }),
    async handler(input) {
      const rt = await opsFor(registry, { integrationId: input.integrationId });
      if (!rt.inspect)
        throw errors.conflict(`${rt.descriptor.name} is not adopted code; there is nothing to inspect`);
      const code = await rt.inspect(input.integrationId);
      return { ...code, adaptations: code.adaptations.map(view) };
    },
  });
}

export function createAdaptationProposeCapability(
  registry: IntegrationRegistry | undefined,
  enqueue: EnqueueAdaptationValidation | undefined,
): CapabilityDefinition<
  { integrationId: string; patchId: string; reason: string; maintenanceEventId?: string },
  ReturnType<typeof view>
> {
  return defineCapability({
    name: 'adaptations.propose',
    version: 1,
    description:
      'Operators only. Proposes a reviewed patch from the catalog for an integration and queues its validation. Arbitrary code cannot be proposed; adapters are proposed by the maintenance lifecycle from evidence.',
    effect: 'consequential',
    authorization: [AppPortPermissions.operateAny],
    input: s.object({
      integrationId: s.string({ pattern: UUID }),
      patchId: s.string({ maxLength: 100 }),
      reason,
      maintenanceEventId: s.optional(s.string({ pattern: UUID })),
    }),
    output: rowSchema,
    async handler(input, context) {
      try {
        const rt = await opsFor(registry, { integrationId: input.integrationId });
        if (!rt.adaptations) throw errors.conflict(`${rt.descriptor.name} has no reviewed corrections`);
        const row = await rt.adaptations.propose({
          integrationId: input.integrationId,
          patchId: input.patchId,
          reason: input.reason,
          actor: actorOf(context.principal),
          maintenanceEventId: input.maintenanceEventId ?? null,
        });
        if (enqueue) await enqueue(row.id);
        return view(row);
      } catch (err) {
        return mapError(err);
      }
    },
  });
}

export function createAdaptationValidateCapability(
  db: Db,
  enqueue: EnqueueAdaptationValidation | undefined,
): CapabilityDefinition<{ adaptationId: string }, { adaptationId: string; queued: boolean }> {
  return defineCapability({
    name: 'adaptations.validate',
    version: 1,
    description:
      'Operators only. Queues validation of a proposed (or re-validation of a validated) correction.',
    effect: 'consequential',
    authorization: [AppPortPermissions.operateAny],
    input: s.object({ adaptationId: s.string({ pattern: UUID }) }),
    output: s.object({ adaptationId: s.string(), queued: s.boolean('queued') }),
    async handler(input) {
      if (!enqueue) throw errors.internal('Validation is not available in this process');
      const [row] = await db.select().from(adaptations).where(eq(adaptations.id, input.adaptationId));
      if (!row) throw errors.notFound('Adaptation not found');
      if (!['proposed', 'validated'].includes(row.status))
        throw errors.conflict(`Adaptation is ${row.status}`);
      await enqueue(row.id);
      return { adaptationId: row.id, queued: true };
    },
  });
}

export function createAdaptationActivateCapability(
  registry: IntegrationRegistry | undefined,
): CapabilityDefinition<
  { adaptationId: string; reason: string; acceptLimitations?: boolean },
  ReturnType<typeof view>
> {
  return defineCapability({
    name: 'adaptations.activate',
    version: 1,
    description:
      'Operators only. Switches a validated correction on. Refused unless validation passed; if validation could not cover everything, acceptLimitations: true records the explicit decision.',
    effect: 'consequential',
    authorization: [AppPortPermissions.operateAny],
    input: s.object({
      adaptationId: s.string({ pattern: UUID }),
      reason,
      acceptLimitations: s.optional(s.boolean('Accept the validation limitations explicitly')),
    }),
    output: rowSchema,
    async handler(input, context) {
      try {
        const rt = await opsFor(registry, { adaptationId: input.adaptationId });
        return view(
          await rt.adaptations!.activate(input.adaptationId, actorOf(context.principal), input.reason, {
            acceptLimitations: input.acceptLimitations === true,
          }),
        );
      } catch (err) {
        return mapError(err);
      }
    },
  });
}

export function createAdaptationRollbackCapability(
  registry: IntegrationRegistry | undefined,
): CapabilityDefinition<{ adaptationId: string; reason: string }, ReturnType<typeof view>> {
  return defineCapability({
    name: 'adaptations.rollback',
    version: 1,
    description:
      'Operators only. Switches an active correction off; the next execution runs the previous known-good code. Transactions already written are not rewritten; affected new ones are held again.',
    effect: 'consequential',
    authorization: [AppPortPermissions.operateAny],
    input: s.object({ adaptationId: s.string({ pattern: UUID }), reason }),
    output: rowSchema,
    async handler(input, context) {
      try {
        const rt = await opsFor(registry, { adaptationId: input.adaptationId });
        return view(
          await rt.adaptations!.rollback(input.adaptationId, actorOf(context.principal), input.reason),
        );
      } catch (err) {
        return mapError(err);
      }
    },
  });
}

export function createAdaptationRejectCapability(
  registry: IntegrationRegistry | undefined,
): CapabilityDefinition<{ adaptationId: string; reason: string }, ReturnType<typeof view>> {
  return defineCapability({
    name: 'adaptations.reject',
    version: 1,
    description: 'Operators only. Declines a proposed or validated correction (it never runs).',
    effect: 'consequential',
    authorization: [AppPortPermissions.operateAny],
    input: s.object({ adaptationId: s.string({ pattern: UUID }), reason }),
    output: rowSchema,
    async handler(input, context) {
      try {
        const rt = await opsFor(registry, { adaptationId: input.adaptationId });
        return view(
          await rt.adaptations!.reject(input.adaptationId, actorOf(context.principal), input.reason),
        );
      } catch (err) {
        return mapError(err);
      }
    },
  });
}
