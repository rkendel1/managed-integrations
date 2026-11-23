/**
 * Independent reconciliation. Compares three sides for a time window:
 *   source (Shopify, via a minimal identity query that does not use the versioned implementation),
 *   durable delivery evidence (deliveries table),
 *   destination (NetSuite, via SuiteQL by externalId and order reference).
 *
 * Classification per expected order: matched | missing | duplicate | inconsistent | stale | unresolved,
 * plus `unexpected` for delivered records the source no longer shows in the window.
 * If any side cannot be read completely the outcome is `partial` or `unknown`, never `consistent`.
 */
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { IntegrationConfigSchema, ProviderError, type ReconciliationOutcome } from '@mi/contracts';
import { deliveries, integrations, reconciliationRuns, type Db } from '@mi/database';
import { describeError, redact } from '@mi/observability';
import {
  DEFAULT_RETRY,
  withRetry,
  type NetSuiteClient,
  type RetryPolicy,
  type ShopifyClient,
} from '@mi/integration-shopify-netsuite';

export const EXTERNAL_ID_PREFIX = 'shopify-';

/** Stable identity query: only fields required to establish completeness and line quantities. */
export const RECON_SOURCE_QUERY = /* GraphQL */ `
  query ReconOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      nodes {
        id
        legacyResourceId
        name
        updatedAt
        cancelledAt
        lineItems(first: 100) {
          nodes {
            sku
            quantity
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const SUITEQL_RECON =
  "SELECT t.id, t.externalid, t.otherrefnum, t.trandate FROM transaction t WHERE t.type = 'SalesOrd' AND (t.externalid IN (__EXT__) OR t.otherrefnum IN (__REF__)) ORDER BY t.id";
export const SUITEQL_LINES =
  "SELECT tl.transaction, tl.item, tl.quantity, tl.rate FROM transactionline tl WHERE tl.mainline = 'F' AND tl.transaction IN (__IDS__) ORDER BY tl.transaction, tl.linesequencenumber";

export interface SourceIdentity {
  sourceId: string;
  legacyId: string;
  name: string;
  updatedAt: string;
  cancelledAt: string | null;
  lines: { sku: string | null; quantity: number }[];
}

export interface DestinationRecord {
  id: string;
  externalId: string | null;
  otherRefNum: string | null;
  lines: { itemId: string; quantity: number; rateMinor: number }[];
}

export interface DeliveryEvidence {
  sourceId: string;
  sourceLegacyId: string;
  outcome: string;
  sourceUpdatedAt: Date;
  latestSourceUpdatedAt: Date;
  lastError: string | null;
  summary: {
    lineCount?: number;
    computedTotalMinor?: number;
    lines?: { itemId: string; quantity: number; rateMinor: number }[];
  };
}

export interface ReconItem {
  sourceId: string;
  legacyId: string;
  name: string;
  reason: string;
  destinationIds?: string[];
}

export interface ReconClassification {
  expected: number;
  matched: number;
  missing: ReconItem[];
  duplicates: ReconItem[];
  inconsistent: ReconItem[];
  stale: ReconItem[];
  unexpected: ReconItem[];
  unresolved: ReconItem[];
}

const minor = (v: string | number) => Math.round(Number(v) * 100);

/**
 * Pure classification — deterministic and unit-tested independently of I/O.
 */
export function classifyReconciliation(
  source: SourceIdentity[],
  evidence: Map<string, DeliveryEvidence>,
  destination: DestinationRecord[],
  skuMap: Record<string, string>,
  deliveredInWindow: DeliveryEvidence[] = [],
): ReconClassification {
  const out: ReconClassification = {
    expected: 0,
    matched: 0,
    missing: [],
    duplicates: [],
    inconsistent: [],
    stale: [],
    unexpected: [],
    unresolved: [],
  };
  const byExt = new Map<string, DestinationRecord[]>();
  const byRef = new Map<string, DestinationRecord[]>();
  for (const d of destination) {
    if (d.externalId) byExt.set(d.externalId, [...(byExt.get(d.externalId) ?? []), d]);
    if (d.otherRefNum) byRef.set(d.otherRefNum, [...(byRef.get(d.otherRefNum) ?? []), d]);
  }
  const sourceIds = new Set(source.map((s) => s.sourceId));

  for (const s of source) {
    const ev = evidence.get(s.sourceId);
    const ext = `${EXTERNAL_ID_PREFIX}${s.legacyId}`;
    const matches = new Map<string, DestinationRecord>();
    for (const d of [...(byExt.get(ext) ?? []), ...(byRef.get(s.name) ?? [])]) matches.set(d.id, d);
    const found = [...matches.values()];
    const item = (reason: string): ReconItem => ({
      sourceId: s.sourceId,
      legacyId: s.legacyId,
      name: s.name,
      reason,
      ...(found.length ? { destinationIds: found.map((f) => f.id) } : {}),
    });

    if (s.cancelledAt && ev?.outcome !== 'delivered' && found.length === 0) continue; // out of scope
    out.expected++;

    if (found.length > 1) {
      out.duplicates.push(item(`${found.length} NetSuite sales orders reference ${s.name}`));
      continue;
    }
    if (found.length === 0) {
      if (ev?.outcome === 'rejected')
        out.unresolved.push(item(`Rejected: ${ev.lastError ?? 'invalid data'}`));
      else
        out.missing.push(
          item(
            ev
              ? `Delivery outcome "${ev.outcome}" but no NetSuite record found`
              : 'No delivery evidence and no NetSuite record',
          ),
        );
      continue;
    }
    const d = found[0]!;
    if (d.externalId !== ext) {
      out.unresolved.push(
        item(
          `NetSuite order ${d.id} references ${s.name} but lacks our externalId (created outside the integration?)`,
        ),
      );
      continue;
    }
    if (!ev || ev.outcome !== 'delivered') {
      out.unresolved.push(
        item(`NetSuite record exists but delivery evidence is "${ev?.outcome ?? 'absent'}"`),
      );
      continue;
    }
    // Correctness: destination lines vs what we sent, and vs source quantities.
    const sent = ev.summary;
    const destTotal = d.lines.reduce((t, l) => t + l.quantity * l.rateMinor, 0);
    const problems: string[] = [];
    if (sent.lineCount != null && sent.lineCount !== d.lines.length)
      problems.push(`line count ${d.lines.length} ≠ delivered ${sent.lineCount}`);
    if (sent.computedTotalMinor != null && sent.computedTotalMinor !== destTotal)
      problems.push(`total ${destTotal / 100} ≠ delivered ${sent.computedTotalMinor / 100}`);
    const srcQty = new Map<string, number>();
    for (const l of s.lines) {
      const itemId = l.sku ? skuMap[l.sku] : undefined;
      if (itemId) srcQty.set(itemId, (srcQty.get(itemId) ?? 0) + l.quantity);
    }
    const dstQty = new Map<string, number>();
    for (const l of d.lines) dstQty.set(l.itemId, (dstQty.get(l.itemId) ?? 0) + l.quantity);
    for (const [itemId, q] of srcQty)
      if (dstQty.get(itemId) !== q)
        problems.push(`item ${itemId} quantity ${dstQty.get(itemId) ?? 0} ≠ source ${q}`);
    if (problems.length) {
      out.inconsistent.push(item(problems.join('; ')));
      continue;
    }
    if (Date.parse(s.updatedAt) > ev.sourceUpdatedAt.getTime()) {
      out.stale.push(
        item('Source order changed after delivery (edits are not propagated under contract 1.0.0)'),
      );
      continue;
    }
    out.matched++;
  }

  for (const ev of deliveredInWindow) {
    if (!sourceIds.has(ev.sourceId)) {
      out.unexpected.push({
        sourceId: ev.sourceId,
        legacyId: ev.sourceLegacyId,
        name: `#${ev.sourceLegacyId}`,
        reason: 'Delivered, but the source no longer returns this order in the window',
      });
    }
  }
  return out;
}

