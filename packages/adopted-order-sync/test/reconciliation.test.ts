/**
 * SLICE 3 — reconciliation and missing-delivery recovery for the adopted executor.
 * Real PostgreSQL, real provider HTTP clients against the deterministic fixtures, upstream code
 * executing every delivery. Assertions are on NetSuite fixture state and durable rows.
 */
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deliveries,
  deliveryAttempts,
  integrations,
  reconciliationItems,
  reconciliationRuns,
  webhookReceipts,
} from '@mi/database';
import { reconcile } from '@mi/reliability';
import {
  adoptedClients,
  executeDelivery,
  executeRecovery,
  ingestShopifyWebhook,
  RECOVERY_ORDER_QUERY,
  requestRecovery,
  scanReconciliation,
  startReconciliation,
  toUpstreamOrderInput,
  type RecoveryOrder,
} from '../src/index.ts';
import { createHarness, FAST_RETRY, testCipher, type Harness } from '../../../test/support/harness.ts';
import { attachAdoptedTenant, signedWebhook } from '../../../test/support/adopted.ts';

const SECRET = 'fixture-shopify-client-secret';
let h: Harness;
let a: Awaited<ReturnType<typeof attachAdoptedTenant>>;
let clients: Awaited<ReturnType<typeof adoptedClients>>;

beforeEach(async () => {
  h = await createHarness();
  a = await attachAdoptedTenant(h);
  const [integ] = await h.dbh.db.select().from(integrations).where(eq(integrations.id, a.integrationId));
  await h.dbh.db
    .update(integrations)
    .set({
      config: {
        ...(integ!.config as object),
        reconcileFrom: '2026-11-01T00:00:00Z',
        reconcileGraceMinutes: 0,
      },
    })
    .where(eq(integrations.id, a.integrationId));
  clients = await adoptedClients(h.dbh.db, testCipher, h.endpoints, a.integrationId);
});
afterEach(() => h.close());

const db = () => h.dbh.db;
let n = 0;
/** An order in the adopted tenant's Shopify store (the source of truth). */
function shopifyOrder(over: { sku?: string | null; cancelled?: boolean; name?: string } = {}) {
  n += 1;
  const t = new Date(Date.parse('2026-11-20T10:00:00Z') + n * 60_000).toISOString();
  return a.shopify.control.upsertOrder({
    name: over.name ?? `#R${1000 + n}`,
    createdAt: t,
    updatedAt: t,
    cancelledAt: over.cancelled ? t : null,
    email: 'buyer@bluewave.test',
    lineItems: [
      { sku: over.sku === undefined ? 'SKU-RED' : over.sku, title: 'Part', quantity: 2, unitPrice: '12.50' },
    ],
  });
}
/** Delivers an order through the normal webhook path (fixture's own webhook body). */
async function deliverByWebhook(legacyId: string) {
  const body = a.shopify.control.webhookPayload(a.shopify.state.orders.get(legacyId)!);
  const w = signedWebhook(body, SECRET, a.shop);
  const r = await ingestShopifyWebhook({
    db: db(),
    cipher: testCipher,
    integrationId: a.integrationId,
    rawBody: w.raw,
    headers: w.headers,
    webhookSecret: SECRET,
  });
  return {
    ingest: r,
    exec: r.execute
      ? await executeDelivery({
          db: db(),
          cipher: testCipher,
          endpoints: h.endpoints,
          deliveryId: r.deliveryId!,
          trigger: { kind: 'webhook' },
        })
      : null,
  };
}
async function runReconciliation(o: { pageSize?: number; worker?: string } = {}) {
  const start = await startReconciliation(db(), {
    integrationId: a.integrationId,
    trigger: 'manual',
    requestedBy: 'test',
  });
  const scan = await scanReconciliation({
    db: db(),
    runId: start.runId,
    workerId: o.worker ?? 'w1',
    clients,
    retry: FAST_RETRY,
    ...(o.pageSize ? { pageSize: o.pageSize } : {}),
  });
  return { ...start, scan };
}
const item = async (runId: string, legacyId: string) =>
  (
    await db()
      .select()
      .from(reconciliationItems)
      .where(
        sql`${reconciliationItems.runId} = ${runId} AND ${reconciliationItems.sourceLegacyId} = ${legacyId}`,
      )
  )[0]!;
