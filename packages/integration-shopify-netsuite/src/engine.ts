/**
 * Sync engine (stable). Executes backfill, incremental, redelivery and canary runs for one
 * integration using a versioned IntegrationImplementation.
 *
 * Safety rules enforced here:
 *  1. One runner per integration via a fenced lease on the integrations row.
 *  2. Records are processed in source updatedAt order; the cursor (watermark) is persisted only
 *     after every record of a page has a durable terminal outcome, and never moves backwards.
 *  3. A record whose delivery cannot be completed (retries exhausted, auth failure, unknown)
 *     aborts the run before the cursor passes it.
 *  4. Delivery is idempotent: one delivery row per (integration, source order); NetSuite writes
 *     use upsert by external id, so a crash after the write but before recording is safe.
 *  5. Every attempt is recorded (delivery_attempts) as evidence.
 */
import { createHash } from 'node:crypto';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import {
  IntegrationConfigSchema,
  ProviderError,
  type CanonicalOrder,
  type ErrorClass,
  type IntegrationConfig,
} from '@mi/contracts';
import { deliveries, deliveryAttempts, integrations, observations, syncRuns, type Db } from '@mi/database';
import { describeError, redact, type Logger } from '@mi/observability';
import type { IntegrationImplementation, OrdersPage, ParsedOrder } from './implementation-api.ts';
import type { NetSuiteClient } from './netsuite-client.ts';
import { DEFAULT_RETRY, realSleep, withRetry, type AttemptRecord, type RetryPolicy } from './retry.ts';
import type { ShopifyClient } from './shopify-client.ts';

export const DEFAULT_LEASE_MS = 2 * 60_000;
/** Re-read window before the watermark, absorbing late-visible updates. Safe because delivery is idempotent. */
export const WATERMARK_OVERLAP_MS = 5 * 60_000;
export const DEFAULT_MAX_PAGES = 10_000;

export interface EngineDeps {
  db: Db;
  implementation: IntegrationImplementation;
  implementationVersionId: string | null;
  shopify: ShopifyClient;
  netsuite: NetSuiteClient;
  workerId: string;
  retry?: RetryPolicy;
  logger?: Logger;
  leaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type RunMode = 'backfill' | 'incremental' | 'redelivery' | 'canary';

export interface RunOptions {
  integrationId: string;
  trigger: 'schedule' | 'manual' | 'recovery' | 'release' | 'resume';
  /** 'auto' picks backfill or incremental from durable state. */
  mode?: 'auto' | 'redelivery' | 'canary';
  /** Redelivery: Shopify legacy order ids to re-fetch and deliver. */
  sourceLegacyIds?: string[];
  /** Canary: maximum number of new deliveries before stopping. */
  canaryLimit?: number;
  maxPages?: number;
  /** Test hook invoked after each record reaches a terminal outcome. */
  afterRecord?: (count: number) => void | Promise<void>;
}

export interface RunResult {
  syncRunId: string | null;
  status: 'succeeded' | 'partial' | 'failed' | 'skipped';
  mode?: RunMode;
  reason?: string;
  errorClass?: ErrorClass;
  errorMessage?: string;
  counts: Counts;
  cursorBefore?: string | null;
  cursorAfter?: string | null;
  caughtUp?: boolean;
}

interface Counts {
  pages: number;
  observed: number;
  delivered: number;
  alreadyDelivered: number;
  skipped: number;
  rejected: number;
  failed: number;
  unchangedRejected: number;
}

type RecordOutcome = 'delivered' | 'already' | 'skipped' | 'rejected' | 'unchanged_rejected';

class RunAbort extends Error {
  constructor(
    readonly errorClass: ErrorClass,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function configHash(config: IntegrationConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16);
}

export function idempotencyKey(integrationId: string, sourceId: string): string {
  return `${integrationId}:${sourceId}`;
}

export function shopifyUpdatedAtQuery(watermarkIso: string): string {
  return `updated_at:>='${watermarkIso}'`;
}

/** Computes the next durable watermark: never earlier than the current one. */
export function advanceWatermark(current: string | null, pageMaxUpdatedAt: string | null): string | null {
  if (!pageMaxUpdatedAt) return current;
  if (!current) return pageMaxUpdatedAt;
  return Date.parse(pageMaxUpdatedAt) > Date.parse(current) ? pageMaxUpdatedAt : current;
}

export class SyncEngine {
  private readonly retry: RetryPolicy;
  private readonly leaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: EngineDeps) {
    this.retry = deps.retry ?? DEFAULT_RETRY;
    this.leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
    this.sleep = deps.sleep ?? this.retry.sleep ?? realSleep;
  }