export function outcomeOf(
  c: ReconClassification,
  complete: { source: boolean; destination: boolean },
): ReconciliationOutcome {
  if (!complete.source && !complete.destination) return 'unknown';
  if (!complete.source || !complete.destination) return 'partial';
  const issues =
    c.missing.length +
    c.duplicates.length +
    c.inconsistent.length +
    c.stale.length +
    c.unexpected.length +
    c.unresolved.length;
  return issues === 0 ? 'consistent' : 'discrepancies';
}

/* ------------------------------------------- I/O ------------------------------------------- */

export async function readSourceIdentities(
  shopify: ShopifyClient,
  from: Date,
  to: Date,
  opts: { pageSize?: number; maxPages?: number; retry?: RetryPolicy } = {},
): Promise<SourceIdentity[]> {
  const out: SourceIdentity[] = [];
  let after: string | null = null;
  const query = `updated_at:>='${from.toISOString()}'`;
  for (let page = 0; page < (opts.maxPages ?? 1000); page++) {
    const r = await withRetry(
      () => shopify.graphql(RECON_SOURCE_QUERY, { first: opts.pageSize ?? 100, after, query }),
      opts.retry ?? DEFAULT_RETRY,
    );
    const conn = (
      r.data as {
        orders?: { nodes?: unknown[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } };
      }
    )?.orders;
    if (!conn?.nodes || !conn.pageInfo)
      throw new ProviderError('Unexpected reconciliation response shape', 'schema', { provider: 'shopify' });
    for (const n of conn.nodes as {
      id: string;
      legacyResourceId: string;
      name: string;
      updatedAt: string;
      cancelledAt: string | null;
      lineItems?: { nodes?: { sku: string | null; quantity: number }[] };
    }[]) {
      if (Date.parse(n.updatedAt) > to.getTime()) continue;
      out.push({
        sourceId: n.id,
        legacyId: n.legacyResourceId,
        name: n.name,
        updatedAt: n.updatedAt,
        cancelledAt: n.cancelledAt,
        lines: n.lineItems?.nodes ?? [],
      });
    }
    if (!conn.pageInfo.hasNextPage) return out;
    if (!conn.pageInfo.endCursor || conn.pageInfo.endCursor === after)
      throw new ProviderError('Reconciliation pagination did not advance', 'transient', {
        provider: 'shopify',
        code: 'PAGINATION',
      });
    after = conn.pageInfo.endCursor;
  }
  throw new ProviderError('Reconciliation page limit reached', 'permanent', { provider: 'shopify' });
}

