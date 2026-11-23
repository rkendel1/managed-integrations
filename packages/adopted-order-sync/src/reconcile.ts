/**
 * Reconciliation and missing-delivery recovery for the ADOPTED flow.
 *
 * Authorities: Shopify for the order population; NetSuite for destination existence; Managed
 * Integrations for delivery attempts, scheduling, tenancy and evidence. Webhook receipts are NOT
 * assumed complete: discovery reads the source provider directly.
 *
 * Reuses: `reconciliation_runs` (run record), `readDestination` from the native reconciliation
 * (NetSuite match by externalId OR order reference), the provider clients, `withRetry`, the
 * delivery records and the adopted executor `executeDelivery` (upstream code). New: per-order
 * `reconciliation_items` and the source-order execution input (see source.ts).
 */
import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import {
  deliveries,
  integrations,
  reconciliationItems,
  reconciliationRuns,
  webhookReceipts,
  type Db,
} from '@mi/database';
import {
  ConnectionCredentials,
  DEFAULT_RETRY,
  NetSuiteClient,
  sha256Hex,
  ShopifyClient,
  sourceImplementation,
  withRetry,
  type CredentialCipher,
  type ProviderEndpointConfig,
  type RetryPolicy,
} from '@mi/integration-shopify-netsuite';
import { ProviderError } from '@mi/contracts';
import { describeError, redact } from '@mi/observability';
import { readDestination, type DestinationRecord } from '@mi/reliability';
import { ADOPTED_FLOW_TYPE, AdoptedConfigSchema } from './contract.ts';
import { executeDelivery, requestDeliveryRetry, STUCK_AFTER_MS, type ExecuteResult } from './execute.ts';
import {
  DISCOVERY_PAGE_SIZE,
  DISCOVERY_QUERY,
  discoveryFilter,
  exclusionReason,
  RECOVERY_ORDER_QUERY,
  toUpstreamOrderInput,
  type DiscoveredOrder,
  type RecoveryOrder,
} from './source.ts';

export const CLASSIFICATIONS = [
  'delivered',
  'missing_delivery',
  'pending_delivery',
  'failed_delivery',
  'destination_exists_untracked',
  'ambiguous',
  'undetermined',
  'excluded',
] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export const RECOVERY_STATES = [
  'none',
  'requested',
  'executing',
  'recovered',
  'failed',
  'unverified',
  'skipped',
] as const;
export type RecoveryState = (typeof RECOVERY_STATES)[number];

const LEASE_MS = 2 * 60_000;
const EXTERNAL_ID = (legacyId: string) => `shopify-${legacyId}`;

/* ------------------------------------------------------------------ clients */

export interface AdoptedClients {
  shopify: ShopifyClient;
  netsuite: NetSuiteClient;
}

/** Provider clients for an adopted integration's tenant, from its durable connections. */
export async function adoptedClients(
  db: Db,
  cipher: CredentialCipher,
  endpoints: ProviderEndpointConfig,
  integrationId: string,
): Promise<AdoptedClients> {
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, integrationId));
  if (!integ || integ.flowType !== ADOPTED_FLOW_TYPE) throw new Error('Not an adopted integration');
  const creds = new ConnectionCredentials(db, cipher, endpoints);
  const shop = await creds.load(integ.tenantId, 'shopify');
  const ns = await creds.load(integ.tenantId, 'netsuite');
  if (!shop?.baseUrl || !ns?.baseUrl) {
    throw new ProviderError('Shopify and NetSuite must both be connected', 'authentication', {
      provider: !shop?.baseUrl ? 'shopify' : 'netsuite',
      code: 'NOT_CONNECTED',
    });
  }
  return {
    shopify: new ShopifyClient({
      baseUrl: shop.baseUrl,
      apiVersion: sourceImplementation.shopifyApiVersion,
      auth: creds.shopifyAuth(shop),
    }),
    netsuite: new NetSuiteClient({ baseUrl: ns.baseUrl, auth: creds.netsuiteAuth(ns) }),
  };
}

/* ------------------------------------------------------------------ start */