  private get db(): Db {
    return this.deps.db;
  }

  /* -------------------------------- lease -------------------------------- */

  async acquireLease(integrationId: string): Promise<typeof integrations.$inferSelect | undefined> {
    const now = new Date();
    const [row] = await this.db
      .update(integrations)
      .set({ leaseOwner: this.deps.workerId, leaseExpiresAt: new Date(now.getTime() + this.leaseMs) })
      .where(
        and(
          eq(integrations.id, integrationId),
          or(
            isNull(integrations.leaseExpiresAt),
            lt(integrations.leaseExpiresAt, now),
            eq(integrations.leaseOwner, this.deps.workerId),
          ),
        ),
      )
      .returning();
    return row;
  }

  private async renewLease(integrationId: string): Promise<void> {
    const rows = await this.db
      .update(integrations)
      .set({ leaseExpiresAt: new Date(Date.now() + this.leaseMs) })
      .where(and(eq(integrations.id, integrationId), eq(integrations.leaseOwner, this.deps.workerId)))
      .returning({ id: integrations.id });
    if (!rows.length)
      throw new RunAbort(
        'unknown',
        'Lease lost to another worker; stopping without advancing cursor',
        'LEASE_LOST',
      );
  }

  async releaseLease(integrationId: string): Promise<void> {
    await this.db
      .update(integrations)
      .set({ leaseOwner: null, leaseExpiresAt: null })
      .where(and(eq(integrations.id, integrationId), eq(integrations.leaseOwner, this.deps.workerId)));
  }

  /* -------------------------------- observations -------------------------------- */

  private async observe(o: {
    tenantId: string;
    integrationId: string;
    syncRunId: string | null;
    provider: string;
    kind: string;
    errorClass?: string | null;
    code?: string | null;
    message: string;
    data?: unknown;
    traceId?: string | null;
  }): Promise<void> {
    await this.db.insert(observations).values({
      tenantId: o.tenantId,
      integrationId: o.integrationId,
      syncRunId: o.syncRunId,
      provider: o.provider,
      kind: o.kind,
      errorClass: o.errorClass ?? null,
      code: o.code ?? null,
      message: String(redact(o.message)).slice(0, 2000),
      data: (redact(o.data ?? {}) ?? {}) as object,
      traceId: o.traceId ?? null,
      implementationVersionId: this.deps.implementationVersionId,
    });
  }

  /* -------------------------------- run -------------------------------- */