const recover = async (runId: string, legacyId: string, principal = 'u1', requestId = 'r1') => {
  const [d] = await requestRecovery(db(), {
    runId,
    sourceOrderIds: [`gid://shopify/Order/${legacyId}`],
    principalId: principal,
    requestId,
    reason: 'test',
  });
  return d!;
};
const execRecovery = (itemId: string) =>
  executeRecovery({
    db: db(),
    cipher: testCipher,
    endpoints: h.endpoints,
    itemId,
    clients,
    retry: FAST_RETRY,
  });
const nsByExt = (legacyId: string) =>
  [...h.netsuite.state.salesOrders.values()].filter((r) => r.externalId === `shopify-${legacyId}`);

describe('source-order execution input (the only adaptation outside upstream)', () => {
  it('reconstructs exactly the webhook fields the adopted mapping reads', async () => {
    const o = shopifyOrder();
    a.shopify.control.upsertOrder({ ...o, note: 'gift wrap' });
    const r = await clients.shopify.graphql(RECOVERY_ORDER_QUERY, {
      id: `gid://shopify/Order/${o.legacyId}`,
    });
    const ours = toUpstreamOrderInput((r.data as { order: RecoveryOrder }).order);
    const theirs = a.shopify.control.webhookPayload(a.shopify.state.orders.get(o.legacyId)!);
    const pick = (x: Record<string, unknown>) => ({
      id: x.id,
      name: x.name,
      created_at: x.created_at,
      currency: x.currency,
      note: x.note,
      email: x.email,
      customerEmail: (x.customer as { email?: string } | null)?.email,
      lines: (x.line_items as { sku: string; quantity: number; price: string }[]).map((l) => ({
        sku: l.sku,
        quantity: l.quantity,
        price: l.price,
      })),
    });
    expect(pick(ours)).toEqual(pick(theirs as Record<string, unknown>));
  });
});

describe('detection without relying on webhook receipts', () => {
  it('classifies webhook-delivered, missing, untracked-in-NetSuite, ambiguous and excluded orders against real destination state (tests 1–4, 16, 17)', async () => {
    const delivered = shopifyOrder();
    await deliverByWebhook(delivered.legacyId); // 1: normal webhook path
    const missing = shopifyOrder(); // 2/3: webhook never sent; not in NetSuite
    const untracked = shopifyOrder(); // 4: already in NetSuite, no local evidence
    h.netsuite.control.insertForeignSalesOrder({
      externalId: `shopify-${untracked.legacyId}`,
      otherRefNum: untracked.name,
    });
    const ambiguous = shopifyOrder(); // 16: a NetSuite order references it without our externalId
    h.netsuite.control.insertForeignSalesOrder({ otherRefNum: ambiguous.name });
    const cancelled = shopifyOrder({ cancelled: true }); // 17
    const noSku = shopifyOrder({ sku: null }); // 17

    const run = await runReconciliation({ pageSize: 2 });
    expect(run.scan).toMatchObject({ status: 'completed', pagesScanned: 3 });
    expect((await item(run.runId, delivered.legacyId)).classification).toBe('delivered');
    expect((await item(run.runId, missing.legacyId)).classification).toBe('missing_delivery');
    expect((await item(run.runId, untracked.legacyId)).classification).toBe('destination_exists_untracked');
    expect((await item(run.runId, ambiguous.legacyId)).classification).toBe('ambiguous');
    expect(await item(run.runId, cancelled.legacyId)).toMatchObject({
      classification: 'excluded',
      reason: 'Order is cancelled',
    });
    expect((await item(run.runId, noSku.legacyId)).classification).toBe('excluded');
    expect(
      await db().select().from(webhookReceipts).where(eq(webhookReceipts.integrationId, a.integrationId)),
    ).toHaveLength(1);

    const [r] = await db().select().from(reconciliationRuns).where(eq(reconciliationRuns.id, run.runId));
    expect(r).toMatchObject({
      status: 'completed',
      outcome: 'discrepancies',
      sourceCount: 6,
      matchedCount: 1,
      pagesScanned: 3,
    });
    expect((r!.evidence as { counts: Record<string, number> }).counts).toMatchObject({
      delivered: 1,
      missing_delivery: 1,
      destination_exists_untracked: 1,
      ambiguous: 1,
      excluded: 2,
    });

    // Ambiguous and untracked orders are never executed automatically.
    expect(await recover(run.runId, ambiguous.legacyId)).toMatchObject({ accepted: false });
    expect(await recover(run.runId, untracked.legacyId)).toMatchObject({ accepted: false });
  });

  it('pending and failed webhook deliveries are reported as such, not as missing', async () => {
    const pending = shopifyOrder();
    const body = a.shopify.control.webhookPayload(a.shopify.state.orders.get(pending.legacyId)!);
    const w = signedWebhook(body, SECRET, a.shop);
    await ingestShopifyWebhook({
      db: db(),
      cipher: testCipher,
      integrationId: a.integrationId,
      rawBody: w.raw,
      headers: w.headers,
      webhookSecret: SECRET,
    });
    const failed = shopifyOrder({ sku: 'SKU-NOPE' });
    await deliverByWebhook(failed.legacyId);
    const run = await runReconciliation();
    expect((await item(run.runId, pending.legacyId)).classification).toBe('pending_delivery');
    expect(await item(run.runId, failed.legacyId)).toMatchObject({ classification: 'failed_delivery' });
  });
});

