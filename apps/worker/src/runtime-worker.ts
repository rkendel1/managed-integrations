/**
 * Runtime worker: executes integration work (sync, reconciliation, backlog assessment, release
 * canaries) and the periodic reliability tick. Holds credentials (decrypts connections); never
 * runs maintenance-agent code.
 */
import { and, eq, gt, lt } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import {
  AdoptedExecuteJobSchema,
  BacklogJobSchema,
  FLOW_TYPE,
  ProviderError,
  QUEUES,
  ReconcileJobSchema,
  ReleaseJobSchema,
  SyncJobSchema,
} from '@mi/contracts';
import {
  deliveries,
  incidents,
  integrations,
  maintenanceRuns,
  observations,
  reconciliationRuns,
  syncRuns,
  type Db,
} from '@mi/database';
import {
  buildRuntime,
  recoverInterruptedRuns,
  type IntegrationImplementation,
  type RetryPolicy,
  type ServiceConfig,
} from '@mi/integration-shopify-netsuite';
import { describeError, withCorrelation, type Logger } from '@mi/observability';
import { runRelease } from '@mi/maintenance';
import {
  ADOPTED_FLOW_TYPE,
  executeDelivery,
  nextAutomaticRetryDelaySeconds,
  requestDeliveryRetry,
} from '@mi/adopted-order-sync';
import {
  applyReconciliationResult,
  evaluateIntegration,
  markRecoveryEnqueued,
  noteIncident,
  readSourceIdentities,
  reconcile,
  recordAffectedOrders,
  type ReliabilityAction,
} from '@mi/reliability';

export interface RuntimeWorkerDeps {
  db: Db;
  boss: PgBoss;
  config: ServiceConfig;
  logger: Logger;
  workerId: string;
  /** Test hook: execute this implementation instead of the pinned artifact. */
  implementationOverride?: IntegrationImplementation;
  retry?: RetryPolicy;
}

export const RUNTIME_QUEUES = [
  QUEUES.reliabilityTick,
  QUEUES.sync,
  QUEUES.reconcile,
  QUEUES.backlog,
  QUEUES.release,
  QUEUES.maintenance,
  QUEUES.validation,
  QUEUES.adoptedExecute,
];

export async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const q of RUNTIME_QUEUES) {
    const existing = await boss.getQueue(q);
    if (!existing)
      await boss.createQueue(q, {
        retryLimit: q === QUEUES.sync ? 0 : 2,
        retryDelay: 30,
        retryBackoff: true,
        expireInSeconds: 30 * 60,
      });
  }
}