export async function readDestination(
  netsuite: NetSuiteClient,
  source: SourceIdentity[],
  retry: RetryPolicy = DEFAULT_RETRY,
): Promise<DestinationRecord[]> {
  const records = new Map<string, DestinationRecord>();
  const CHUNK = 200;
  for (let i = 0; i < source.length; i += CHUNK) {
    const chunk = source.slice(i, i + CHUNK);
    const ext = chunk.map((s) => `${EXTERNAL_ID_PREFIX}${s.legacyId}`);
    const refs = chunk.map((s) => s.name);
    const q = SUITEQL_RECON.replace('__EXT__', ext.map(() => '?').join(', ')).replace(
      '__REF__',
      refs.map(() => '?').join(', '),
    );
    const rows = await withRetry(
      () =>
        netsuite.suiteqlAll<{ id: string; externalid: string | null; otherrefnum: string | null }>(q, [
          ...ext,
          ...refs,
        ]),
      retry,
    );
    for (const r of rows)
      records.set(String(r.id), {
        id: String(r.id),
        externalId: r.externalid,
        otherRefNum: r.otherrefnum,
        lines: [],
      });
  }
  const ids = [...records.keys()];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const q = SUITEQL_LINES.replace('__IDS__', chunk.map(() => '?').join(', '));
    const rows = await withRetry(
      () =>
        netsuite.suiteqlAll<{ transaction: string; item: string; quantity: string; rate: string }>(q, chunk),
      retry,
    );
    for (const l of rows) {
      // SuiteQL transactionline quantities on sales transactions may be stored negated; compare magnitudes.
      records
        .get(String(l.transaction))
        ?.lines.push({
          itemId: String(l.item),
          quantity: Math.abs(Number(l.quantity)),
          rateMinor: Math.abs(minor(l.rate)),
        });
    }
  }
  return [...records.values()];
}

export interface ReconcileParams {
  db: Db;
  shopify: ShopifyClient;
  netsuite: NetSuiteClient;
  integrationId: string;
  trigger: 'schedule' | 'manual' | 'incident' | 'release';
  incidentId?: string | null;
  windowFrom?: Date;
  windowTo?: Date;
  retry?: RetryPolicy;
}

export interface ReconcileResult {
  runId: string;
  outcome: ReconciliationOutcome;
  classification: ReconClassification;
  sourceComplete: boolean;
  destinationComplete: boolean;
  /** Legacy ids recoverable by redelivery (missing with no rejection). */
  recoverableLegacyIds: string[];
}

