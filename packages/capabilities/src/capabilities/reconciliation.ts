/**
 * Reconciliation capabilities for adopted integrations (completeness, not just delivery):
 *
 *   reconciliation.start@1    consequential  integrations.operate  scan Shopify for the order population
 *   reconciliation.runs@1     observation    integrations.read     runs with counts and recovery progress
 *   reconciliation.items@1    observation    integrations.read     discovered orders and their classification
 *   reconciliation.recover@1  consequential  integrations.operate  recover missing orders (bulk needs confirm)
 *
 * Tenant ownership of `integrationId` / `runId` is enforced by the application's resource-tenant
 * authorizer before any handler runs. Evidence: AppPort invocation telemetry (audit_log) plus
 * explicit `reconciliation.*` audit entries carrying the AppPort request id.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { defineCapability, type CapabilityDefinition } from '@appport/core';
import { errors } from '@appport/protocol';
import { s } from '@appport/schema';
import { ADOPTED_FLOW_TYPE, CLASSIFICATIONS, RECOVERY_STATES, requestRecovery, startReconciliation, type Classification } from '@mi/adopted-order-sync';
import { auditLog, integrations, reconciliationItems, reconciliationRuns, type Db } from '@mi/database';
import { AppPortPermissions } from '../identity.ts';

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const GID = '^gid://shopify/Order/[0-9]+$';
export type EnqueueReconciliationScan = (runId: string) => Promise<void>;
export type EnqueueRecovery = (itemId: string) => Promise<void>;

const actorOf = (principal: { id?: string; attributes?: Record<string, unknown> } | undefined) => ({
  id: principal?.id ?? 'unknown',
  role: String(principal?.attributes?.['role'] ?? 'unknown'),
});
const uuidOrNull = (v: string) => (/^[0-9a-f-]{36}$/i.test(v) ? v : null);

export function createReconciliationStartCapability(db: Db, enqueue: EnqueueReconciliationScan | undefined): CapabilityDefinition<{ integrationId: string }, { runId: string; deduplicated: boolean; windowFrom: string; windowTo: string }> {
  return defineCapability({
    name: 'reconciliation.start',
    version: 1,
    description: 'Starts a reconciliation of an adopted integration: reads the Shopify order population for the contract window and classifies every order against delivery evidence and NetSuite. Joins a run already in progress.',
    effect: 'consequential',
    authorization: [AppPortPermissions.operate],
    input: s.object({ integrationId: s.string({ pattern: UUID }) }),
    output: s.object({ runId: s.string(), deduplicated: s.boolean(), windowFrom: s.string(), windowTo: s.string() }),
    async handler(input, context) {
      if (!enqueue) throw errors.internal('Reconciliation is not available in this process');
      const [integ] = await db.select().from(integrations).where(eq(integrations.id, input.integrationId));
      if (!integ) throw errors.notFound('Integration not found');
      if (integ.flowType !== ADOPTED_FLOW_TYPE) throw errors.conflict('This capability reconciles adopted integrations; the native engine reconciles on its own schedule');
      const actor = actorOf(context.principal);
      const r = await startReconciliation(db, { integrationId: integ.id, trigger: 'manual', requestedBy: actor.id });
      await db.insert(auditLog).values({
        actorUserId: uuidOrNull(actor.id),
        actorRole: actor.role,
        action: 'reconciliation.requested',
        targetType: 'reconciliation_run',
        targetId: r.runId,
        details: { integrationId: integ.id, deduplicated: r.deduplicated, appportRequestId: context.requestId },
      });
      await enqueue(r.runId);
      return r;
    },
  });
}

const runShape = s.object({
  id: s.string(),
  trigger: s.string(),
  status: s.string(),
  outcome: s.nullable(s.string()),
  windowFrom: s.string(),
  windowTo: s.string(),
  pagesScanned: s.integer({ minimum: 0 }),
  discovered: s.integer({ minimum: 0 }),
  counts: s.record(s.integer({ minimum: 0 })),
  recovery: s.record(s.integer({ minimum: 0 })),
  error: s.nullable(s.string()),
  requestedBy: s.nullable(s.string()),
  startedAt: s.string(),
  finishedAt: s.nullable(s.string()),
});

export interface ReconciliationRun {
  id: string;
  trigger: string;
  status: string;
  outcome: string | null;
  windowFrom: string;
  windowTo: string;
  pagesScanned: number;
  discovered: number;
  counts: Record<string, number>;
  recovery: Record<string, number>;
  error: string | null;
  requestedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
}

async function describeRun(db: Db, r: typeof reconciliationRuns.$inferSelect): Promise<ReconciliationRun> {
  const byClass = await db
    .select({ k: reconciliationItems.classification, n: sql<number>`count(*)::int` })
    .from(reconciliationItems)
    .where(eq(reconciliationItems.runId, r.id))
    .groupBy(reconciliationItems.classification);
  const byRecovery = await db
    .select({ k: reconciliationItems.recoveryState, n: sql<number>`count(*)::int` })
    .from(reconciliationItems)
    .where(and(eq(reconciliationItems.runId, r.id), sql`${reconciliationItems.recoveryState} <> 'none'`))
    .groupBy(reconciliationItems.recoveryState);
  const counts = Object.fromEntries(CLASSIFICATIONS.map((c) => [c, 0]));
  for (const x of byClass) counts[x.k] = x.n;
  return {
    id: r.id,
    trigger: r.trigger,
    status: r.status,
    outcome: r.outcome,
    windowFrom: r.windowFrom.toISOString(),
    windowTo: r.windowTo.toISOString(),
    pagesScanned: r.pagesScanned,
    discovered: byClass.reduce((t, x) => t + x.n, 0),
    counts,
    recovery: Object.fromEntries(byRecovery.map((x) => [x.k, x.n])),
    error: r.errorMessage,
    requestedBy: r.requestedBy,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

export function createReconciliationRunsCapability(db: Db): CapabilityDefinition<{ integrationId: string; limit?: number }, { runs: ReconciliationRun[] }> {
  return defineCapability({
    name: 'reconciliation.runs',
    version: 1,
    description: 'Lists reconciliation runs of an adopted integration (most recent first) with classification counts and recovery progress.',
    effect: 'observation',
    authorization: [AppPortPermissions.read],
    input: s.object({ integrationId: s.string({ pattern: UUID }), limit: s.optional(s.integer({ minimum: 1, maximum: 50 })) }),
    output: s.object({ runs: s.array(runShape) }),
    async handler(input) {
      const rows = await db
        .select()
        .from(reconciliationRuns)
        .where(eq(reconciliationRuns.integrationId, input.integrationId))
        .orderBy(desc(reconciliationRuns.startedAt))
        .limit(input.limit ?? 10);
      return { runs: await Promise.all(rows.map((r) => describeRun(db, r))) };
    },
  });
}

export interface ReconciliationItemView {
  sourceOrderId: string;
  order: string;
  sourceCreatedAt: string;
  classification: string;
  reason: string | null;
  destinationIds: string[];
  deliveryId: string | null;
  recoveryState: string;
  recoverable: boolean;
  verifiedDestinationId: string | null;
  verifiedAt: string | null;
}

export function createReconciliationItemsCapability(
  db: Db,
): CapabilityDefinition<{ runId: string; classification?: Classification; limit?: number }, { run: ReconciliationRun; items: ReconciliationItemView[] }> {
  return defineCapability({
    name: 'reconciliation.items',
    version: 1,
    description: 'Lists the orders discovered by one reconciliation run with their classification, destination matches and recovery state. Exceptions first.',
    effect: 'observation',
    authorization: [AppPortPermissions.read],
    input: s.object({
      runId: s.string({ pattern: UUID }),
      classification: s.optional(s.enum([...CLASSIFICATIONS])),
      limit: s.optional(s.integer({ minimum: 1, maximum: 500 })),
    }),
    output: s.object({
      run: runShape,
      items: s.array(
        s.object({
          sourceOrderId: s.string(),
          order: s.string(),
          sourceCreatedAt: s.string(),
          classification: s.enum([...CLASSIFICATIONS]),
          reason: s.nullable(s.string()),
          destinationIds: s.array(s.string()),
          deliveryId: s.nullable(s.string()),
          recoveryState: s.enum([...RECOVERY_STATES]),
          recoverable: s.boolean(),
          verifiedDestinationId: s.nullable(s.string()),
          verifiedAt: s.nullable(s.string()),
        }),
      ),
    }),
    async handler(input) {
      const [run] = await db.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, input.runId));
      if (!run) throw errors.notFound('Reconciliation run not found');
      const rows = await db
        .select()
        .from(reconciliationItems)
        .where(and(eq(reconciliationItems.runId, run.id), ...(input.classification ? [eq(reconciliationItems.classification, input.classification)] : [])))
        .orderBy(sql`CASE ${reconciliationItems.classification} WHEN 'missing_delivery' THEN 0 WHEN 'ambiguous' THEN 1 WHEN 'undetermined' THEN 2 WHEN 'failed_delivery' THEN 3 WHEN 'destination_exists_untracked' THEN 4 WHEN 'pending_delivery' THEN 5 WHEN 'excluded' THEN 6 ELSE 7 END`, reconciliationItems.sourceCreatedAt)
        .limit(input.limit ?? 200);
      return {
        run: await describeRun(db, run),
        items: rows.map((i) => ({
          sourceOrderId: i.sourceOrderId,
          order: i.orderName,
          sourceCreatedAt: i.sourceCreatedAt.toISOString(),
          classification: i.classification,
          reason: i.reason,
          destinationIds: i.destinationIds,
          deliveryId: i.deliveryId,
          recoveryState: i.recoveryState,
          recoverable: (i.classification === 'missing_delivery' && i.recoveryState === 'none') || i.recoveryState === 'failed',
          verifiedDestinationId: i.verifiedDestinationId,
          verifiedAt: i.verifiedAt?.toISOString() ?? null,
        })),
      };
    },
  });
}

export interface RecoverOutput {
  requested: number;
  accepted: { sourceOrderId: string; itemId: string; mode: string }[];
  refused: { sourceOrderId: string; reason: string }[];
}

export function createReconciliationRecoverCapability(
  db: Db,
  enqueue: EnqueueRecovery | undefined,
): CapabilityDefinition<{ runId: string; sourceOrderIds: string[]; reason: string; confirm?: boolean }, RecoverOutput> {
  return defineCapability({
    name: 'reconciliation.recover',
    version: 1,
    description:
      'Requests recovery of orders a reconciliation classified as missing (or whose recovery failed). Each order is re-checked against NetSuite and Shopify before the adopted executor runs it, and verified afterwards. Ambiguous, untracked, pending or excluded orders are refused. More than one order requires confirm: true.',
    effect: 'consequential',
    authorization: [AppPortPermissions.operate],
    input: s.object({
      runId: s.string({ pattern: UUID }),
      sourceOrderIds: s.array(s.string({ pattern: GID }), { minItems: 1, maxItems: 50 }),
      reason: s.string({ minLength: 3, maxLength: 500 }),
      confirm: s.optional(s.boolean('Required (true) when recovering more than one order.')),
    }),
    output: s.object({
      requested: s.integer({ minimum: 0 }),
      accepted: s.array(s.object({ sourceOrderId: s.string(), itemId: s.string(), mode: s.string() })),
      refused: s.array(s.object({ sourceOrderId: s.string(), reason: s.string() })),
    }),
    async handler(input, context) {
      if (!enqueue) throw errors.internal('Recovery is not available in this process');
      const ids = [...new Set(input.sourceOrderIds)];
      if (ids.length > 1 && input.confirm !== true) {
        throw errors.invalidInput(`Recovering ${ids.length} orders creates up to ${ids.length} NetSuite sales orders; resend with confirm: true`);
      }
      const [run] = await db.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, input.runId));
      if (!run) throw errors.notFound('Reconciliation run not found');
      const actor = actorOf(context.principal);
      const decisions = await requestRecovery(db, { runId: run.id, sourceOrderIds: ids, principalId: actor.id, requestId: context.requestId, reason: input.reason });
      const accepted: RecoverOutput['accepted'] = [];
      const refused: RecoverOutput['refused'] = [];
      for (const d of decisions) {
        if (d.accepted) {
          accepted.push({ sourceOrderId: d.sourceOrderId, itemId: d.itemId, mode: d.mode });
          await db.insert(auditLog).values({
            actorUserId: uuidOrNull(actor.id),
            actorRole: actor.role,
            action: 'reconciliation.recovery_requested',
            targetType: 'reconciliation_item',
            targetId: d.itemId,
            details: { runId: run.id, sourceOrderId: d.sourceOrderId, deliveryId: d.deliveryId, mode: d.mode, reason: input.reason, appportRequestId: context.requestId },
          });
          await enqueue(d.itemId);
        } else {
          refused.push({ sourceOrderId: d.sourceOrderId, reason: d.reason });
        }
      }
      return { requested: ids.length, accepted, refused };
    },
  });
}