export interface StartResult {
  runId: string;
  deduplicated: boolean;
  windowFrom: string;
  windowTo: string;
}

/**
 * Starts (or joins) the reconciliation of an adopted integration. Serialized per integration by a
 * row lock on the integration, so concurrent requests yield exactly one running run.
 */
export async function startReconciliation(
  db: Db,
  p: { integrationId: string; trigger: 'manual' | 'schedule'; requestedBy?: string | null; now?: Date },
): Promise<StartResult> {
  return db.transaction(async (tx) => {
    const [integ] = await tx
      .select()
      .from(integrations)
      .where(eq(integrations.id, p.integrationId))
      .for('update');
    if (!integ || integ.flowType !== ADOPTED_FLOW_TYPE)
      throw new Error('Reconciliation of this kind applies only to adopted integrations');
    const [running] = await tx
      .select()
      .from(reconciliationRuns)
      .where(and(eq(reconciliationRuns.integrationId, integ.id), eq(reconciliationRuns.status, 'running')));
    if (running)
      return {
        runId: running.id,
        deduplicated: true,
        windowFrom: running.windowFrom.toISOString(),
        windowTo: running.windowTo.toISOString(),
      };
    const config = AdoptedConfigSchema.parse(integ.config);
    const now = p.now ?? new Date();
    const windowFrom = config.reconcileFrom ? new Date(config.reconcileFrom) : integ.createdAt;
    // Orders newer than the grace period may still be on their way through the webhook path.
    const windowTo = new Date(now.getTime() - config.reconcileGraceMinutes * 60_000);
    const [run] = await tx
      .insert(reconciliationRuns)
      .values({
        integrationId: integ.id,
        trigger: p.trigger,
        status: 'running',
        windowFrom,
        windowTo,
        requestedBy: p.requestedBy ?? null,
        evidence: {
          kind: 'adopted',
          source: 'shopify admin graphql orders (created_at window)',
          destination: 'netsuite suiteql by externalId or order reference',
          events: [
            {
              at: now.toISOString(),
              event: 'started',
              trigger: p.trigger,
              requestedBy: p.requestedBy ?? null,
            },
          ],
        },
      })
      .returning();
    return {
      runId: run!.id,
      deduplicated: false,
      windowFrom: windowFrom.toISOString(),
      windowTo: windowTo.toISOString(),
    };
  });
}

/* ------------------------------------------------------------------ scan */

interface LocalDelivery {
  id: string;
  outcome: string;
  updatedAt: Date;
  lastError: string | null;
}

/** Deterministic classification of one eligible discovered order. */
export function classify(
  order: { legacyId: string; name: string },
  local: LocalDelivery | undefined,
  destination: DestinationRecord[] | null,
): { classification: Classification; reason: string; destinationIds: string[] } {
  if (destination === null)
    return {
      classification: 'undetermined',
      reason: 'NetSuite could not be read for this order',
      destinationIds: [],
    };
  const ext = EXTERNAL_ID(order.legacyId);
  const matches = destination.filter((d) => d.externalId === ext || d.otherRefNum === order.name);
  const ids = matches.map((m) => m.id);
  const ours = matches.filter((m) => m.externalId === ext);
  const foreign = matches.filter((m) => m.externalId !== ext);
  if (ours.length > 1 || foreign.length > 0) {
    return {
      classification: 'ambiguous',
      reason: `${matches.length} NetSuite sales order(s) reference ${order.name}${foreign.length ? ', including one without our externalId' : ''}; review required`,
      destinationIds: ids,
    };
  }
  if (local) {
    if (local.outcome === 'delivered') {
      return ours.length === 1
        ? { classification: 'delivered', reason: `NetSuite sales order ${ours[0]!.id}`, destinationIds: ids }
        : {
            classification: 'ambiguous',
            reason: 'Recorded as delivered, but NetSuite has no matching sales order; review required',
            destinationIds: ids,
          };
    }
    const stuck = Date.now() - local.updatedAt.getTime() > STUCK_AFTER_MS;
    if (ours.length === 1)
      return {
        classification: 'ambiguous',
        reason: `NetSuite has sales order ${ours[0]!.id} but local delivery is ${local.outcome}; review required`,
        destinationIds: ids,
      };
    if ((local.outcome === 'pending' || local.outcome === 'running') && !stuck)
      return {
        classification: 'pending_delivery',
        reason: `Delivery is ${local.outcome}`,
        destinationIds: ids,
      };
    return {
      classification: 'failed_delivery',
      reason: `Delivery is ${stuck ? `stuck (${local.outcome})` : local.outcome}${local.lastError ? `: ${local.lastError}` : ''}`,
      destinationIds: ids,
    };
  }
  if (ours.length === 1)
    return {
      classification: 'destination_exists_untracked',
      reason: `NetSuite sales order ${ours[0]!.id} exists without local delivery evidence`,
      destinationIds: ids,
    };
  return {
    classification: 'missing_delivery',
    reason: 'No webhook receipt, no delivery, and no NetSuite sales order',
    destinationIds: [],
  };
}