/**
 * Default window: from max(backfillFrom, now − 7d) to the durable cursor watermark — only
 * orders the sync claims to have processed are expected in the destination.
 */
export async function reconcile(p: ReconcileParams): Promise<ReconcileResult> {
  const [integration] = await p.db.select().from(integrations).where(eq(integrations.id, p.integrationId));
  if (!integration) throw new Error('integration not found');
  const config = IntegrationConfigSchema.parse(integration.config);
  const watermark = integration.cursorWatermark ? new Date(integration.cursorWatermark) : null;
  const windowTo = p.windowTo ?? watermark ?? new Date(config.backfillFrom);
  const windowFrom =
    p.windowFrom ?? new Date(Math.max(Date.parse(config.backfillFrom), Date.now() - 7 * 24 * 3600 * 1000));

  const [run] = await p.db
    .insert(reconciliationRuns)
    .values({
      integrationId: p.integrationId,
      incidentId: p.incidentId ?? null,
      trigger: p.trigger,
      windowFrom,
      windowTo,
      status: 'running',
    })
    .returning();

  let source: SourceIdentity[] = [];
  let destination: DestinationRecord[] = [];
  let sourceComplete = false;
  let destinationComplete = false;
  const errors: string[] = [];
  try {
    source = await readSourceIdentities(p.shopify, windowFrom, windowTo, {
      ...(p.retry ? { retry: p.retry } : {}),
    });
    sourceComplete = true;
  } catch (err) {
    errors.push(`source: ${describeError(err).message}`);
  }
  if (sourceComplete) {
    try {
      destination = await readDestination(p.netsuite, source, p.retry);
      destinationComplete = true;
    } catch (err) {
      errors.push(`destination: ${describeError(err).message}`);
    }
  }

  const evRows = source.length
    ? await p.db
        .select()
        .from(deliveries)
        .where(
          and(
            eq(deliveries.integrationId, p.integrationId),
            inArray(
              deliveries.sourceId,
              source.map((s) => s.sourceId),
            ),
          ),
        )
    : [];
  const evidence = new Map<string, DeliveryEvidence>(
    evRows.map((r) => [r.sourceId, r as unknown as DeliveryEvidence]),
  );
  const inWindow = sourceComplete
    ? ((await p.db
        .select()
        .from(deliveries)
        .where(
          and(
            eq(deliveries.integrationId, p.integrationId),
            eq(deliveries.outcome, 'delivered'),
            gte(deliveries.sourceUpdatedAt, windowFrom),
            lte(deliveries.sourceUpdatedAt, windowTo),
          ),
        )) as unknown as DeliveryEvidence[])
    : [];

  const classification =
    sourceComplete && destinationComplete
      ? classifyReconciliation(source, evidence, destination, config.skuMap, inWindow)
      : {
          expected: source.length,
          matched: 0,
          missing: [],
          duplicates: [],
          inconsistent: [],
          stale: [],
          unexpected: [],
          unresolved: [],
        };
  const outcome = outcomeOf(classification, { source: sourceComplete, destination: destinationComplete });
  const recoverableLegacyIds = classification.missing.map((m) => m.legacyId);

  await p.db
    .update(reconciliationRuns)
    .set({
      status: errors.length && !sourceComplete ? 'failed' : 'completed',
      outcome,
      expectedCount: classification.expected,
      sourceCount: source.length,
      destinationCount: destination.length,
      matchedCount: classification.matched,
      missing: classification.missing,
      duplicates: classification.duplicates,
      inconsistent: classification.inconsistent,
      stale: classification.stale,
      unexpected: classification.unexpected,
      unresolved: classification.unresolved,
      errorMessage: errors.length ? String(redact(errors.join(' | '))) : null,
      evidence: { sourceComplete, destinationComplete, watermark: integration.cursorWatermark },
      finishedAt: new Date(),
    })
    .where(eq(reconciliationRuns.id, run!.id));

  return {
    runId: run!.id,
    outcome,
    classification,
    sourceComplete,
    destinationComplete,
    recoverableLegacyIds,
  };
}

export async function markRecoveryEnqueued(db: Db, runId: string, count: number) {
  await db
    .update(reconciliationRuns)
    .set({ recoveryEnqueued: count })
    .where(eq(reconciliationRuns.id, runId));
}
