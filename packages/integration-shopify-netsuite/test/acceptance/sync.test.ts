/**
 * AUTHORITATIVE ACCEPTANCE SUITE — contract 1.0.0.
 * Protected: the maintenance agent may not modify files under test/acceptance/.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deliveries, deliveryAttempts, integrations, syncRuns } from '@mi/database';
import { implementation } from '../../src/implementation/index.ts';
import { createHarness, type Harness } from '../../../../test/support/harness.ts';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

const integrationRow = async () =>
  (await h.dbh.db.select().from(integrations).where(eq(integrations.id, h.integrationId)))[0]!;

describe('historical backfill and pagination', () => {
  it('delivers every in-scope order across multiple pages and records the cursor', async () => {
    const seeded = h.shopify.control.seedOrders(25, { start: new Date('2026-11-01T00:00:00Z') });
    const engine = await h.engine({ implementation });
    const r = await engine.run({ integrationId: h.integrationId, trigger: 'manual' });

    expect(r.status).toBe('succeeded');
    expect(r.mode).toBe('backfill');
    expect(r.counts.pages).toBe(3); // pageSize 10 → 10 + 10 + 5, terminates on hasNextPage=false
    expect(r.counts.delivered).toBe(25);
    expect(r.caughtUp).toBe(true);
    expect(h.netsuite.state.salesOrders.size).toBe(25);
    for (const o of seeded) {
      const rec = h.netsuite.control.findByExternalId(`shopify-${o.legacyId}`);
      expect(rec?.otherRefNum).toBe(o.name);
    }
    const row = await integrationRow();
    expect(row.cursorWatermark).toBe(seeded.at(-1)!.updatedAt);
    expect(row.backfillCompletedAt).not.toBeNull();
    expect(row.lastSuccessfulSyncAt).not.toBeNull();
    expect(row.leaseOwner).toBeNull();
  });

  it('records delivery evidence with destination ids and attempt history', async () => {
    h.shopify.control.seedOrders(3, { start: new Date('2026-11-01T00:00:00Z') });
    const r = await (
      await h.engine({ implementation })
    ).run({ integrationId: h.integrationId, trigger: 'manual' });
    const rows = await h.dbh.db
      .select()
      .from(deliveries)
      .where(eq(deliveries.integrationId, h.integrationId));
    expect(rows).toHaveLength(3);
    for (const d of rows) {
      expect(d.outcome).toBe('delivered');
      expect(d.destinationId).toMatch(/^\d+$/);
      expect((d.summary as { lineCount: number }).lineCount).toBe(1);
      const attempts = await h.dbh.db
        .select()
        .from(deliveryAttempts)
        .where(eq(deliveryAttempts.deliveryId, d.id));
      expect(attempts.map((a) => a.outcome)).toEqual(['delivered']);
      expect(attempts[0]!.syncRunId).toBe(r.syncRunId);
    }
  });

  it('does not deliver orders updated before the configured backfill start', async () => {
    h.shopify.control.seedOrders(2, { start: new Date('2025-06-01T00:00:00Z') });
    h.shopify.control.seedOrders(2, { start: new Date('2026-11-01T00:00:00Z') });
    const r = await (
      await h.engine({ implementation })
    ).run({ integrationId: h.integrationId, trigger: 'manual' });
    expect(r.counts.delivered).toBe(2);
  });
});

describe('incremental sync', () => {
  it('picks up new and changed orders after the watermark and switches to incremental mode', async () => {
    h.shopify.control.seedOrders(5, { start: new Date('2026-11-01T00:00:00Z') });
    const engine = await h.engine({ implementation });
    await engine.run({ integrationId: h.integrationId, trigger: 'manual' });
    h.shopify.control.seedOrders(3, { start: new Date('2026-11-02T00:00:00Z') });
    const r2 = await engine.run({ integrationId: h.integrationId, trigger: 'schedule' });
    expect(r2.mode).toBe('incremental');
    expect(r2.counts.delivered).toBe(3);
    expect(h.netsuite.state.salesOrders.size).toBe(8);
  });

  it('detects edits after delivery without propagating them (contract 1.0.0)', async () => {
    const [o] = h.shopify.control.seedOrders(1, { start: new Date('2026-11-01T00:00:00Z') });
    const engine = await h.engine({ implementation });
    await engine.run({ integrationId: h.integrationId, trigger: 'manual' });
    h.shopify.control.upsertOrder({
      ...o!,
      updatedAt: '2026-11-03T00:00:00.000Z',
      lineItems: [{ sku: 'SKU-RED', title: 'Widget', quantity: 9, unitPrice: '19.99' }],
    });
    const r2 = await engine.run({ integrationId: h.integrationId, trigger: 'schedule' });
    expect(r2.counts.delivered).toBe(0);
    expect(r2.counts.alreadyDelivered).toBe(1);
    const [d] = await h.dbh.db.select().from(deliveries);
    expect(d!.latestSourceUpdatedAt.getTime()).toBeGreaterThan(d!.sourceUpdatedAt.getTime());
  });
});

describe('idempotency', () => {
  it('re-running never duplicates destination records', async () => {
    h.shopify.control.seedOrders(12, { start: new Date('2026-11-01T00:00:00Z') });
    const engine = await h.engine({ implementation });
    await engine.run({ integrationId: h.integrationId, trigger: 'manual' });
    await h.dbh.db
      .update(integrations)
      .set({ cursorWatermark: null, backfillCompletedAt: null })
      .where(eq(integrations.id, h.integrationId));
    const r2 = await engine.run({ integrationId: h.integrationId, trigger: 'manual' });
    expect(r2.counts.delivered).toBe(0);
    expect(r2.counts.alreadyDelivered).toBe(12);
    expect(h.netsuite.state.salesOrders.size).toBe(12);
  });

  it('a crash after the destination write but before recording is safe (upsert by externalId)', async () => {
    h.shopify.control.seedOrders(4, { start: new Date('2026-11-01T00:00:00Z') });
    const engine = await h.engine({ implementation });
    await engine.run({ integrationId: h.integrationId, trigger: 'manual' });
    // Simulate lost local evidence: destination records exist, delivery rows do not.
    await h.dbh.db.delete(deliveryAttempts);
    await h.dbh.db.delete(deliveries);
    await h.dbh.db
      .update(integrations)
      .set({ cursorWatermark: null, backfillCompletedAt: null })
      .where(eq(integrations.id, h.integrationId));
    const r2 = await engine.run({ integrationId: h.integrationId, trigger: 'manual' });
    expect(r2.counts.delivered).toBe(4);
    expect(h.netsuite.state.salesOrders.size).toBe(4); // updated in place, not duplicated
  });

  it('only one runner can hold the integration lease', async () => {
    h.shopify.control.seedOrders(3, { start: new Date('2026-11-01T00:00:00Z') });
    const a = await h.engine({ implementation, workerId: 'worker-a' });
    const b = await h.engine({ implementation, workerId: 'worker-b' });
    await a.acquireLease(h.integrationId);
    const rb = await b.run({ integrationId: h.integrationId, trigger: 'schedule' });
    expect(rb.status).toBe('skipped');
    expect(rb.reason).toBe('lease_held');
    await a.releaseLease(h.integrationId);
    expect((await b.run({ integrationId: h.integrationId, trigger: 'schedule' })).status).toBe('succeeded');
  });
});

describe('record-level outcomes', () => {
  it('rejects invalid records, delivers the rest, and reports partial', async () => {
    h.shopify.control.seedOrders(3, { start: new Date('2026-11-01T00:00:00Z') });
    h.shopify.control.upsertOrder({
      createdAt: '2026-11-01T01:00:00Z',
      updatedAt: '2026-11-01T01:00:00Z',
      lineItems: [{ sku: 'SKU-UNMAPPED', title: 'Mystery', quantity: 1, unitPrice: '5.00' }],
    });
    const r = await (
      await h.engine({ implementation })
    ).run({ integrationId: h.integrationId, trigger: 'manual' });
    expect(r.status).toBe('partial');
    expect(r.counts.delivered).toBe(3);
    expect(r.counts.rejected).toBe(1);
    const rejected = (await h.dbh.db.select().from(deliveries).where(eq(deliveries.outcome, 'rejected')))[0]!;
    expect(rejected.lastError).toContain('SKU-UNMAPPED');
    expect((await integrationRow()).backfillCompletedAt).not.toBeNull();
  });

  it('skips orders cancelled before delivery', async () => {
    h.shopify.control.upsertOrder({
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
      cancelledAt: '2026-11-01T00:00:00Z',
      lineItems: [{ sku: 'SKU-RED', title: 'W', quantity: 1, unitPrice: '1.00' }],
    });
    const r = await (
      await h.engine({ implementation })
    ).run({ integrationId: h.integrationId, trigger: 'manual' });
    expect(r.counts.skipped).toBe(1);
    expect(h.netsuite.state.salesOrders.size).toBe(0);
  });

  it('records a destination rejection (mandatory NetSuite field) as invalid data, not a crash', async () => {
    h.shopify.control.seedOrders(2, { start: new Date('2026-11-01T00:00:00Z') });
    h.netsuite.control.setMandatoryBodyFields(['custbody_sales_channel']);
    const r = await (
      await h.engine({ implementation })
    ).run({ integrationId: h.integrationId, trigger: 'manual' });
    expect(r.status).toBe('partial');
    expect(r.counts.rejected).toBe(2);
    const rows = await h.dbh.db.select().from(deliveries);
    expect(rows.every((d) => d.lastErrorClass === 'invalid_data')).toBe(true);
  });

  it('re-attempts rejected records after the configuration is corrected', async () => {
    h.shopify.control.upsertOrder({
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
      lineItems: [{ sku: 'SKU-NEW', title: 'New', quantity: 1, unitPrice: '5.00' }],
    });
    const engine = await h.engine({ implementation });
    expect((await engine.run({ integrationId: h.integrationId, trigger: 'manual' })).counts.rejected).toBe(1);
    const row = await integrationRow();
    const cfg = row.config as { skuMap: Record<string, string> };
    await h.dbh.db
      .update(integrations)
      .set({ config: { ...cfg, skuMap: { ...cfg.skuMap, 'SKU-NEW': '103' } } })
      .where(eq(integrations.id, h.integrationId));
    const order = [...h.shopify.state.orders.values()][0]!;
    const r = await (
      await h.engine({ implementation })
    ).run({
      integrationId: h.integrationId,
      trigger: 'recovery',
      mode: 'redelivery',
      sourceLegacyIds: [order.legacyId],
    });
    expect(r.counts.delivered).toBe(1);
  });
});

describe('sync run history', () => {
  it('persists counts, cursor before/after and status for every run', async () => {
    h.shopify.control.seedOrders(5, { start: new Date('2026-11-01T00:00:00Z') });
    const r = await (
      await h.engine({ implementation })
    ).run({ integrationId: h.integrationId, trigger: 'manual' });
    const [run] = await h.dbh.db.select().from(syncRuns).where(eq(syncRuns.id, r.syncRunId!));
    expect(run).toMatchObject({
      status: 'succeeded',
      deliveredCount: 5,
      observedCount: 5,
      pagesFetched: 1,
      cursorBefore: '2026-01-01T00:00:00Z',
    });
    expect(run!.cursorAfter).toBe(r.cursorAfter);
    expect(run!.finishedAt).not.toBeNull();
  });
});