  async run(opts: RunOptions): Promise<RunResult> {
    const counts: Counts = {
      pages: 0,
      observed: 0,
      delivered: 0,
      alreadyDelivered: 0,
      skipped: 0,
      rejected: 0,
      failed: 0,
      unchangedRejected: 0,
    };
    const integration = await this.acquireLease(opts.integrationId);
    if (!integration) return { syncRunId: null, status: 'skipped', reason: 'lease_held', counts };

    const config = IntegrationConfigSchema.parse(integration.config);
    const mode: RunMode =
      opts.mode === 'redelivery'
        ? 'redelivery'
        : opts.mode === 'canary'
          ? 'canary'
          : integration.backfillCompletedAt
            ? 'incremental'
            : 'backfill';
    const cursorBefore = integration.cursorWatermark ?? config.backfillFrom;
    const traceId = createHash('sha256')
      .update(`${opts.integrationId}${Date.now()}${Math.random()}`)
      .digest('hex')
      .slice(0, 32);
    const startedAt = new Date();
    const [run] = await this.db
      .insert(syncRuns)
      .values({
        integrationId: integration.id,
        mode,
        status: 'running',
        trigger: opts.trigger,
        implementationVersionId: this.deps.implementationVersionId,
        workerId: this.deps.workerId,
        traceId,
        startedAt,
        heartbeatAt: startedAt,
        cursorBefore,
      })
      .returning();
    const runId = run!.id;
    const ctx: RunCtx = {
      runId,
      tenantId: integration.tenantId,
      integrationId: integration.id,
      config,
      cfgHash: configHash(config),
      traceId,
      counts,
      evidence: { pages: [], throttle: [], anomalies: [], retries: 0 },
      opts,
    };
    this.deps.logger?.info({ syncRunId: runId, mode, cursorBefore }, 'sync run started');

    let status: RunResult['status'] = 'succeeded';
    let errorClass: ErrorClass | undefined;
    let errorMessage: string | undefined;
    let caughtUp = false;
    let watermark: string | null = integration.cursorWatermark ?? null;
    try {
      if (mode === 'redelivery') {
        await this.runRedelivery(ctx, opts.sourceLegacyIds ?? []);
        caughtUp = false;
      } else {
        const r = await this.runPaged(
          ctx,
          cursorBefore,
          watermark,
          mode === 'canary' ? (opts.canaryLimit ?? 5) : undefined,
        );
        watermark = r.watermark;
        caughtUp = r.caughtUp;
      }
      if (counts.rejected > 0) status = 'partial';
    } catch (err) {
      status = 'failed';
      if (err instanceof RunAbort) {
        errorClass = err.errorClass;
        errorMessage = err.message;
      } else if (err instanceof ProviderError) {
        errorClass = err.errorClass;
        errorMessage = err.message;
      } else {
        errorClass = 'unknown';
        errorMessage = describeError(err).message;
      }
      await this.observe({
        tenantId: ctx.tenantId,
        integrationId: ctx.integrationId,
        syncRunId: runId,
        provider: err instanceof ProviderError ? err.details.provider : 'internal',
        kind: errorClass === 'schema' ? 'schema_change' : 'error',
        errorClass,
        code:
          err instanceof ProviderError
            ? (err.details.code ?? null)
            : err instanceof RunAbort
              ? (err.code ?? null)
              : null,
        message: errorMessage ?? 'unknown error',
        data:
          err instanceof ProviderError ? { status: err.details.status, context: err.details.context } : {},
        traceId,
      });
      this.deps.logger?.warn({ syncRunId: runId, errorClass, errorMessage }, 'sync run failed');
    }

    const finishedAt = new Date();
    const currentWatermark =
      (
        await this.db
          .select({ w: integrations.cursorWatermark })
          .from(integrations)
          .where(eq(integrations.id, integration.id))
      )[0]?.w ?? null;
    await this.db
      .update(syncRuns)
      .set({
        status,
        finishedAt,
        heartbeatAt: finishedAt,
        cursorAfter: currentWatermark,
        pagesFetched: counts.pages,
        observedCount: counts.observed,
        deliveredCount: counts.delivered,
        alreadyDeliveredCount: counts.alreadyDelivered,
        skippedCount: counts.skipped,
        rejectedCount: counts.rejected,
        failedCount: counts.failed,
        errorClass: errorClass ?? null,
        errorMessage: errorMessage ?? null,
        evidence: { ...ctx.evidence, unchangedRejected: counts.unchangedRejected, caughtUp },
      })
      .where(eq(syncRuns.id, runId));

    if (status !== 'failed' && caughtUp) {
      await this.db
        .update(integrations)
        .set({
          lastSuccessfulSyncAt: startedAt,
          ...(mode === 'backfill' ? { backfillCompletedAt: finishedAt } : {}),
          updatedAt: finishedAt,
        })
        .where(eq(integrations.id, integration.id));
    }
    await this.releaseLease(integration.id);
    this.deps.logger?.info({ syncRunId: runId, status, counts }, 'sync run finished');
    return {
      syncRunId: runId,
      status,
      mode,
      counts,
      cursorBefore,
      cursorAfter: currentWatermark,
      caughtUp,
      ...(errorClass ? { errorClass } : {}),
      ...(errorMessage ? { errorMessage } : {}),
    };
  }