describe('recovery through the adopted executor', () => {
  it('recovers an order that never entered the webhook path, verifies NetSuite, and the next run shows it delivered (tests 2, 3)', async () => {
    const o = shopifyOrder();
    const run = await runReconciliation();
    expect(nsByExt(o.legacyId)).toHaveLength(0);
    const d = await recover(run.runId, o.legacyId);
    expect(d).toMatchObject({ accepted: true, mode: 'new' });
    const r = await execRecovery((d as { itemId: string }).itemId);
    expect(r).toMatchObject({ done: true, state: 'recovered' });
    const rec = nsByExt(o.legacyId);
    expect(rec).toHaveLength(1);
    expect(rec[0]!.otherRefNum).toBe(o.name);
    const it1 = await item(run.runId, o.legacyId);
    expect(it1).toMatchObject({
      recoveryState: 'recovered',
      verifiedDestinationId: rec[0]!.id,
      recoveryRequestedBy: 'u1',
      recoveryRequestId: 'r1',
    });
    const [receipt] = await db()
      .select()
      .from(webhookReceipts)
      .where(eq(webhookReceipts.deliveryId, it1.deliveryId!));
    expect(receipt).toMatchObject({ origin: 'reconciliation', disposition: 'recovery_input' });
    const [att] = await db()
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.deliveryId, it1.deliveryId!));
    expect(att!.evidence).toMatchObject({
      trigger: { kind: 'reconciliation_recovery' },
      upstreamResult: { status: 'created' },
    });

    const again = await runReconciliation();
    expect((await item(again.runId, o.legacyId)).classification).toBe('delivered');
    expect(await recover(run.runId, o.legacyId)).toMatchObject({ accepted: false }); // duplicate recovery refused (test 11 of demo)
  });

  it('an unknown SKU found by reconciliation fails recovery with the upstream message (test 5)', async () => {
    const o = shopifyOrder({ sku: 'SKU-MISSING-IN-NETSUITE' });
    const run = await runReconciliation();
    const d = await recover(run.runId, o.legacyId);
    const r = await execRecovery((d as { itemId: string }).itemId);
    expect(r).toMatchObject({ done: true, state: 'failed' });
    expect((await item(run.runId, o.legacyId)).reason).toContain(
      'Items not found in NetSuite: SKU-MISSING-IN-NETSUITE',
    );
    expect(nsByExt(o.legacyId)).toHaveLength(0);
  });

  it('a transient NetSuite failure during recovery is recorded, and a retry after the outage recovers it (tests 6, 7)', async () => {
    const o = shopifyOrder();
    const run = await runReconciliation();
    h.netsuite.state.faults.add({ target: 'record.put', type: 'http503', count: 4 });
    const d = (await recover(run.runId, o.legacyId)) as { itemId: string };
    expect(await execRecovery(d.itemId)).toMatchObject({ done: true, state: 'failed' });
    expect(await recover(run.runId, o.legacyId)).toMatchObject({ accepted: true, mode: 'retry' });
    expect(await execRecovery(d.itemId)).toMatchObject({ done: true, state: 'recovered' });
    expect(nsByExt(o.legacyId)).toHaveLength(1);
    const attempts = await db()
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.deliveryId, (await item(run.runId, o.legacyId)).deliveryId!));
    expect(attempts.map((x) => x.outcome).sort()).toEqual(['delivered', 'failed']);
  });

  it('a recovery that executes but cannot be verified is reported as unverified, not recovered (test 18)', async () => {
    const o = shopifyOrder();
    const run = await runReconciliation();
    const d = (await recover(run.runId, o.legacyId)) as { itemId: string };
    h.netsuite.state.faults.add({ target: 'record.get', type: 'http500', count: 20 });
    const r = await execRecovery(d.itemId);
    expect(r).toMatchObject({ done: true, state: 'unverified' });
    const it1 = await item(run.runId, o.legacyId);
    expect(it1.verifiedDestinationId).toBeNull();
    expect((it1.verification as { detail: string }).detail).toMatch(/Verification read failed/);
  });

  it('state change: NetSuite gains this order (our externalId) after discovery → recorded as delivered, nothing written', async () => {
    const o = shopifyOrder();
    const run = await runReconciliation();
    const d = (await recover(run.runId, o.legacyId)) as { itemId: string; deliveryId: string };
    const existing = h.netsuite.control.insertForeignSalesOrder({
      externalId: `shopify-${o.legacyId}`,
      otherRefNum: o.name,
    });
    const writesBefore = h.netsuite.state.requestLog.filter(
      (l) => l.kind === 'create' || l.kind === 'update',
    ).length;
    expect(await execRecovery(d.itemId)).toMatchObject({ done: true, state: 'recovered' });
    expect(h.netsuite.state.requestLog.filter((l) => l.kind === 'create' || l.kind === 'update').length).toBe(
      writesBefore,
    );
    const [del] = await db().select().from(deliveries).where(eq(deliveries.id, d.deliveryId));
    expect(del).toMatchObject({ outcome: 'delivered', destinationId: existing.id, attempts: 0 });
    expect((await item(run.runId, o.legacyId)).verifiedDestinationId).toBe(existing.id);
  });

  it('state change: a foreign NetSuite order referencing it appears after discovery → review, nothing written', async () => {
    const o = shopifyOrder();
    const run = await runReconciliation();
    const d = (await recover(run.runId, o.legacyId)) as { itemId: string };
    h.netsuite.control.insertForeignSalesOrder({ otherRefNum: o.name });
    expect(await execRecovery(d.itemId)).toMatchObject({ done: true, state: 'skipped' });
    expect((await item(run.runId, o.legacyId)).classification).toBe('ambiguous');
    expect(nsByExt(o.legacyId)).toHaveLength(0);
    expect([...h.netsuite.state.salesOrders.values()].filter((r) => r.otherRefNum === o.name)).toHaveLength(
      1,
    );
  });

  it('state change between discovery and execution: an order cancelled after discovery is not executed', async () => {
    const o = shopifyOrder();
    const run = await runReconciliation();
    const d = (await recover(run.runId, o.legacyId)) as { itemId: string };
    a.shopify.control.upsertOrder({
      ...a.shopify.state.orders.get(o.legacyId)!,
      cancelledAt: new Date().toISOString(),
    });
    expect(await execRecovery(d.itemId)).toMatchObject({ done: true, state: 'skipped' });
    expect(nsByExt(o.legacyId)).toHaveLength(0);
  });
});