export function createRuntimeWorker(deps: RuntimeWorkerDeps) {
  const { db, boss, config, logger } = deps;
  const runtimeDeps = () => ({
    db,
    cipher: config.cipher!,
    endpoints: config.endpoints,
    workerId: deps.workerId,
    logger,
    ...(deps.retry ? { retry: deps.retry } : {}),
    ...(deps.implementationOverride ? { implementationOverride: deps.implementationOverride } : {}),
  });

  async function executeActions(actions: ReliabilityAction[]): Promise<void> {
    for (const a of actions) {
      switch (a.type) {
        case 'sync':
          await boss.send(
            QUEUES.sync,
            { integrationId: a.integrationId, trigger: a.trigger, mode: 'auto' },
            { singletonKey: `sync:${a.integrationId}` },
          );
          break;
        case 'reconcile':
          await boss.send(
            QUEUES.reconcile,
            { integrationId: a.integrationId, incidentId: a.incidentId, trigger: a.trigger },
            { singletonKey: `reconcile:${a.integrationId}:${a.incidentId ?? 'sched'}` },
          );
          break;
        case 'redeliver':
          await boss.send(QUEUES.sync, {
            integrationId: a.integrationId,
            trigger: 'recovery',
            mode: 'redelivery',
            sourceLegacyIds: a.legacyIds.slice(0, 1000),
          });
          break;
        case 'assess_backlog':
          await boss.send(QUEUES.backlog, { integrationId: a.integrationId, incidentId: a.incidentId });
          break;
        case 'maintenance': {
          const existing = await db
            .select({ id: maintenanceRuns.id })
            .from(maintenanceRuns)
            .where(eq(maintenanceRuns.incidentId, a.incidentId))
            .limit(1);
          if (existing.length) break;
          const [integ] = await db.select().from(integrations).where(eq(integrations.id, a.integrationId));
          const [mr] = await db
            .insert(maintenanceRuns)
            .values({
              incidentId: a.incidentId,
              integrationId: a.integrationId,
              trigger: 'incident',
              status: 'queued',
              baseVersionId: integ?.implementationVersionId ?? null,
            })
            .returning();
          await noteIncident(
            db,
            a.incidentId,
            'Internal maintenance task created: an engineer-agent will investigate in an isolated environment. No production changes are made without validation and human approval.',
            { customerVisible: true },
          );
          await boss.send(QUEUES.maintenance, { maintenanceRunId: mr!.id });
          break;
        }
      }
    }
  }

  async function evaluateAndAct(integrationId: string) {
    const ev = await evaluateIntegration(db, integrationId);
    await executeActions(ev.actions);
    return ev;
  }

  /** Records a run that could not even start (e.g. connection revoked) so detection sees it. */
  async function recordUnstartableRun(integrationId: string, trigger: string, err: unknown) {
    const pe = err instanceof ProviderError ? err : undefined;
    const now = new Date();
    const [integ] = await db.select().from(integrations).where(eq(integrations.id, integrationId));
    const [run] = await db
      .insert(syncRuns)
      .values({
        integrationId,
        mode: 'incremental',
        status: 'failed',
        trigger,
        workerId: deps.workerId,
        startedAt: now,
        finishedAt: now,
        heartbeatAt: now,
        cursorBefore: integ?.cursorWatermark ?? null,
        cursorAfter: integ?.cursorWatermark ?? null,
        errorClass: pe?.errorClass ?? 'unknown',
        errorMessage: describeError(err).message,
        implementationVersionId: integ?.implementationVersionId ?? null,
      })
      .returning();
    await db.insert(observations).values({
      tenantId: integ!.tenantId,
      integrationId,
      syncRunId: run!.id,
      provider: pe?.details.provider ?? 'internal',
      kind: 'error',
      errorClass: pe?.errorClass ?? 'unknown',
      code: pe?.details.code ?? 'RUN_NOT_STARTED',
      message: describeError(err).message,
    });
  }

  const handlers = {
    async tick(): Promise<void> {
      const interrupted = await recoverInterruptedRuns(db);
      if (interrupted.length) logger.warn({ interrupted }, 'marked interrupted sync runs');
      // Durable outbox completion for adopted executors: re-enqueue deliveries accepted but never picked up
      // (e.g. the API stopped between committing the receipt and enqueueing the job).
      const orphaned = await db
        .select({ id: deliveries.id })
        .from(deliveries)
        .innerJoin(integrations, eq(integrations.id, deliveries.integrationId))
        .where(
          and(
            eq(integrations.flowType, ADOPTED_FLOW_TYPE),
            eq(deliveries.outcome, 'pending'),
            lt(deliveries.updatedAt, new Date(Date.now() - 2 * 60_000)),
          ),
        );
      for (const o of orphaned) {
        await boss.send(
          QUEUES.adoptedExecute,
          { deliveryId: o.id, trigger: { kind: 'automatic_retry' } },
          { singletonKey: `adopted:${o.id}` },
        );
      }
      const active = await db
        .select()
        .from(integrations)
        // Only the native engine's integrations are scheduled here; adopted executors are event-driven.
        .where(
          and(
            eq(integrations.enabled, true),
            eq(integrations.lifecycle, 'active'),
            eq(integrations.flowType, FLOW_TYPE),
          ),
        );
      for (const integ of active) {
        await withCorrelation({ integrationId: integ.id, tenantId: integ.tenantId }, async () => {
          const syncDue = new Date(Date.now() - config.env.SYNC_INTERVAL_MINUTES * 60_000);
          const recent = await db
            .select({ id: syncRuns.id })
            .from(syncRuns)
            .where(and(eq(syncRuns.integrationId, integ.id), gt(syncRuns.createdAt, syncDue)))
            .limit(1);
          if (!recent.length)
            await boss.send(
              QUEUES.sync,
              { integrationId: integ.id, trigger: 'schedule', mode: 'auto' },
              { singletonKey: `sync:${integ.id}` },
            );

          const reconDue = new Date(Date.now() - config.env.RECONCILE_INTERVAL_MINUTES * 60_000);
          const recentRecon = await db
            .select({ id: reconciliationRuns.id })
            .from(reconciliationRuns)
            .where(
              and(eq(reconciliationRuns.integrationId, integ.id), gt(reconciliationRuns.startedAt, reconDue)),
            )
            .limit(1);
          if (!recentRecon.length && integ.backfillCompletedAt) {
            await boss.send(
              QUEUES.reconcile,
              { integrationId: integ.id, incidentId: null, trigger: 'schedule' },
              { singletonKey: `reconcile:${integ.id}:sched` },
            );
          }
          await evaluateAndAct(integ.id);
        });
      }
    },

    async sync(raw: unknown): Promise<unknown> {
      const job = SyncJobSchema.parse(raw);
      return withCorrelation({ integrationId: job.integrationId }, async () => {
        let result;
        try {
          const rt = await buildRuntime(runtimeDeps(), job.integrationId);
          result = await rt.engine.run({
            integrationId: job.integrationId,
            trigger: job.trigger,
            mode: job.mode === 'auto' ? 'auto' : job.mode,
            ...(job.sourceLegacyIds ? { sourceLegacyIds: job.sourceLegacyIds } : {}),
          });
        } catch (err) {
          logger.error({ err: describeError(err) }, 'sync could not start');
          await recordUnstartableRun(job.integrationId, job.trigger, err);
          result = { status: 'failed', error: describeError(err).message };
        }
        await evaluateAndAct(job.integrationId);
        return result;
      });
    },

    async reconcile(raw: unknown): Promise<unknown> {
      const job = ReconcileJobSchema.parse(raw);
      return withCorrelation({ integrationId: job.integrationId }, async () => {
        const rt = await buildRuntime(runtimeDeps(), job.integrationId);
        const result = await reconcile({
          db,
          shopify: rt.shopify,
          netsuite: rt.netsuite,
          integrationId: job.integrationId,
          trigger: job.trigger,
          incidentId: job.incidentId,
          ...(deps.retry ? { retry: deps.retry } : {}),
        });
        const follow = await applyReconciliationResult(db, job.integrationId, job.incidentId, result);
        const redeliveries = follow
          .filter((a) => a.type === 'redeliver')
          .reduce((n, a) => n + (a.type === 'redeliver' ? a.legacyIds.length : 0), 0);
        if (redeliveries) await markRecoveryEnqueued(db, result.runId, redeliveries);
        await executeActions(follow);
        await evaluateAndAct(job.integrationId);
        return { outcome: result.outcome, runId: result.runId };
      });
    },

    async backlog(raw: unknown): Promise<void> {
      const job = BacklogJobSchema.parse(raw);
      const [inc] = await db.select().from(incidents).where(eq(incidents.id, job.incidentId));
      const [integ] = await db.select().from(integrations).where(eq(integrations.id, job.integrationId));
      if (!inc || !integ) return;
      const rt = await buildRuntime(runtimeDeps(), job.integrationId);
      const from = new Date(integ.cursorWatermark ?? (integ.config as { backfillFrom: string }).backfillFrom);
      const orders = await readSourceIdentities(
        rt.shopify,
        from,
        new Date(),
        deps.retry ? { retry: deps.retry } : {},
      );
      // Orders at or before the watermark that are already delivered are not part of the backlog.
      await recordAffectedOrders(
        db,
        inc,
        orders
          .filter((o) => Date.parse(o.updatedAt) > from.getTime() || !integ.cursorWatermark)
          .map((o) => ({ name: o.name, legacyId: o.legacyId, updatedAt: o.updatedAt })),
      );
    },

    async release(raw: unknown): Promise<unknown> {
      const job = ReleaseJobSchema.parse(raw);
      return runRelease({
        db,
        releaseId: job.releaseId,
        buildRuntime: (integrationId, opts) => buildRuntime(runtimeDeps(), integrationId, opts),
        logger,
        ...(deps.retry ? { retry: deps.retry } : {}),
        enqueue: executeActions,
      });
    },

    /** Runs one delivery through the ADOPTED upstream implementation (shopify-erp-order-sync). */
    async adoptedExecute(raw: unknown): Promise<unknown> {
      const job = AdoptedExecuteJobSchema.parse(raw);
      const result = await executeDelivery({
        db,
        cipher: config.cipher!,
        endpoints: config.endpoints,
        deliveryId: job.deliveryId,
        trigger: job.trigger,
      });
      if (result.executed && result.outcome === 'failed') {
        const delay = nextAutomaticRetryDelaySeconds(result.attemptNo);
        if (delay != null) {
          const retry = await requestDeliveryRetry(db, job.deliveryId);
          if (retry.accepted) {
            await boss.sendAfter(
              QUEUES.adoptedExecute,
              { deliveryId: job.deliveryId, trigger: { kind: 'automatic_retry' } },
              { singletonKey: `adopted:${job.deliveryId}` },
              delay,
            );
          }
        }
      }
      if (result.executed) {
        const [d] = await db
          .select({ integrationId: deliveries.integrationId })
          .from(deliveries)
          .where(eq(deliveries.id, job.deliveryId));
        if (d) await evaluateAndAct(d.integrationId);
      }
      return result;
    },
  };

  async function start(): Promise<void> {
    await ensureQueues(boss);
    const wrap = (name: string, fn: (data: unknown) => Promise<unknown>) =>
      boss.work(name, { batchSize: 1 }, async (jobs) => {
        const out = [];
        for (const job of jobs) {
          out.push(
            await withCorrelation({ correlationId: job.id }, async () => {
              logger.info({ queue: name, jobId: job.id }, 'job started');
              try {
                const r = await fn(job.data);
                logger.info({ queue: name, jobId: job.id }, 'job completed');
                return r;
              } catch (err) {
                logger.error({ queue: name, jobId: job.id, err: describeError(err) }, 'job failed');
                throw err;
              }
            }),
          );
        }
        return out;
      });
    await wrap(QUEUES.reliabilityTick, () => handlers.tick());
    await wrap(QUEUES.sync, handlers.sync);
    await wrap(QUEUES.reconcile, handlers.reconcile);
    await wrap(QUEUES.backlog, handlers.backlog);
    await wrap(QUEUES.release, handlers.release);
    await wrap(QUEUES.adoptedExecute, handlers.adoptedExecute);
    await boss.schedule(QUEUES.reliabilityTick, '* * * * *');
  }

  return { start, handlers, executeActions, evaluateAndAct };
}