  /* -------------------------------- paged retrieval -------------------------------- */

  private async runPaged(
    ctx: RunCtx,
    cursorBefore: string,
    initialWatermark: string | null,
    canaryLimit: number | undefined,
  ): Promise<{ watermark: string | null; caughtUp: boolean }> {
    const from = new Date(
      Math.max(Date.parse(cursorBefore) - (initialWatermark ? WATERMARK_OVERLAP_MS : 0), 0),
    ).toISOString();
    const query = shopifyUpdatedAtQuery(from);
    const maxPages = ctx.opts.maxPages ?? DEFAULT_MAX_PAGES;
    const seen = new Set<string>();
    let after: string | null = null;
    let watermark = initialWatermark;
    let newDeliveries = 0;

    for (;;) {
      if (ctx.counts.pages >= maxPages) {
        throw new RunAbort(
          'permanent',
          `Page limit ${maxPages} reached without completing pagination`,
          'PAGE_LIMIT',
        );
      }
      const page = await this.fetchPage(ctx, query, after, seen);
      ctx.counts.pages++;
      ctx.evidence.pages.push({
        n: ctx.counts.pages,
        records: page.orders.length,
        hasNextPage: page.hasNextPage,
      });

      this.assertNotSystemicParseFailure(page);
      let pageMax: string | null = null;
      for (const parsed of page.orders) {
        const outcome = await this.processParsed(ctx, parsed);
        const u = parsed.ok ? parsed.order.updatedAt : parsed.updatedAt;
        if (u && (!pageMax || Date.parse(u) > Date.parse(pageMax))) pageMax = u;
        if (outcome === 'delivered') newDeliveries++;
        await ctx.opts.afterRecord?.(ctx.counts.observed);
        if (canaryLimit != null && newDeliveries >= canaryLimit) break;
      }

      // Every record in this page now has a durable terminal outcome: advance the cursor.
      const next = advanceWatermark(watermark, pageMax);
      await this.db.transaction(async (tx) => {
        const fenced = await tx
          .update(integrations)
          .set({
            cursorWatermark: next,
            cursorUpdatedAt: new Date(),
            leaseExpiresAt: new Date(Date.now() + this.leaseMs),
          })
          .where(and(eq(integrations.id, ctx.integrationId), eq(integrations.leaseOwner, this.deps.workerId)))
          .returning({ id: integrations.id });
        if (!fenced.length) throw new RunAbort('unknown', 'Lease lost; cursor not advanced', 'LEASE_LOST');
        await tx
          .update(syncRuns)
          .set({
            heartbeatAt: new Date(),
            cursorAfter: next,
            pagesFetched: ctx.counts.pages,
            observedCount: ctx.counts.observed,
            deliveredCount: ctx.counts.delivered,
            alreadyDeliveredCount: ctx.counts.alreadyDelivered,
            skippedCount: ctx.counts.skipped,
            rejectedCount: ctx.counts.rejected,
          })
          .where(eq(syncRuns.id, ctx.runId));
      });
      watermark = next;

      if (canaryLimit != null && newDeliveries >= canaryLimit)
        return { watermark, caughtUp: !page.hasNextPage };
      if (!page.hasNextPage) return { watermark, caughtUp: true };
      after = page.endCursor;
    }
  }

  /** If no record on a non-empty page parses, the provider response shape changed: abort as schema. */
  private assertNotSystemicParseFailure(page: OrdersPage): void {
    if (page.orders.length >= 2 && page.orders.every((o) => !o.ok)) {
      const sample = (page.orders[0] as Extract<ParsedOrder, { ok: false }>).errors.slice(0, 3).join('; ');
      throw new RunAbort(
        'schema',
        `No order on the page could be parsed; response shape changed: ${sample}`,
        'PARSE_SYSTEMIC',
      );
    }
  }

