/**
 * Delivery capabilities — the AppPort contract over delivery evidence and recovery.
 *
 *   deliveries.list@1   observation   integrations.read      what happened to each order of an integration
 *   deliveries.get@1    observation   integrations.read      one delivery with its full attempt history
 *   deliveries.retry@1  consequential integrations.operate   re-run a failed/rejected/stuck delivery
 *
 * The data is the durable evidence written by the executors (`deliveries`, `delivery_attempts`).
 * For integrations run by the ADOPTED shopify-erp-order-sync code, each attempt records the
 * upstream commit and the upstream result verbatim. Resource-to-tenant authorization happens in
 * the application authorizer (see authorization.ts), so UI and MCP get the same decision.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { defineCapability, type CapabilityDefinition } from '@appport/core';
import { errors } from '@appport/protocol';
import { s } from '@appport/schema';
import { ADOPTED, ADOPTED_FLOW_TYPE, requestDeliveryRetry } from '@mi/adopted-order-sync';
import { auditLog, deliveries, deliveryAttempts, integrations, type Db } from '@mi/database';
import { AppPortPermissions } from '../identity.ts';

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
export const DELIVERY_OUTCOMES = [
  'pending',
  'running',
  'delivered',
  'skipped',
  'rejected',
  'failed',
  /** Input violated the adopted contract; not written; a maintenance event owns it (slice 4). */
  'held',
] as const;
type Outcome = (typeof DELIVERY_OUTCOMES)[number];
const STUCK_MS = 10 * 60_000;

export type EnqueueDeliveryExecution = (
  deliveryId: string,
  trigger: { kind: 'manual_retry'; principalId: string; appportRequestId: string; reason: string },
) => Promise<void>;

const deliverySummary = s.object(deliverySummaryShape());

type DeliveryRow = typeof deliveries.$inferSelect;
function summarize(d: DeliveryRow) {
  const stuck =
    (d.outcome === 'pending' || d.outcome === 'running') && Date.now() - d.updatedAt.getTime() > STUCK_MS;
  return {
    id: d.id,
    order: d.sourceName,
    outcome: d.outcome as Outcome,
    stuck,
    attempts: d.attempts,
    netsuiteId: d.destinationId,
    externalId: d.externalId,
    reason: d.lastError,
    errorClass: d.lastErrorClass,
    receivedAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    deliveredAt: d.deliveredAt?.toISOString() ?? null,
    retryable: d.receiptId != null && (d.outcome === 'failed' || d.outcome === 'rejected' || stuck),
  };
}

export interface DeliveriesListOutput {
  integration: {
    id: string;
    displayName: string;
    executor: {
      kind: 'adopted' | 'native';
      repository: string | null;
      commit: string | null;
      license: string | null;
    };
    lastSuccessfulExecutionAt: string | null;
  };
  counts: Record<string, number>;
  deliveries: ReturnType<typeof summarize>[];
}

export function createDeliveriesListCapability(
  db: Db,
): CapabilityDefinition<{ integrationId: string; outcome?: Outcome; limit?: number }, DeliveriesListOutput> {
  return defineCapability({
    name: 'deliveries.list',
    version: 1,
    description: 'Lists order deliveries of an integration with their current outcome (most recent first).',
    effect: 'observation',
    authorization: [AppPortPermissions.read],
    input: s.object({
      integrationId: s.string({ pattern: UUID }),
      outcome: s.optional(s.enum([...DELIVERY_OUTCOMES])),
      limit: s.optional(s.integer({ minimum: 1, maximum: 200 })),
    }),
    output: s.object({
      integration: s.object({
        id: s.string(),
        displayName: s.string(),
        executor: s.object({
          kind: s.enum(['adopted', 'native']),
          repository: s.nullable(s.string()),
          commit: s.nullable(s.string()),
          license: s.nullable(s.string()),
        }),
        lastSuccessfulExecutionAt: s.nullable(s.string()),
      }),
      counts: s.record(s.integer({ minimum: 0 })),
      deliveries: s.array(deliverySummary),
    }),
    async handler(input) {
      const [integ] = await db.select().from(integrations).where(eq(integrations.id, input.integrationId));
      if (!integ) throw errors.notFound('Integration not found');
      const rows = await db
        .select()
        .from(deliveries)
        .where(
          and(
            eq(deliveries.integrationId, integ.id),
            ...(input.outcome ? [eq(deliveries.outcome, input.outcome)] : []),
          ),
        )
        .orderBy(desc(deliveries.createdAt))
        .limit(input.limit ?? 50);
      const countRows = await db
        .select({ outcome: deliveries.outcome, n: sql<number>`count(*)::int` })
        .from(deliveries)
        .where(eq(deliveries.integrationId, integ.id))
        .groupBy(deliveries.outcome);
      const adopted = integ.flowType === ADOPTED_FLOW_TYPE;
      return {
        integration: {
          id: integ.id,
          displayName: integ.displayName,
          executor: {
            kind: adopted ? 'adopted' : 'native',
            repository: adopted ? ADOPTED.repository : null,
            commit: adopted ? ADOPTED.commit : null,
            license: adopted ? ADOPTED.license : null,
          },
          lastSuccessfulExecutionAt: integ.lastSuccessfulSyncAt?.toISOString() ?? null,
        },
        counts: Object.fromEntries(countRows.map((r) => [r.outcome, r.n])),
        deliveries: rows.map(summarize),
      } as DeliveriesListOutput;
    },
  });
}