describe('idempotency and concurrency', () => {
  it('duplicate reconciliation requests and concurrent scans yield one run and one scanner (test 8)', async () => {
    shopifyOrder();
    const [s1, s2] = await Promise.all([
      startReconciliation(db(), { integrationId: a.integrationId, trigger: 'manual' }),
      startReconciliation(db(), { integrationId: a.integrationId, trigger: 'manual' }),
    ]);
    expect(s1.runId).toBe(s2.runId);
    expect([s1.deduplicated, s2.deduplicated].sort()).toEqual([false, true]);
    const [x, y] = await Promise.all([
      scanReconciliation({ db: db(), runId: s1.runId, workerId: 'w1', clients, retry: FAST_RETRY }),
      scanReconciliation({ db: db(), runId: s1.runId, workerId: 'w2', clients, retry: FAST_RETRY }),
    ]);
    expect([x.status, y.status].sort()).toEqual(['completed', 'skipped']);
    expect(
      await db().select().from(reconciliationItems).where(eq(reconciliationItems.runId, s1.runId)),
    ).toHaveLength(1);
  });

  it('webhook arriving concurrently with recovery produces one NetSuite order and one execution (test 9)', async () => {
    const o = shopifyOrder();
    const run = await runReconciliation();
    const d = (await recover(run.runId, o.legacyId)) as { itemId: string; deliveryId: string };
    const late = await deliverByWebhook(o.legacyId); // the webhook finally arrives while recovery is queued
    expect(late.ingest).toMatchObject({ disposition: 'joined_recovery', execute: false });
    expect(await execRecovery(d.itemId)).toMatchObject({ done: true, state: 'recovered' });
    expect(nsByExt(o.legacyId)).toHaveLength(1);
    const [del] = await db().select().from(deliveries).where(eq(deliveries.id, d.deliveryId));
    expect(del!.attempts).toBe(1);
    const [receipt] = await db()
      .select()
      .from(webhookReceipts)
      .where(eq(webhookReceipts.id, del!.receiptId!));
    expect(receipt!.origin).toBe('webhook'); // the real webhook payload took precedence
  });

  it('recovery requested after the webhook already delivered is refused (test 9, other order)', async () => {
    const o = shopifyOrder();
    const run = await runReconciliation();
    await deliverByWebhook(o.legacyId);
    expect(await recover(run.runId, o.legacyId)).toMatchObject({ accepted: false });
    expect(nsByExt(o.legacyId)).toHaveLength(1);
  });

  it('concurrent recovery requests and executions run the order once (test 10)', async () => {
    const o = shopifyOrder();
    const run = await runReconciliation();
    const [r1, r2] = await Promise.all([
      recover(run.runId, o.legacyId, 'u1', 'a'),
      recover(run.runId, o.legacyId, 'u2', 'b'),
    ]);
    expect([r1.accepted, r2.accepted].sort()).toEqual([false, true]);
    const itemId = (r1.accepted ? r1 : r2) as { itemId: string };
    const [e1, e2] = await Promise.all([execRecovery(itemId.itemId), execRecovery(itemId.itemId)]);
    expect([e1.done, e2.done].sort()).toEqual([false, true]);
    expect(nsByExt(o.legacyId)).toHaveLength(1);
  });
});