  private async fetchPage(
    ctx: RunCtx,
    query: string,
    after: string | null,
    seen: Set<string>,
  ): Promise<OrdersPage> {
    const impl = this.deps.implementation;
    return withRetry(
      async () => {
        const r = await this.deps.shopify.graphql(impl.ordersQuery, {
          first: ctx.config.pageSize,
          after,
          query,
        });
        await this.pace(ctx, r.cost);
        let page: OrdersPage;
        try {
          page = impl.parseOrdersPage(r.data);
        } catch (err) {
          throw new ProviderError(
            `Shopify response could not be parsed: ${describeError(err).message}`,
            'schema',
            {
              provider: 'shopify',
              code: 'PARSE',
            },
          );
        }
        if (page.hasNextPage && !page.endCursor) {
          ctx.evidence.anomalies.push({ code: 'PAGINATION_MISSING_CURSOR', after });
          throw new ProviderError('Pagination anomaly: hasNextPage=true without endCursor', 'transient', {
            provider: 'shopify',
            code: 'PAGINATION_MISSING_CURSOR',
          });
        }
        const ids = page.orders.map((o) => (o.ok ? o.order.sourceId : o.sourceId));
        if ((after && page.endCursor === after) || (ids.length > 0 && ids.every((id) => seen.has(id)))) {
          ctx.evidence.anomalies.push({ code: 'PAGINATION_REPEATED_PAGE', after });
          throw new ProviderError('Pagination anomaly: page repeated / cursor did not advance', 'transient', {
            provider: 'shopify',
            code: 'PAGINATION_REPEATED_PAGE',
          });
        }
        for (const id of ids) seen.add(id);
        return page;
      },
      this.retry,
      (a) => this.recordProviderAttempt(ctx, 'shopify', a),
    );
  }

  /** Proactive pacing on Shopify's calculated-cost bucket. */
  private async pace(
    ctx: RunCtx,
    cost:
      | { requestedQueryCost?: number; throttleStatus?: { currentlyAvailable: number; restoreRate: number } }
      | undefined,
  ) {
    const ts = cost?.throttleStatus;
    if (!ts || !cost?.requestedQueryCost) return;
    if (ts.currentlyAvailable < cost.requestedQueryCost && ts.restoreRate > 0) {
      const waitMs = Math.ceil(((cost.requestedQueryCost - ts.currentlyAvailable) / ts.restoreRate) * 1000);
      ctx.evidence.throttle.push({ waitMs, available: ts.currentlyAvailable });
      await this.sleep(waitMs);
    }
  }

  private async recordProviderAttempt(ctx: RunCtx, provider: string, a: AttemptRecord): Promise<void> {
    if (!a.error) return;
    ctx.evidence.retries++;
    const kind =
      a.error.class === 'rate_limited'
        ? 'rate_limit'
        : /pagination anomaly/i.test(a.error.message)
          ? 'anomaly'
          : 'error';
    await this.observe({
      tenantId: ctx.tenantId,
      integrationId: ctx.integrationId,
      syncRunId: ctx.runId,
      provider,
      kind,
      errorClass: a.error.class,
      code: a.error.status != null ? String(a.error.status) : null,
      message: `Attempt ${a.attempt}: ${a.error.message}`,
      data: { delayMs: a.delayMs ?? null },
      traceId: ctx.traceId,
    });
  }

  /* -------------------------------- redelivery -------------------------------- */

  private async runRedelivery(ctx: RunCtx, legacyIds: string[]): Promise<void> {
    const impl = this.deps.implementation;
    for (const legacyId of legacyIds) {
      if (!/^\d+$/.test(legacyId)) continue;
      const parsed = await withRetry(
        async () => {
          const r = await this.deps.shopify.graphql(impl.orderByIdQuery, {
            id: `gid://shopify/Order/${legacyId}`,
          });
          await this.pace(ctx, r.cost);
          try {
            return impl.parseOrder(r.data);
          } catch (err) {
            throw new ProviderError(
              `Order response could not be parsed: ${describeError(err).message}`,
              'schema',
              {
                provider: 'shopify',
                code: 'PARSE',
              },
            );
          }
        },
        this.retry,
        (a) => this.recordProviderAttempt(ctx, 'shopify', a),
      );
      ctx.counts.pages++;
      if (!parsed) {
        await this.observe({
          tenantId: ctx.tenantId,
          integrationId: ctx.integrationId,
          syncRunId: ctx.runId,
          provider: 'shopify',
          kind: 'anomaly',
          code: 'SOURCE_NOT_FOUND',
          message: `Order ${legacyId} not found in source during redelivery`,
          traceId: ctx.traceId,
        });
        continue;
      }
      await this.processParsed(ctx, parsed, { force: true });
    }
  }