export interface DeliveryGetOutput {
  delivery: ReturnType<typeof summarize> & { integrationId: string };
  attempts: {
    attemptNo: number;
    outcome: string;
    errorClass: string | null;
    message: string | null;
    netsuiteId: string | null;
    executor: string | null;
    trigger: unknown;
    upstreamResult: unknown;
    startedAt: string;
    finishedAt: string;
  }[];
}

export function createDeliveryGetCapability(
  db: Db,
): CapabilityDefinition<{ deliveryId: string }, DeliveryGetOutput> {
  return defineCapability({
    name: 'deliveries.get',
    version: 1,
    description:
      'Returns one delivery with its complete attempt history and the executor’s recorded result per attempt.',
    effect: 'observation',
    authorization: [AppPortPermissions.read],
    input: s.object({ deliveryId: s.string({ pattern: UUID }) }),
    output: s.object({
      delivery: s.object({ ...deliverySummaryShape(), integrationId: s.string() }),
      attempts: s.array(
        s.object({
          attemptNo: s.integer({ minimum: 0 }),
          outcome: s.string(),
          errorClass: s.nullable(s.string()),
          message: s.nullable(s.string()),
          netsuiteId: s.nullable(s.string()),
          executor: s.nullable(s.string()),
          trigger: s.unknown(),
          upstreamResult: s.unknown(),
          startedAt: s.string(),
          finishedAt: s.string(),
        }),
      ),
    }),
    async handler(input) {
      const [d] = await db.select().from(deliveries).where(eq(deliveries.id, input.deliveryId));
      if (!d) throw errors.notFound('Delivery not found');
      const attempts = await db
        .select()
        .from(deliveryAttempts)
        .where(eq(deliveryAttempts.deliveryId, d.id))
        .orderBy(deliveryAttempts.attemptNo, deliveryAttempts.startedAt);
      return {
        delivery: { ...summarize(d), integrationId: d.integrationId },
        attempts: attempts.map((a) => {
          const ev = (a.evidence ?? {}) as { trigger?: unknown; upstreamResult?: unknown };
          return {
            attemptNo: a.attemptNo,
            outcome: a.outcome,
            errorClass: a.errorClass,
            message: a.errorMessage,
            netsuiteId: a.destinationId,
            executor: a.implementationVersionId,
            trigger: (ev.trigger ?? null) as never,
            upstreamResult: (ev.upstreamResult ?? null) as never,
            startedAt: a.startedAt.toISOString(),
            finishedAt: a.finishedAt.toISOString(),
          };
        }),
      } as DeliveryGetOutput;
    },
  });
}

function deliverySummaryShape() {
  return {
    id: s.string(),
    order: s.string(),
    outcome: s.enum([...DELIVERY_OUTCOMES]),
    stuck: s.boolean(),
    attempts: s.integer({ minimum: 0 }),
    netsuiteId: s.nullable(s.string()),
    externalId: s.string(),
    reason: s.nullable(s.string()),
    errorClass: s.nullable(s.string()),
    receivedAt: s.string(),
    updatedAt: s.string(),
    deliveredAt: s.nullable(s.string()),
    retryable: s.boolean(),
  };
}

export interface DeliveryRetryOutput {
  deliveryId: string;
  status: 'queued';
  previousOutcome: string;
}

export function createDeliveryRetryCapability(
  db: Db,
  enqueue: EnqueueDeliveryExecution | undefined,
): CapabilityDefinition<{ deliveryId: string; reason: string }, DeliveryRetryOutput> {
  return defineCapability({
    name: 'deliveries.retry',
    version: 1,
    description:
      'Re-runs a failed, rejected or stuck delivery through its executor. Records the request as a human intervention. Refused while the delivery is queued or running, or once delivered.',
    effect: 'consequential',
    authorization: [AppPortPermissions.operate],
    input: s.object({
      deliveryId: s.string({ pattern: UUID }),
      reason: s.string({
        minLength: 3,
        maxLength: 500,
        description: 'Why the retry is requested (kept as evidence).',
      }),
    }),
    output: s.object({ deliveryId: s.string(), status: s.enum(['queued']), previousOutcome: s.string() }),
    async handler(input, context) {
      if (!enqueue) throw errors.internal('Delivery execution is not available in this process');
      const [d] = await db.select().from(deliveries).where(eq(deliveries.id, input.deliveryId));
      if (!d) throw errors.notFound('Delivery not found');
      if (d.receiptId == null)
        throw errors.conflict(
          'This delivery is executed by the native engine; use its redelivery recovery instead',
        );
      const r = await requestDeliveryRetry(db, d.id);
      if (!r.accepted)
        throw errors.conflict(
          `Delivery is ${r.currentOutcome}; only failed, rejected or stuck deliveries can be retried`,
        );
      const principalId = context.principal?.id ?? 'unknown';
      await db.insert(auditLog).values({
        actorUserId: /^[0-9a-f-]{36}$/i.test(principalId) ? principalId : null,
        actorRole: String(context.principal?.attributes?.['role'] ?? 'unknown'),
        action: 'delivery.retry_requested',
        targetType: 'delivery',
        targetId: d.id,
        details: {
          reason: input.reason,
          previousOutcome: r.previousOutcome,
          appportRequestId: context.requestId,
          traceId: context.traceId,
        },
      });
      await enqueue(d.id, {
        kind: 'manual_retry',
        principalId,
        appportRequestId: context.requestId,
        reason: input.reason,
      });
      return { deliveryId: d.id, status: 'queued', previousOutcome: r.previousOutcome };
    },
  });
}