export interface ScanParams {
  db: Db;
  runId: string;
  workerId: string;
  clients: AdoptedClients;
  retry?: RetryPolicy;
  pageSize?: number;
  /** Test hook: called after each page is durably committed. */
  afterPage?: (pagesScanned: number) => void | Promise<void>;
}

export type ScanResult = {
  status: 'completed' | 'failed' | 'skipped';
  pagesScanned: number;
  reason?: string;
};

export async function scanReconciliation(p: ScanParams): Promise<ScanResult> {
  const { db } = p;
  const retry = p.retry ?? DEFAULT_RETRY;
  const now = new Date();
  const [run] = await db
    .update(reconciliationRuns)
    .set({ leaseOwner: p.workerId, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) })
    .where(
      and(
        eq(reconciliationRuns.id, p.runId),
        eq(reconciliationRuns.status, 'running'),
        or(
          sql`${reconciliationRuns.leaseExpiresAt} IS NULL`,
          lt(reconciliationRuns.leaseExpiresAt, now),
          eq(reconciliationRuns.leaseOwner, p.workerId),
        ),
      ),
    )
    .returning();
  if (!run)
    return { status: 'skipped', pagesScanned: 0, reason: 'not running or lease held by another worker' };
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, run.integrationId));
  const filter = discoveryFilter(run.windowFrom, run.windowTo);
  let cursor = run.cursor;
  let pages = run.pagesScanned;
  if (cursor || pages > 0)
    await appendEvent(db, run.id, { event: 'resumed', worker: p.workerId, fromPage: pages });

  for (;;) {
    let page: { nodes: DiscoveredOrder[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    try {
      const r = await withRetry(
        () =>
          p.clients.shopify.graphql(DISCOVERY_QUERY, {
            first: p.pageSize ?? DISCOVERY_PAGE_SIZE,
            after: cursor,
            query: filter,
          }),
        retry,
      );
      const conn = (r.data as { orders?: typeof page })?.orders;
      if (!conn?.nodes || !conn.pageInfo)
        throw new ProviderError('Unexpected orders response shape', 'schema', { provider: 'shopify' });
      if (conn.pageInfo.hasNextPage && (!conn.pageInfo.endCursor || conn.pageInfo.endCursor === cursor)) {
        throw new ProviderError('Pagination did not advance', 'transient', {
          provider: 'shopify',
          code: 'PAGINATION',
        });
      }
      page = conn;
    } catch (err) {
      await finishRun(
        db,
        run.id,
        p.workerId,
        'failed',
        `Source scan failed after page ${pages}: ${describeError(err).message}`,
      );
      return { status: 'failed', pagesScanned: pages, reason: describeError(err).message };
    }

    // Destination lookup for the eligible orders of this page (NetSuite is authoritative for existence).
    const eligible = page.nodes.filter((o) => !exclusionReason(o));
    let destination: DestinationRecord[] | null = [];
    if (eligible.length) {
      try {
        destination = await readDestination(
          p.clients.netsuite,
          eligible.map((o) => ({
            sourceId: o.id,
            legacyId: o.legacyResourceId,
            name: o.name,
            updatedAt: o.createdAt,
            cancelledAt: o.cancelledAt,
            lines: [],
          })),
          retry,
        );
      } catch {
        destination = null; // recorded per order as 'undetermined'
      }
    }
    const keys = page.nodes.map((o) => `${integ!.id}:${o.id}`);
    const locals = keys.length
      ? await db
          .select()
          .from(deliveries)
          .where(and(eq(deliveries.integrationId, integ!.id), inArray(deliveries.idempotencyKey, keys)))
      : [];
    const localBy = new Map(locals.map((d) => [d.sourceId, d]));

    const rows = page.nodes.map((o) => {
      const excluded = exclusionReason(o);
      const local = localBy.get(o.id);
      const c = excluded
        ? { classification: 'excluded' as Classification, reason: excluded, destinationIds: [] as string[] }
        : classify({ legacyId: o.legacyResourceId, name: o.name }, local, destination);
      return {
        runId: run.id,
        tenantId: integ!.tenantId,
        integrationId: integ!.id,
        sourceOrderId: o.id,
        sourceLegacyId: o.legacyResourceId,
        orderName: o.name,
        sourceCreatedAt: new Date(o.createdAt),
        classification: c.classification,
        reason: c.reason,
        deliveryId: local?.id ?? null,
        destinationIds: c.destinationIds,
      };
    });
    pages += 1;
    const nextCursor = page.pageInfo.endCursor;
    const committed = await db
      .transaction(async (tx) => {
        for (const row of rows) {
          await tx
            .insert(reconciliationItems)
            .values(row)
            .onConflictDoUpdate({
              target: [reconciliationItems.runId, reconciliationItems.sourceOrderId],
              set: {
                classification: row.classification,
                reason: row.reason,
                deliveryId: row.deliveryId,
                destinationIds: row.destinationIds,
                updatedAt: new Date(),
              },
            });
        }
        const fenced = await tx
          .update(reconciliationRuns)
          .set({ cursor: nextCursor, pagesScanned: pages, leaseExpiresAt: new Date(Date.now() + LEASE_MS) })
          .where(and(eq(reconciliationRuns.id, run.id), eq(reconciliationRuns.leaseOwner, p.workerId)))
          .returning({ id: reconciliationRuns.id });
        if (!fenced.length) throw new Error('lease lost');
        return true;
      })
      .catch(() => false);
    if (!committed) return { status: 'skipped', pagesScanned: pages - 1, reason: 'lease lost' };
    cursor = nextCursor;
    await p.afterPage?.(pages);
    if (!page.pageInfo.hasNextPage) break;
  }
  await finishRun(db, run.id, p.workerId, 'completed', null);
  return { status: 'completed', pagesScanned: pages };
}

async function appendEvent(db: Db, runId: string, event: Record<string, unknown>) {
  await db
    .update(reconciliationRuns)
    .set({
      evidence: sql`jsonb_set(${reconciliationRuns.evidence}, '{events}', coalesce(${reconciliationRuns.evidence}->'events', '[]'::jsonb) || ${JSON.stringify([{ at: new Date().toISOString(), ...event }])}::jsonb)`,
    })
    .where(eq(reconciliationRuns.id, runId));
}

export async function summarizeRun(db: Db, runId: string): Promise<Record<Classification, number>> {
  const rows = await db
    .select({ c: reconciliationItems.classification, n: sql<number>`count(*)::int` })
    .from(reconciliationItems)
    .where(eq(reconciliationItems.runId, runId))
    .groupBy(reconciliationItems.classification);
  const out = Object.fromEntries(CLASSIFICATIONS.map((c) => [c, 0])) as Record<Classification, number>;
  for (const r of rows) out[r.c as Classification] = r.n;
  return out;
}

async function finishRun(
  db: Db,
  runId: string,
  workerId: string,
  status: 'completed' | 'failed',
  error: string | null,
) {
  const counts = await summarizeRun(db, runId);
  const items = await db.select().from(reconciliationItems).where(eq(reconciliationItems.runId, runId));
  const pick = (c: Classification[]) =>
    items
      .filter((i) => c.includes(i.classification as Classification))
      .map((i) => ({ legacyId: i.sourceLegacyId, name: i.orderName, reason: i.reason }));
  const issues =
    counts.missing_delivery +
    counts.failed_delivery +
    counts.ambiguous +
    counts.undetermined +
    counts.destination_exists_untracked;
  const outcome =
    status === 'failed' || counts.undetermined > 0
      ? 'partial'
      : issues === 0
        ? 'consistent'
        : 'discrepancies';
  await db
    .update(reconciliationRuns)
    .set({
      status,
      outcome,
      sourceCount: items.length,
      expectedCount: items.length - counts.excluded,
      matchedCount: counts.delivered,
      destinationCount: counts.delivered + counts.destination_exists_untracked,
      missing: pick(['missing_delivery']),
      unresolved: pick(['ambiguous', 'undetermined', 'destination_exists_untracked']),
      errorMessage: error ? String(redact(error)).slice(0, 1000) : null,
      finishedAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
      evidence: sql`jsonb_set(${reconciliationRuns.evidence}, '{events}', coalesce(${reconciliationRuns.evidence}->'events', '[]'::jsonb) || ${JSON.stringify([{ at: new Date().toISOString(), event: status, worker: workerId, counts, error }])}::jsonb) || ${JSON.stringify({ counts })}::jsonb`,
    })
    .where(and(eq(reconciliationRuns.id, runId), eq(reconciliationRuns.leaseOwner, workerId)));
}

/* ------------------------------------------------------------------ recovery request */

export type RecoveryDecision =
  | { sourceOrderId: string; accepted: true; itemId: string; deliveryId: string; mode: 'new' | 'retry' }
  | { sourceOrderId: string; accepted: false; reason: string };

/**
 * Records the durable recovery intent for missing orders BEFORE any execution. Per order, in one
 * transaction with the item row locked:
 *  - only items classified `missing_delivery` (or a previously failed recovery) are eligible;
 *  - a delivery row is created with the durable source identity as idempotency key — if one exists
 *    (webhook arrived meanwhile, or another request won), the request is refused, not duplicated.
 */
export async function requestRecovery(
  db: Db,
  p: { runId: string; sourceOrderIds: string[]; principalId: string; requestId: string; reason: string },
): Promise<RecoveryDecision[]> {
  const out: RecoveryDecision[] = [];
  for (const sourceOrderId of p.sourceOrderIds) {
    out.push(
      await db.transaction(async (tx): Promise<RecoveryDecision> => {
        const [item] = await tx
          .select()
          .from(reconciliationItems)
          .where(
            and(eq(reconciliationItems.runId, p.runId), eq(reconciliationItems.sourceOrderId, sourceOrderId)),
          )
          .for('update');
        if (!item)
          return { sourceOrderId, accepted: false, reason: 'Order is not part of this reconciliation run' };
        const intent = {
          recoveryState: 'requested',
          recoveryRequestedBy: p.principalId,
          recoveryRequestId: p.requestId,
          recoveryReason: p.reason,
          recoveryRequestedAt: new Date(),
          updatedAt: new Date(),
        };
        if (item.recoveryState === 'failed' && item.deliveryId) {
          const r = await requestDeliveryRetry(tx as unknown as Db, item.deliveryId);
          if (!r.accepted)
            return { sourceOrderId, accepted: false, reason: `Delivery is ${r.currentOutcome}` };
          await tx.update(reconciliationItems).set(intent).where(eq(reconciliationItems.id, item.id));
          return {
            sourceOrderId,
            accepted: true,
            itemId: item.id,
            deliveryId: item.deliveryId,
            mode: 'retry',
          };
        }
        if (item.classification !== 'missing_delivery') {
          return {
            sourceOrderId,
            accepted: false,
            reason: `Classified ${item.classification}; only missing deliveries are recovered automatically`,
          };
        }
        if (item.recoveryState !== 'none')
          return { sourceOrderId, accepted: false, reason: `Recovery already ${item.recoveryState}` };
        const key = `${item.integrationId}:${item.sourceOrderId}`;
        const inserted = await tx
          .insert(deliveries)
          .values({
            integrationId: item.integrationId,
            idempotencyKey: key,
            sourceId: item.sourceOrderId,
            sourceLegacyId: item.sourceLegacyId,
            sourceName: item.orderName,
            sourceCreatedAt: item.sourceCreatedAt,
            sourceUpdatedAt: item.sourceCreatedAt,
            latestSourceUpdatedAt: item.sourceCreatedAt,
            externalId: EXTERNAL_ID(item.sourceLegacyId),
            outcome: 'pending',
          })
          .onConflictDoNothing()
          .returning({ id: deliveries.id });
        if (!inserted.length) {
          await tx
            .update(reconciliationItems)
            .set({
              reason:
                'A delivery for this order now exists (received after discovery); re-run reconciliation',
              updatedAt: new Date(),
            })
            .where(eq(reconciliationItems.id, item.id));
          return {
            sourceOrderId,
            accepted: false,
            reason: 'A delivery for this order already exists (received after discovery)',
          };
        }
        await tx
          .update(reconciliationItems)
          .set({ ...intent, deliveryId: inserted[0]!.id })
          .where(eq(reconciliationItems.id, item.id));
        return { sourceOrderId, accepted: true, itemId: item.id, deliveryId: inserted[0]!.id, mode: 'new' };
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ recovery execution */

export interface RecoverParams {
  db: Db;
  cipher: CredentialCipher;
  endpoints: ProviderEndpointConfig;
  itemId: string;
  clients: AdoptedClients;
  retry?: RetryPolicy;
}

export type RecoverResult =
  | { done: false; reason: string; retryLater?: boolean }
  | { done: true; state: RecoveryState; detail: string; execution?: ExecuteResult };

async function setItem(db: Db, itemId: string, values: Partial<typeof reconciliationItems.$inferInsert>) {
  await db
    .update(reconciliationItems)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(reconciliationItems.id, itemId));
}

/**
 * Executes one requested recovery through the adopted executor, then verifies NetSuite.
 * Re-checks destination existence and source eligibility immediately before execution (state may
 * have changed since discovery). Never relies on NetSuite upsert behaviour for duplicate safety.
 */
export async function executeRecovery(p: RecoverParams): Promise<RecoverResult> {
  const { db } = p;
  const retry = p.retry ?? DEFAULT_RETRY;
  const stuckBefore = new Date(Date.now() - STUCK_AFTER_MS);
  const [item] = await db
    .update(reconciliationItems)
    .set({ recoveryState: 'executing', updatedAt: new Date() })
    .where(
      and(
        eq(reconciliationItems.id, p.itemId),
        or(
          eq(reconciliationItems.recoveryState, 'requested'),
          and(
            eq(reconciliationItems.recoveryState, 'executing'),
            lt(reconciliationItems.updatedAt, stuckBefore),
          ),
        ),
      ),
    )
    .returning();
  if (!item || !item.deliveryId) return { done: false, reason: 'not claimable' };
  const deliveryId = item.deliveryId;
  let [delivery] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
  if (!delivery) return { done: false, reason: 'delivery missing' };

  if (delivery.outcome !== 'delivered') {
    // 1. Destination re-check (also on retries: a lost response may hide a completed write).
    let dest: DestinationRecord[];
    try {
      dest = await readDestination(
        p.clients.netsuite,
        [
          {
            sourceId: item.sourceOrderId,
            legacyId: item.sourceLegacyId,
            name: item.orderName,
            updatedAt: '',
            cancelledAt: null,
            lines: [],
          },
        ],
        retry,
      );
    } catch (err) {
      await setItem(db, item.id, {
        recoveryState: 'requested',
        reason: `Destination re-check failed: ${describeError(err).message}`,
      });
      return { done: false, reason: 'destination re-check failed', retryLater: true };
    }
    const matches = dest.filter(
      (d) => d.externalId === EXTERNAL_ID(item.sourceLegacyId) || d.otherRefNum === item.orderName,
    );
    const ours = matches.filter(
      (m) => m.externalId === EXTERNAL_ID(item.sourceLegacyId) && m.otherRefNum === item.orderName,
    );
    if (matches.length === 1 && ours.length === 1) {
      // NetSuite already holds exactly this order under our externalId: record the truth, do not execute.
      await db
        .update(deliveries)
        .set({
          outcome: 'delivered',
          destinationId: ours[0]!.id,
          deliveredAt: new Date(),
          lastError: null,
          lastErrorClass: null,
          updatedAt: new Date(),
        })
        .where(eq(deliveries.id, deliveryId));
      await setItem(db, item.id, {
        reason: `NetSuite already contained sales order ${ours[0]!.id} at recovery time; not executed`,
        destinationIds: [ours[0]!.id],
      });
    } else if (matches.length) {
      await db
        .update(deliveries)
        .set({
          outcome: 'skipped',
          lastError: 'Ambiguous NetSuite match at recovery time',
          updatedAt: new Date(),
        })
        .where(eq(deliveries.id, deliveryId));
      await setItem(db, item.id, {
        recoveryState: 'skipped',
        classification: 'ambiguous',
        reason: `NetSuite has ${matches.length} matching sales order(s) (${matches.map((m) => m.id).join(', ')}); review required, not executed`,
        destinationIds: matches.map((m) => m.id),
      });
      return { done: true, state: 'skipped', detail: 'ambiguous destination' };
    }
  }
  [delivery] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
  if (delivery!.outcome !== 'delivered' && !delivery!.receiptId) {
    // 2. Source re-read and eligibility re-check, then the execution input.
    let order: RecoveryOrder | null;
    try {
      const r = await withRetry(
        () => p.clients.shopify.graphql(RECOVERY_ORDER_QUERY, { id: item.sourceOrderId }),
        retry,
      );
      order = (r.data as { order?: RecoveryOrder | null })?.order ?? null;
    } catch (err) {
      await setItem(db, item.id, {
        recoveryState: 'requested',
        reason: `Source read failed: ${describeError(err).message}`,
      });
      return { done: false, reason: 'source read failed', retryLater: true };
    }
    const excluded = order ? exclusionReason(order) : 'Order no longer exists in Shopify';
    if (!order || excluded) {
      await db
        .update(deliveries)
        .set({ outcome: 'skipped', lastError: excluded, updatedAt: new Date() })
        .where(eq(deliveries.id, deliveryId));
      await setItem(db, item.id, { recoveryState: 'skipped', classification: 'excluded', reason: excluded });
      return { done: true, state: 'skipped', detail: excluded ?? 'excluded' };
    }
    const raw = Buffer.from(JSON.stringify(toUpstreamOrderInput(order)));
    const receiptId = crypto.randomUUID();
    await db.transaction(async (tx) => {
      await tx
        .insert(webhookReceipts)
        .values({
          id: receiptId,
          tenantId: item.tenantId,
          integrationId: item.integrationId,
          providerWebhookId: `reconciliation:${item.id}`,
          topic: 'orders/create',
          shopDomain: 'reconstructed',
          payloadCiphertext: p.cipher.encrypt(raw.toString('base64'), `receipt:${receiptId}`),
          payloadSha256: sha256Hex(raw),
          disposition: 'recovery_input',
          origin: 'reconciliation',
          deliveryId,
        })
        .onConflictDoNothing();
      // A real webhook that arrived meanwhile keeps precedence (its receipt is attached first).
      await tx
        .update(deliveries)
        .set({ receiptId, updatedAt: new Date() })
        .where(and(eq(deliveries.id, deliveryId), sql`${deliveries.receiptId} IS NULL`));
    });
  }

  // 3. Execute through the adopted code (no-op if a concurrent path already claimed or delivered it).
  [delivery] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
  let execution: ExecuteResult | undefined;
  if (delivery!.outcome !== 'delivered') {
    execution = await executeDelivery({
      db,
      cipher: p.cipher,
      endpoints: p.endpoints,
      deliveryId,
      trigger: {
        kind: 'reconciliation_recovery',
        principalId: item.recoveryRequestedBy ?? undefined,
        appportRequestId: item.recoveryRequestId ?? undefined,
        reason: item.recoveryReason ?? undefined,
      },
    });
    if (!execution.executed) {
      [delivery] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
      if (delivery!.outcome !== 'delivered') {
        await setItem(db, item.id, { recoveryState: 'requested' });
        return { done: false, reason: `delivery is ${delivery!.outcome} on another path`, retryLater: true };
      }
    } else if (execution.outcome !== 'delivered') {
      await setItem(db, item.id, {
        recoveryState: 'failed',
        reason: `${execution.outcome}: ${execution.message ?? ''}`.trim(),
      });
      return { done: true, state: 'failed', detail: execution.message ?? execution.outcome, execution };
    }
  }

  // 4. Verify actual destination state (an executor success is not proof).
  [delivery] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
  const v = await verifyDestination(
    p.clients.netsuite,
    item.sourceLegacyId,
    item.orderName,
    delivery!.destinationId,
  );
  await setItem(db, item.id, {
    recoveryState: v.verified ? 'recovered' : 'unverified',
    verifiedDestinationId: v.verified ? v.destinationId : null,
    verifiedAt: v.verified ? new Date() : null,
    verification: v,
    reason: v.verified
      ? `Recovered as NetSuite sales order ${v.destinationId}`
      : `Executed but not verified: ${v.detail}`,
  });
  return {
    done: true,
    state: v.verified ? 'recovered' : 'unverified',
    detail: v.detail,
    ...(execution ? { execution } : {}),
  };
}

export async function verifyDestination(
  netsuite: NetSuiteClient,
  legacyId: string,
  orderName: string,
  expectedId: string | null,
): Promise<{ verified: boolean; destinationId: string | null; detail: string; checkedAt: string }> {
  const checkedAt = new Date().toISOString();
  try {
    const rec = (await netsuite.getSalesOrderByExternalId(EXTERNAL_ID(legacyId))) as {
      id?: string;
      otherRefNum?: string;
      externalId?: string;
    } | null;
    if (!rec)
      return {
        verified: false,
        destinationId: null,
        detail: `No NetSuite sales order with externalId ${EXTERNAL_ID(legacyId)}`,
        checkedAt,
      };
    const id = rec.id != null ? String(rec.id) : null;
    if (rec.otherRefNum !== orderName)
      return {
        verified: false,
        destinationId: id,
        detail: `Sales order ${id} references ${rec.otherRefNum}, expected ${orderName}`,
        checkedAt,
      };
    if (expectedId && id !== expectedId)
      return {
        verified: false,
        destinationId: id,
        detail: `Found sales order ${id}, executor reported ${expectedId}`,
        checkedAt,
      };
    return {
      verified: true,
      destinationId: id,
      detail: `Sales order ${id} with externalId ${EXTERNAL_ID(legacyId)} and reference ${orderName}`,
      checkedAt,
    };
  } catch (err) {
    return {
      verified: false,
      destinationId: null,
      detail: `Verification read failed: ${describeError(err).message}`,
      checkedAt,
    };
  }
}

/** Runs and recovery items left behind by a dead worker (for the scheduler's sweep). */
export async function findOrphanedWork(db: Db) {
  const now = new Date();
  const runs = await db
    .select({ id: reconciliationRuns.id })
    .from(reconciliationRuns)
    .innerJoin(integrations, eq(integrations.id, reconciliationRuns.integrationId))
    .where(
      and(
        eq(integrations.flowType, ADOPTED_FLOW_TYPE),
        eq(reconciliationRuns.status, 'running'),
        or(sql`${reconciliationRuns.leaseExpiresAt} IS NULL`, lt(reconciliationRuns.leaseExpiresAt, now)),
      ),
    );
  const items = await db
    .select({ id: reconciliationItems.id })
    .from(reconciliationItems)
    .where(
      or(
        and(
          eq(reconciliationItems.recoveryState, 'requested'),
          lt(reconciliationItems.updatedAt, new Date(now.getTime() - 2 * 60_000)),
        ),
        and(
          eq(reconciliationItems.recoveryState, 'executing'),
          lt(reconciliationItems.updatedAt, new Date(now.getTime() - STUCK_AFTER_MS)),
        ),
      ),
    );
  return { runIds: runs.map((r) => r.id), itemIds: items.map((i) => i.id) };
}