  /* -------------------------------- per-record processing -------------------------------- */

  private async processParsed(
    ctx: RunCtx,
    parsed: ParsedOrder,
    o: { force?: boolean } = {},
  ): Promise<RecordOutcome> {
    ctx.counts.observed++;
    if (!parsed.ok) {
      if (!parsed.legacyId || !parsed.updatedAt) {
        throw new RunAbort(
          'schema',
          `Order ${parsed.sourceId} lacks identity fields: ${parsed.errors.join('; ')}`,
          'PARSE_IDENTITY',
        );
      }
      return this.rejectUnparseable(ctx, parsed);
    }
    return this.processOrder(ctx, parsed.order, o.force ?? false);
  }

  private async upsertDeliveryRow(
    ctx: RunCtx,
    ident: { sourceId: string; legacyId: string; name: string; createdAt: string; updatedAt: string },
  ) {
    const key = idempotencyKey(ctx.integrationId, ident.sourceId);
    const updatedAt = new Date(ident.updatedAt);
    const [row] = await this.db
      .insert(deliveries)
      .values({
        integrationId: ctx.integrationId,
        idempotencyKey: key,
        sourceId: ident.sourceId,
        sourceLegacyId: ident.legacyId,
        sourceName: ident.name,
        sourceCreatedAt: new Date(ident.createdAt),
        sourceUpdatedAt: updatedAt,
        latestSourceUpdatedAt: updatedAt,
        externalId: this.deps.implementation.externalIdFor(ident.legacyId),
        firstSyncRunId: ctx.runId,
        lastSyncRunId: ctx.runId,
      })
      .onConflictDoUpdate({
        target: deliveries.idempotencyKey,
        set: {
          latestSourceUpdatedAt: sql`GREATEST(${deliveries.latestSourceUpdatedAt}, excluded.latest_source_updated_at)`,
          lastSyncRunId: ctx.runId,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row!;
  }

  private async rejectUnparseable(
    ctx: RunCtx,
    parsed: Extract<ParsedOrder, { ok: false }>,
  ): Promise<RecordOutcome> {
    const row = await this.upsertDeliveryRow(ctx, {
      sourceId: parsed.sourceId,
      legacyId: parsed.legacyId!,
      name: `#${parsed.legacyId}`,
      createdAt: parsed.updatedAt!,
      updatedAt: parsed.updatedAt!,
    });
    if (row.outcome === 'delivered') {
      ctx.counts.alreadyDelivered++;
      return 'already';
    }
    await this.finishRecord(ctx, row.id, row.attempts + 1, 'rejected', {
      errorClass: 'invalid_data',
      errorMessage: parsed.errors.join('; '),
      validation: { ok: false, reasons: parsed.errors, configHash: ctx.cfgHash, stage: 'parse' },
    });
    ctx.counts.rejected++;
    return 'rejected';
  }

  private async processOrder(ctx: RunCtx, order: CanonicalOrder, force: boolean): Promise<RecordOutcome> {
    const row = await this.upsertDeliveryRow(ctx, order);

    if (row.outcome === 'delivered') {
      if (Date.parse(order.updatedAt) > row.sourceUpdatedAt.getTime()) {
        await this.observe({
          tenantId: ctx.tenantId,
          integrationId: ctx.integrationId,
          syncRunId: ctx.runId,
          provider: 'shopify',
          kind: 'anomaly',
          code: 'SOURCE_CHANGED_AFTER_DELIVERY',
          message: `Order ${order.name} changed after delivery; edits are not propagated under contract 1.0.0`,
          data: {
            sourceId: order.sourceId,
            deliveredVersion: row.sourceUpdatedAt.toISOString(),
            latest: order.updatedAt,
          },
          traceId: ctx.traceId,
        });
      }
      ctx.counts.alreadyDelivered++;
      return 'already';
    }

    const validation = row.validation as { configHash?: string } | null;
    const unchanged =
      row.outcome === 'rejected' &&
      !force &&
      validation?.configHash === ctx.cfgHash &&
      row.sourceUpdatedAt.getTime() === Date.parse(order.updatedAt);
    if (unchanged) {
      ctx.counts.unchangedRejected++;
      return 'unchanged_rejected';
    }
    if (row.outcome === 'skipped' && order.cancelledAt) {
      ctx.counts.alreadyDelivered++;
      return 'already';
    }

    const mapping = this.deps.implementation.mapOrder(order, ctx.config);
    if (mapping.kind === 'skip') {
      await this.finishRecord(ctx, row.id, row.attempts + 1, 'skipped', {
        sourceUpdatedAt: order.updatedAt,
        validation: { ok: true, skipped: mapping.reason, configHash: ctx.cfgHash },
      });
      ctx.counts.skipped++;
      return 'skipped';
    }
    if (mapping.kind === 'reject') {
      await this.finishRecord(ctx, row.id, row.attempts + 1, 'rejected', {
        sourceUpdatedAt: order.updatedAt,
        errorClass: 'invalid_data',
        errorMessage: mapping.reasons.join('; '),
        validation: { ok: false, reasons: mapping.reasons, configHash: ctx.cfgHash, stage: 'mapping' },
      });
      ctx.counts.rejected++;
      return 'rejected';
    }

    // Deliver with retries; each attempt is durable evidence.
    let attemptNo = row.attempts;
    const started = new Date();
    try {
      const res = await withRetry(
        async () => {
          attemptNo++;
          return this.deps.netsuite.upsertSalesOrder(mapping.payload);
        },
        this.retry,
        async (a) => {
          if (!a.error) return;
          ctx.evidence.retries++;
          await this.db.insert(deliveryAttempts).values({
            deliveryId: row.id,
            syncRunId: ctx.runId,
            attemptNo,
            outcome: 'failed',
            httpStatus: a.error.status ?? null,
            errorClass: a.error.class,
            errorMessage: String(redact(a.error.message)).slice(0, 1000),
            implementationVersionId: this.deps.implementationVersionId,
            evidence: { retryDelayMs: a.delayMs ?? null },
            startedAt: started,
            finishedAt: new Date(),
          });
        },
      );
      let destinationId = res.destinationId;
      if (!destinationId) {
        // NetSuite may omit Location on update; resolve by external id for evidence.
        const rec = await this.deps.netsuite.getSalesOrderByExternalId(mapping.payload.externalId);
        destinationId = rec && typeof rec.id === 'string' ? rec.id : null;
      }
      await this.finishRecord(ctx, row.id, attemptNo, 'delivered', {
        sourceUpdatedAt: order.updatedAt,
        destinationId,
        httpStatus: res.status,
        summary: mapping.summary,
        validation: { ok: true, configHash: ctx.cfgHash },
      });
      ctx.counts.delivered++;
      return 'delivered';
    } catch (err) {
      const pe = err instanceof ProviderError ? err : undefined;
      const cls: ErrorClass = pe?.errorClass ?? 'unknown';
      if (cls === 'invalid_data') {
        // Destination rejected the record (e.g. mandatory custom field). Durable, customer-actionable.
        await this.db
          .update(deliveries)
          .set({
            outcome: 'rejected',
            attempts: attemptNo,
            lastErrorClass: cls,
            lastError: String(redact(pe!.message)).slice(0, 1000),
            sourceUpdatedAt: new Date(order.updatedAt),
            validation: { ok: false, reasons: [pe!.message], configHash: ctx.cfgHash, stage: 'destination' },
            lastSyncRunId: ctx.runId,
            updatedAt: new Date(),
          })
          .where(eq(deliveries.id, row.id));
        ctx.counts.rejected++;
        return 'rejected';
      }
      await this.db
        .update(deliveries)
        .set({
          outcome: 'failed',
          attempts: attemptNo,
          lastErrorClass: cls,
          lastError: String(redact(pe?.message ?? describeError(err).message)).slice(0, 1000),
          lastSyncRunId: ctx.runId,
          updatedAt: new Date(),
        })
        .where(eq(deliveries.id, row.id));
      ctx.counts.failed++;
      throw new RunAbort(
        cls,
        `Delivery of ${order.name} failed (${cls}): ${pe?.message ?? describeError(err).message}`,
        pe?.details.code,
      );
    }
  }

  private async finishRecord(
    ctx: RunCtx,
    deliveryId: string,
    attemptNo: number,
    outcome: 'delivered' | 'skipped' | 'rejected',
    d: {
      sourceUpdatedAt?: string;
      destinationId?: string | null;
      httpStatus?: number;
      errorClass?: string;
      errorMessage?: string;
      summary?: unknown;
      validation?: unknown;
    },
  ): Promise<void> {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(deliveries)
        .set({
          outcome,
          attempts: attemptNo,
          ...(d.sourceUpdatedAt ? { sourceUpdatedAt: new Date(d.sourceUpdatedAt) } : {}),
          ...(d.destinationId !== undefined ? { destinationId: d.destinationId } : {}),
          ...(d.summary ? { summary: d.summary as object } : {}),
          ...(d.validation ? { validation: d.validation as object } : {}),
          lastErrorClass: d.errorClass ?? null,
          lastError: d.errorMessage ? String(redact(d.errorMessage)).slice(0, 1000) : null,
          lastSyncRunId: ctx.runId,
          ...(outcome === 'delivered' ? { deliveredAt: now } : {}),
          updatedAt: now,
        })
        .where(eq(deliveries.id, deliveryId));
      await tx.insert(deliveryAttempts).values({
        deliveryId,
        syncRunId: ctx.runId,
        attemptNo,
        outcome,
        httpStatus: d.httpStatus ?? null,
        errorClass: d.errorClass ?? null,
        errorMessage: d.errorMessage ? String(redact(d.errorMessage)).slice(0, 1000) : null,
        destinationId: d.destinationId ?? null,
        implementationVersionId: this.deps.implementationVersionId,
        evidence: d.summary ? { summary: d.summary } : {},
        startedAt: now,
        finishedAt: now,
      });
    });
  }
}

interface RunCtx {
  runId: string;
  tenantId: string;
  integrationId: string;
  config: IntegrationConfig;
  cfgHash: string;
  traceId: string;
  counts: Counts;
  evidence: {
    pages: { n: number; records: number; hasNextPage: boolean }[];
    throttle: { waitMs: number; available: number }[];
    anomalies: { code: string; after: string | null }[];
    retries: number;
  };
  opts: RunOptions;
}

/**
 * Marks runs whose worker died (no heartbeat within staleMs) as interrupted and clears the
 * expired lease so the next scheduled run resumes from the last durable cursor.
 */
export async function recoverInterruptedRuns(db: Db, staleMs = DEFAULT_LEASE_MS): Promise<string[]> {
  const cutoff = new Date(Date.now() - staleMs);
  const rows = await db
    .update(syncRuns)
    .set({
      status: 'interrupted',
      finishedAt: new Date(),
      errorClass: 'transient',
      errorMessage:
        'Worker stopped before completing the run (no heartbeat). Resumed from last durable cursor.',
    })
    .where(and(eq(syncRuns.status, 'running'), lt(syncRuns.heartbeatAt, cutoff)))
    .returning({ id: syncRuns.id, integrationId: syncRuns.integrationId });
  if (rows.length) {
    await db
      .update(integrations)
      .set({ leaseOwner: null, leaseExpiresAt: null })
      .where(
        and(
          sql`${integrations.id} IN (${sql.join(
            rows.map((r) => sql`${r.integrationId}`),
            sql`, `,
          )})`,
          lt(integrations.leaseExpiresAt, new Date()),
        ),
      );
  }
  return rows.map((r) => r.id);
}
