/**
 * Runtime worker: executes integration work (sync, reconciliation, backlog assessment, release
 * canaries) and the periodic reliability tick. Holds credentials (decrypts connections); never
 * runs maintenance-agent code.
 */
import { and, eq, gt } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import {
  AdoptedExecuteJobSchema,
  AdoptedReconcileJobSchema,
  AdoptedRecoverJobSchema,
  AdoptedMaintenanceJobSchema,
  AdoptedAdaptationValidateJobSchema,
  OnboardingActivateJobSchema,
  BacklogJobSchema,
  FLOW_TYPE,
  ProviderError,
  QUEUES,
  ReconcileJobSchema,
  ReleaseJobSchema,
  SyncJobSchema,
} from '@mi/contracts';
import {
  adaptations,
  deliveries,
  incidents,
  integrations,
  maintenanceRuns,
  observations,
  reconciliationItems,
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
import { createRegistry } from '@mi/integrations';
import {
  advanceOnboarding,
  monitorIntegration,
  onboardingsActivating,
  type ExecutionTrigger,
  type WorkServices,
} from '@mi/managed';
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
  QUEUES.adoptedReconcile,
  QUEUES.adoptedRecover,
  QUEUES.adoptedMaintenance,
  QUEUES.adoptedAdaptationValidate,
  QUEUES.onboardingActivate,
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

  /** Shared queues, offered to every integration's runtime. Integrations never see pg-boss. */
  const services: WorkServices = {
    async enqueueExecution(deliveryId: string, trigger: ExecutionTrigger, afterSeconds?: number) {
      const opts = { singletonKey: `adopted:${deliveryId}` };
      if (afterSeconds)
        await boss.sendAfter(QUEUES.adoptedExecute, { deliveryId, trigger }, opts, afterSeconds);
      else await boss.send(QUEUES.adoptedExecute, { deliveryId, trigger }, opts);
    },
    async enqueueReconciliation(runId: string) {
      await boss.send(QUEUES.adoptedReconcile, { runId }, { singletonKey: `adopted-recon:${runId}` });
    },
    async enqueueRecovery(itemId: string) {
      await boss.send(QUEUES.adoptedRecover, { itemId }, { singletonKey: `adopted-recover:${itemId}` });
    },
    enqueueMaintenance: (incidentId: string, afterSeconds?: number) =>
      enqueueMaintenance(incidentId, afterSeconds),
  };
  const registry = createRegistry({
    db,
    cipher: config.cipher!,
    endpoints: config.endpoints,
    services,
    webhookBaseUrl: config.env.WEBHOOK_BASE_URL ?? config.env.PUBLIC_BASE_URL,
    workerId: deps.workerId,
    reconcileIntervalMinutes: config.env.RECONCILE_INTERVAL_MINUTES,
    ...(deps.retry ? { retry: deps.retry } : {}),
  });
  /** When each integration was last probed by monitoring (cadence only; the facts themselves are durable). */
  const lastProbe = new Map<string, number>();

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

  async function enqueueMaintenance(incidentId: string, afterSeconds = 0) {
    const opts = { singletonKey: `adopted-maint:${incidentId}` };
    if (afterSeconds) await boss.sendAfter(QUEUES.adoptedMaintenance, { incidentId }, opts, afterSeconds);
    else await boss.send(QUEUES.adoptedMaintenance, { incidentId }, opts);
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
      // Integration-specific periodic work (orphaned work, held transactions, open events, scheduled checks).
      for (const rt of registry.all()) {
        try {
          await rt.sweep?.();
        } catch (err) {
          logger.error(
            { flowType: rt.descriptor.flowType, err: describeError(err) },
            'integration sweep failed',
          );
        }
      }
      // Onboarding activations resume after a crash or restart.
      for (const o of await onboardingsActivating(db))
        await boss.send(QUEUES.onboardingActivate, o, {
          singletonKey: `onboarding:${o.tenantId}:${o.flowType}`,
        });
      // Monitoring: every managed integration whose runtime can probe its systems, at the monitoring interval.
      const monitored = await db
        .select()
        .from(integrations)
        .where(and(eq(integrations.enabled, true), eq(integrations.lifecycle, 'active')));
      for (const integ of monitored) {
        const rt = registry.get(integ.flowType);
        if (!rt?.probe) continue;
        if (Date.now() - (lastProbe.get(integ.id) ?? 0) < config.env.MONITOR_INTERVAL_MINUTES * 60_000)
          continue;
        lastProbe.set(integ.id, Date.now());
        try {
          const m = await monitorIntegration(db, integ, rt.descriptor, await rt.probe(integ));
          if (m.reauthorizationEventId && rt.maintain) await enqueueMaintenance(m.reauthorizationEventId);
        } catch (err) {
          logger.error({ integrationId: integ.id, err: describeError(err) }, 'monitoring failed');
        }
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

    /** Scans the source for a reconciliation run, by the integration that owns it (resumable; lease-fenced). */
    async adoptedReconcile(raw: unknown): Promise<unknown> {
      const job = AdoptedReconcileJobSchema.parse(raw);
      const rt = await registry.forRun(job.runId);
      if (!rt?.scan) return { skipped: 'no scanner for this run' };
      return rt.scan(job.runId);
    },

    /** Executes one requested recovery through the owning integration's executor and verifies it. */
    async adoptedRecover(raw: unknown): Promise<unknown> {
      const job = AdoptedRecoverJobSchema.parse(raw);
      const rt = await registry.forItem(job.itemId);
      if (!rt?.recover) return { skipped: 'no recovery for this item' };
      const r = (await rt.recover(job.itemId)) as { done?: boolean };
      if (r.done) {
        const [item] = await db
          .select()
          .from(reconciliationItems)
          .where(eq(reconciliationItems.id, job.itemId));
        if (item) await evaluateAndAct(item.integrationId);
      }
      return r;
    },

    /**
     * Drives one maintenance event: advances step by step while there is work, then schedules itself
     * again while it waits on executions or reconciliation. Steps are idempotent (crash-safe).
     */
    async adoptedMaintenance(raw: unknown): Promise<unknown> {
      const job = AdoptedMaintenanceJobSchema.parse(raw);
      const [inc] = await db.select().from(incidents).where(eq(incidents.id, job.incidentId));
      const rt = inc?.integrationId ? await registry.forIntegration(inc.integrationId) : undefined;
      if (!inc?.integrationId || !rt?.maintain) return { state: 'noop' };
      let r: { state: string; detail: string } = { state: 'continue', detail: '' };
      const steps: string[] = [];
      for (let i = 0; i < 40 && r.state === 'continue'; i++) {
        r = await rt.maintain(job.incidentId);
        steps.push(r.detail);
      }
      if (r.state === 'wait' || r.state === 'continue') await enqueueMaintenance(job.incidentId, 2);
      if (r.state === 'resolved') await evaluateAndAct(inc.integrationId);
      return { state: r.state, steps };
    },

    /** Drives one onboarding activation step by step (idempotent; resumes after crashes). */
    async onboardingActivate(raw: unknown): Promise<unknown> {
      const job = OnboardingActivateJobSchema.parse(raw);
      const impl = registry.get(job.flowType)?.onboarding;
      if (!impl) return { state: 'noop', detail: 'not onboardable' };
      let r: Awaited<ReturnType<typeof advanceOnboarding>> = { state: 'continue', detail: '' };
      const steps: string[] = [];
      for (let i = 0; i < 20 && r.state === 'continue'; i++) {
        r = await advanceOnboarding(db, job.tenantId, impl);
        steps.push(r.detail);
      }
      if (r.state === 'wait' || r.state === 'continue')
        await boss.sendAfter(
          QUEUES.onboardingActivate,
          job,
          { singletonKey: `onboarding:${job.tenantId}:${job.flowType}` },
          2,
        );
      return { state: r.state, steps };
    },

    /** Validates one adaptation, by the integration that owns it (operator-requested). */
    async adoptedAdaptationValidate(raw: unknown): Promise<unknown> {
      const job = AdoptedAdaptationValidateJobSchema.parse(raw);
      const [row] = await db.select().from(adaptations).where(eq(adaptations.id, job.adaptationId));
      if (!row || !['proposed', 'validated'].includes(row.status))
        return { skipped: row?.status ?? 'unknown' };
      const rt = await registry.forIntegration(row.integrationId);
      if (!rt?.adaptations) return { skipped: 'no adaptation support' };
      const v = await rt.adaptations.validate(row.id);
      return { status: v.status };
    },

    /** Runs one delivery through the owning integration's adopted executor. */
    async adoptedExecute(raw: unknown): Promise<unknown> {
      const job = AdoptedExecuteJobSchema.parse(raw);
      const rt = await registry.forDelivery(job.deliveryId);
      if (!rt?.execute) return { skipped: 'no executor for this delivery' };
      const result = (await rt.execute(job.deliveryId, job.trigger)) as { executed?: boolean };
      if (result.executed) {
        const [d] = await db
          .select({ i: deliveries.integrationId })
          .from(deliveries)
          .where(eq(deliveries.id, job.deliveryId));
        if (d) await evaluateAndAct(d.i);
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
    await wrap(QUEUES.adoptedReconcile, handlers.adoptedReconcile);
    await wrap(QUEUES.adoptedRecover, handlers.adoptedRecover);
    await wrap(QUEUES.adoptedMaintenance, handlers.adoptedMaintenance);
    await wrap(QUEUES.adoptedAdaptationValidate, handlers.adoptedAdaptationValidate);
    await wrap(QUEUES.onboardingActivate, handlers.onboardingActivate);
    await boss.schedule(QUEUES.reliabilityTick, '* * * * *');
  }

  return { start, handlers, executeActions, evaluateAndAct };
}
