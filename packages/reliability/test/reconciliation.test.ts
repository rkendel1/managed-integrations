import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deliveries, integrations, reconciliationRuns } from '@mi/database';
import {
  classifyReconciliation,
  outcomeOf,
  reconcile,
  type DeliveryEvidence,
  type SourceIdentity,
} from '../src/reconciliation.ts';
import { createHarness, FAST_RETRY, type Harness } from '../../../test/support/harness.ts';

const src = (legacyId: string, over: Partial<SourceIdentity> = {}): SourceIdentity => ({
  sourceId: `gid://shopify/Order/${legacyId}`,
  legacyId,
  name: `#${legacyId}`,
  updatedAt: '2026-11-01T00:00:00Z',
  cancelledAt: null,
  lines: [{ sku: 'A', quantity: 2 }],
  ...over,
});
const ev = (legacyId: string, over: Partial<DeliveryEvidence> = {}): DeliveryEvidence => ({
  sourceId: `gid://shopify/Order/${legacyId}`,
  sourceLegacyId: legacyId,
  outcome: 'delivered',
  sourceUpdatedAt: new Date('2026-11-01T00:00:00Z'),
  latestSourceUpdatedAt: new Date('2026-11-01T00:00:00Z'),
  lastError: null,
  summary: { lineCount: 1, computedTotalMinor: 1000, lines: [{ itemId: '1', quantity: 2, rateMinor: 500 }] },
  ...over,
});
const dst = (
  id: string,
  legacyId: string,
  over: Partial<{
    externalId: string | null;
    otherRefNum: string | null;
    lines: { itemId: string; quantity: number; rateMinor: number }[];
  }> = {},
) => ({
  id,
  externalId: `shopify-${legacyId}`,
  otherRefNum: `#${legacyId}`,
  lines: [{ itemId: '1', quantity: 2, rateMinor: 500 }],
  ...over,
});
const map = { A: '1' };

describe('classifyReconciliation (pure)', () => {
  it('classifies matched, missing, duplicate, inconsistent, stale, unresolved and unexpected', () => {
    const source = [
      src('1'), // matched
      src('2'), // missing (no evidence)
      src('3'), // duplicate
      src('4'), // inconsistent quantity
      src('5', { updatedAt: '2026-11-02T00:00:00Z' }), // stale
      src('6'), // rejected → unresolved
      src('7'), // record without our externalId → unresolved
      src('8', { cancelledAt: '2026-11-01T00:00:00Z' }), // cancelled & never delivered → out of scope
    ];
    const evidence = new Map(
      [
        ev('1'),
        ev('3'),
        ev('4'),
        ev('5'),
        ev('6', { outcome: 'rejected', lastError: 'SKU X is not mapped' }),
      ].map((e) => [e.sourceId, e]),
    );
    const destination = [
      dst('101', '1'),
      dst('103', '3'),
      dst('203', '3', { externalId: null }),
      dst('104', '4', { lines: [{ itemId: '1', quantity: 3, rateMinor: 500 }] }),
      dst('105', '5'),
      dst('107', '7', { externalId: null }),
    ];
    const unexpectedEv = ev('99');
    const c = classifyReconciliation(source, evidence, destination, map, [unexpectedEv]);
    expect(c.expected).toBe(7);
    expect(c.matched).toBe(1);
    expect(c.missing.map((m) => m.legacyId)).toEqual(['2']);
    expect(c.duplicates.map((m) => m.legacyId)).toEqual(['3']);
    expect(c.inconsistent.map((m) => m.legacyId)).toEqual(['4']);
    expect(c.stale.map((m) => m.legacyId)).toEqual(['5']);
    expect(c.unresolved.map((m) => m.legacyId).sort()).toEqual(['6', '7']);
    expect(c.unexpected.map((m) => m.legacyId)).toEqual(['99']);
    expect(outcomeOf(c, { source: true, destination: true })).toBe('discrepancies');
  });

  it('never reports consistent when a side could not be read', () => {
    const empty = classifyReconciliation([], new Map(), [], map);
    expect(outcomeOf(empty, { source: true, destination: true })).toBe('consistent');
    expect(outcomeOf(empty, { source: true, destination: false })).toBe('partial');
    expect(outcomeOf(empty, { source: false, destination: false })).toBe('unknown');
  });
});

describe('reconcile (against fixtures)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    h.shopify.control.seedOrders(8, { start: new Date('2026-11-20T00:00:00Z') });
    await (await h.engine()).run({ integrationId: h.integrationId, trigger: 'manual' });
  });
  afterEach(() => h.close());

  const run = async () => {
    const c = await h.clients();
    return reconcile({
      db: h.dbh.db,
      shopify: c.shopify,
      netsuite: c.netsuite,
      integrationId: h.integrationId,
      trigger: 'manual',
      windowFrom: new Date('2026-11-19T00:00:00Z'),
      retry: FAST_RETRY,
    });
  };

  it('is consistent after a clean sync and persists the run', async () => {
    const r = await run();
    expect(r.outcome).toBe('consistent');
    expect(r.classification.expected).toBe(8);
    expect(r.classification.matched).toBe(8);
    const [row] = await h.dbh.db.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, r.runId));
    expect(row).toMatchObject({ status: 'completed', outcome: 'consistent', matchedCount: 8 });
  });

  it('detects a record deleted from NetSuite as missing and marks it recoverable', async () => {
    const victim = [...h.shopify.state.orders.values()][2]!;
    h.netsuite.control.deleteByExternalId(`shopify-${victim.legacyId}`);
    const r = await run();
    expect(r.outcome).toBe('discrepancies');
    expect(r.recoverableLegacyIds).toEqual([victim.legacyId]);
  });

  it('detects a duplicate created outside the integration', async () => {
    const victim = [...h.shopify.state.orders.values()][0]!;
    h.netsuite.control.insertForeignSalesOrder({ otherRefNum: victim.name });
    const r = await run();
    expect(r.classification.duplicates.map((d) => d.legacyId)).toEqual([victim.legacyId]);
  });

  it('detects a destination record edited to differ from what was delivered', async () => {
    const victim = [...h.shopify.state.orders.values()][1]!;
    const rec = h.netsuite.control.findByExternalId(`shopify-${victim.legacyId}`)!;
    rec.item.items[0]!.quantity += 5;
    const r = await run();
    expect(r.classification.inconsistent.map((d) => d.legacyId)).toEqual([victim.legacyId]);
  });

  it('reports partial (not consistent) when NetSuite cannot be read', async () => {
    h.netsuite.state.faults.add({ target: 'suiteql', type: 'http500', count: 20 });
    const r = await run();
    expect(r.outcome).toBe('partial');
  });

  it('reports unknown when the source cannot be read', async () => {
    h.shopify.state.faults.add({ target: 'graphql', type: 'http500', count: 20 });
    const r = await run();
    expect(r.outcome).toBe('unknown');
  });

  it('works while the versioned implementation is broken (independent identity query)', async () => {
    h.shopify.control.setVariant('drift');
    const r = await run();
    expect(r.outcome).toBe('consistent');
    // deliveries table untouched by reconciliation
    expect((await h.dbh.db.select().from(deliveries)).length).toBe(8);
    expect((await h.dbh.db.select().from(integrations))[0]!.cursorWatermark).not.toBeNull();
  });
});