describe('crash safety of the scan', () => {
  it('a worker dying mid-scan leaves a resumable run; another worker resumes from the cursor without duplicates (tests 11, 12)', async () => {
    const orders = Array.from({ length: 5 }, () => shopifyOrder());
    const start = await startReconciliation(db(), { integrationId: a.integrationId, trigger: 'manual' });
    await expect(
      scanReconciliation({
        db: db(),
        runId: start.runId,
        workerId: 'dying',
        clients,
        retry: FAST_RETRY,
        pageSize: 2,
        afterPage: (p) => {
          if (p === 1) throw new Error('SIGKILL');
        },
      }),
    ).rejects.toThrow('SIGKILL');
    const [mid] = await db().select().from(reconciliationRuns).where(eq(reconciliationRuns.id, start.runId));
    expect(mid).toMatchObject({ status: 'running', pagesScanned: 1 });
    expect(mid!.cursor).not.toBeNull();
    // the lease of the dead worker still blocks others until it expires
    expect(
      (
        await scanReconciliation({
          db: db(),
          runId: start.runId,
          workerId: 'w2',
          clients,
          retry: FAST_RETRY,
          pageSize: 2,
        })
      ).status,
    ).toBe('skipped');
    await db()
      .update(reconciliationRuns)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(reconciliationRuns.id, start.runId));
    const resumed = await scanReconciliation({
      db: db(),
      runId: start.runId,
      workerId: 'w2',
      clients,
      retry: FAST_RETRY,
      pageSize: 2,
    });
    expect(resumed).toMatchObject({ status: 'completed', pagesScanned: 3 });
    const items = await db()
      .select()
      .from(reconciliationItems)
      .where(eq(reconciliationItems.runId, start.runId));
    expect(items.map((i) => i.sourceLegacyId).sort()).toEqual(orders.map((o) => o.legacyId).sort());
    const [done] = await db().select().from(reconciliationRuns).where(eq(reconciliationRuns.id, start.runId));
    expect(JSON.stringify(done!.evidence)).toContain('"event":"resumed"');
  });

  it('a Shopify failure midway fails the run as partial with the cursor kept; a new run completes (test 13)', async () => {
    Array.from({ length: 4 }, () => shopifyOrder());
    const start = await startReconciliation(db(), { integrationId: a.integrationId, trigger: 'manual' });
    let calls = 0;
    const orig = a.shopify.state.faults.take.bind(a.shopify.state.faults);
    a.shopify.state.faults.take = (t: string) =>
      t === 'graphql' && ++calls >= 2 ? { target: 'graphql', type: 'http500', count: 0 } : orig(t);
    const r = await scanReconciliation({
      db: db(),
      runId: start.runId,
      workerId: 'w1',
      clients,
      retry: FAST_RETRY,
      pageSize: 2,
    });
    expect(r).toMatchObject({ status: 'failed', pagesScanned: 1 });
    const [run] = await db().select().from(reconciliationRuns).where(eq(reconciliationRuns.id, start.runId));
    expect(run).toMatchObject({ status: 'failed', outcome: 'partial' });
    expect(run!.errorMessage).toMatch(/Source scan failed after page 1/);
    a.shopify.state.faults.take = orig;
    const next = await runReconciliation({ pageSize: 2 });
    expect(next.scan.status).toBe('completed');
    expect(next.runId).not.toBe(start.runId);
  });

  it('a NetSuite lookup failure marks orders undetermined and the run partial, never missing (test 13, destination side)', async () => {
    const o = shopifyOrder();
    h.netsuite.state.faults.add({ target: 'suiteql', type: 'http500', count: 50 });
    const run = await runReconciliation();
    expect((await item(run.runId, o.legacyId)).classification).toBe('undetermined');
    expect(
      (await db().select().from(reconciliationRuns).where(eq(reconciliationRuns.id, run.runId)))[0]!.outcome,
    ).toBe('partial');
    expect(await recover(run.runId, o.legacyId)).toMatchObject({ accepted: false });
  });
});

describe('boundaries', () => {
  it('the native reconciliation refuses to run against an adopted integration', async () => {
    await expect(
      reconcile({
        db: db(),
        shopify: clients.shopify,
        netsuite: clients.netsuite,
        integrationId: a.integrationId,
        trigger: 'manual',
      }),
    ).rejects.toThrow(/does not apply/);
  });
  it('the adopted reconciliation refuses the native integration', async () => {
    await expect(
      startReconciliation(db(), { integrationId: h.integrationId, trigger: 'manual' }),
    ).rejects.toThrow(/only to adopted/);
  });
});
