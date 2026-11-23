/**
 * SLICE 4 — the maintenance lifecycle of the adopted flow, end to end, against the real database, the
 * deterministic provider fixtures and the unmodified upstream code. The provider change is made at the
 * fixture boundary (webhook payload version 2027-01 no longer carries line_items[].price); nothing below
 * writes a finding, correction or outcome directly.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deliveries, incidentEvents, incidents, integrations } from '@mi/database';
import { InvalidIncidentTransition, transitionIncident } from '@mi/reliability';
import {
  ADOPTED,
  AdoptedConfigSchema,
  adoptedClients,
  advanceMaintenance,
  MAINTENANCE_KIND,
  recordInputContractFinding,
  upstreamDir,
  type Accounting,
  type Finding,
} from '../src/index.ts';
import { createHarness, testCipher, type Harness } from '../../../test/support/harness.ts';
import { attachAdoptedTenant } from '../../../test/support/adopted.ts';
import { maintenanceKit } from '../../../test/support/maintenance.ts';

let h: Harness;
let a: Awaited<ReturnType<typeof attachAdoptedTenant>>;
let clients: Awaited<ReturnType<typeof adoptedClients>>;
const db = () => h.dbh.db;

beforeEach(async () => {
  h = await createHarness();
  a = await attachAdoptedTenant(h);
  const [integ] = await db().select().from(integrations).where(eq(integrations.id, a.integrationId));
  await db()
    .update(integrations)
    .set({ config: { ...(integ!.config as object), reconcileFrom: '2026-11-01T00:00:00Z', reconcileGraceMinutes: 0 } })
    .where(eq(integrations.id, a.integrationId));
  clients = await adoptedClients(db(), testCipher, h.endpoints, a.integrationId);
  delete process.env.PROVIDER_DOCS_DIR;
});
afterEach(async () => {
  delete process.env.PROVIDER_DOCS_DIR;
  await h.close();
});

let kit: ReturnType<typeof maintenanceKit>;
beforeEach(() => {
  kit = maintenanceKit(h, a, clients);
});
const shopifyOrder = (sku?: string, price?: string) => kit.shopifyOrder(sku, price);
const webhook = (legacyId: string) => kit.webhook(legacyId);
const drive = (id: string) => kit.drive(id);
const scenario = () => kit.scenario();
const nsRecords = (legacyId: string) =>
  [...h.netsuite.state.salesOrders.values()].filter((s) => s.externalId === `shopify-${legacyId}`);

describe('maintenance lifecycle: provider input change on the adopted flow', () => {
  it('no change → orders delivered, no maintenance event (test 1)', async () => {
    for (const o of [shopifyOrder(), shopifyOrder()]) {
      const r = await webhook(o.legacyId);
      expect(r.exec).toMatchObject({ executed: true, outcome: 'delivered' });
      expect(r.finding).toBeNull();
    }
    expect(await db().select().from(incidents).where(eq(incidents.kind, MAINTENANCE_KIND))).toHaveLength(0);
  });

  it('detects the change, holds the orders instead of writing them, and records an evidenced finding (tests 2–5)', async () => {
    const s = await scenario();
    for (const r of s.held) {
      expect(r.exec).toMatchObject({ executed: true, outcome: 'held' });
      expect(r.finding).not.toBeNull();
    }
    expect(s.held[0]!.finding!.incidentId).toBe(s.held[1]!.finding!.incidentId); // one event
    for (const o of s.delayed) expect(nsRecords(o.legacyId)).toHaveLength(0); // nothing written
    const [inc] = await db().select().from(incidents).where(eq(incidents.id, s.held[0]!.finding!.incidentId));
    const f = inc!.finding as Finding;
    expect(inc!.integrationId).toBe(a.integrationId);
    expect(inc!.tenantId).toBe(a.tenantId);
    expect(f.dependency).toMatchObject({ integrationId: a.integrationId, upstream: { commit: ADOPTED.commit } });
    expect(f.expected.baseline).toMatchObject({ apiVersion: '2026-10' });
    expect(f.observed).toMatchObject({ apiVersion: '2027-01', deliveryId: s.held[0]!.deliveryId });
    expect(f.observed.violations).toEqual([
      expect.objectContaining({ path: 'line_items[].price', observed: 'absent', occurrences: 1 }),
    ]);
    expect(f.shapeDiff!.removed).toEqual(['line_items[].price']);
    expect(f.shapeDiff!.added).toEqual([]);
    // Reproducible: the finding is a function of the stored receipts, not of the moment.
    const again = await recordInputContractFinding(db(), testCipher, s.held[1]!.deliveryId);
    expect(again).toEqual({ incidentId: inc!.id, created: false });
  });

  it('investigates, corrects at the adoption boundary, validates, recovers, verifies and accounts — zero loss proven (tests 6–14)', async () => {
    const s = await scenario();
    const incidentId = s.held[0]!.finding!.incidentId;
    const { inc, states } = await drive(incidentId);
    expect(inc.status, states.join('\n')).toBe('resolved');

    // investigation: the actual upstream code path, and what the real code would have done
    const inv = inc.investigation as { codePaths: { reads: { file: string; line: number; code: string; matchesPinnedCommit: boolean }[] }[]; dryRun: { wouldSendInvalidRate: number } };
    expect(inv.codePaths[0]!.reads).toEqual([
      expect.objectContaining({ file: 'src/mapping.js', code: expect.stringContaining('Number(l.price)'), matchesPinnedCommit: true }),
    ]);
    expect(inv.dryRun.wouldSendInvalidRate).toBe(1);

    // correction: configuration at the adoption boundary, upstream untouched
    const [integ] = await db().select().from(integrations).where(eq(integrations.id, a.integrationId));
    const config = AdoptedConfigSchema.parse(integ!.config);
    expect(config.inputCompat).toEqual([
      expect.objectContaining({ target: 'line_items[].price', source: 'line_items[].price_set.shop_money.amount', maintenanceEventId: incidentId }),
    ]);
    const mapping = readFileSync(join(upstreamDir(), 'src/mapping.js'));
    expect(createHash('sha256').update(mapping).digest('hex')).toBe(ADOPTED.fileSha256['src/mapping.js']);

    // validation ran separately, with real checks
    const val = inc.validation as { passed: boolean; checks: { name: string; passed: boolean; detail: string }[] };
    expect(val.passed).toBe(true);
    expect(val.checks.map((c) => c.name)).toEqual([
      'upstream unmodified',
      'regression: baseline orders unchanged',
      'changed inputs map correctly',
      'mapped values match Shopify Admin API',
    ]);
    expect(val.checks[1]!.detail).toMatch(/^2\/2 /);

    // accounting
    const acc = inc.accounting as Accounting;
    expect(acc).toMatchObject({
      // window starts at the last order delivered under the old contract (creation time)
      population: 4,
      populationComplete: true,
      deliveredBeforeChange: 1,
      delayed: 2,
      discoveredByReconciliation: 1,
      recovered: 3,
      verified: 4,
      unresolved: 0,
      duplicates: 0,
      zeroLoss: true,
    });
    // destination: exactly one record per order, Shopify's price as the NetSuite rate
    for (const o of [...s.before, ...s.delayed, s.lost]) {
      const recs = nsRecords(o.legacyId);
      expect(recs).toHaveLength(1);
      expect(recs[0]!.item.items.map((l) => l.rate)).toEqual(o.lineItems.map((l) => Number(l.unitPrice)));
    }
    // the delayed orders went through the normal execution path with the rule applied
    const delayedRows = await db().select().from(deliveries).where(eq(deliveries.integrationId, a.integrationId));
    expect(delayedRows.filter((d) => d.outcome !== 'delivered')).toHaveLength(0);

    // timeline: customer-visible steps exist; resolution carries verification evidence
    const tl = await db().select().from(incidentEvents).where(eq(incidentEvents.incidentId, incidentId));
    expect(tl.map((e) => e.toStatus)).toEqual(expect.arrayContaining(['investigating', 'recovery', 'verification', 'resolved']));
    expect(inc.verification).toMatchObject({ passed: true, duplicates: 0 });

    // after the correction, new orders in the changed format flow normally and open nothing new
    const later = shopifyOrder('SKU-BLUE', '7.25');
    const r = await webhook(later.legacyId);
    expect(r.exec).toMatchObject({ executed: true, outcome: 'delivered' });
    expect(nsRecords(later.legacyId)[0]!.item.items[0]!.rate).toBe(7.25);
    expect(await db().select().from(incidents).where(and(eq(incidents.kind, MAINTENANCE_KIND)))).toHaveLength(1);
  });

  it('an event cannot be resolved without the required persisted evidence (test 15)', async () => {
    const s = await scenario();
    const id = s.held[0]!.finding!.incidentId;
    // walk it to verification by legal transitions only, with no correction or accounting
    await transitionIncident(db(), id, 'recovery', { actor: 'operator:x', note: 'skip' });
    await transitionIncident(db(), id, 'verification', { actor: 'operator:x', note: 'skip' });
    await expect(
      transitionIncident(db(), id, 'resolved', { actor: 'operator:x', note: 'looks fine', verification: { passed: true } }),
    ).rejects.toThrow(InvalidIncidentTransition);
    await expect(
      transitionIncident(db(), id, 'resolved', { actor: 'operator:x', note: 'x', verification: { passed: true } }),
    ).rejects.toThrow(/correction not validated.*no correction activated.*no transaction accounting/);
    const [inc] = await db().select().from(incidents).where(eq(incidents.id, id));
    expect(inc!.status).toBe('verification');
  });

  it('without a documented replacement the event escalates: nothing is changed, orders stay held, nothing is claimed', async () => {
    process.env.PROVIDER_DOCS_DIR = mkdtempSync(join(tmpdir(), 'no-docs-'));
    const s = await scenario();
    const { inc } = await drive(s.held[0]!.finding!.incidentId);
    expect(inc.status).toBe('investigating');
    expect((inc.evidence as { maintenance: { escalated: string } }).maintenance.escalated).toMatch(/changelog unavailable/i);
    expect(inc.accounting).toBeNull();
    const [integ] = await db().select().from(integrations).where(eq(integrations.id, a.integrationId));
    expect(AdoptedConfigSchema.parse(integ!.config).inputCompat).toEqual([]);
    for (const r of s.held) {
      const [d] = await db().select().from(deliveries).where(eq(deliveries.id, r.deliveryId));
      expect(d!.outcome).toBe('held');
    }
  });

  it('an order that cannot be recovered leaves the event unresolved and no zero-loss claim (test 17)', async () => {
    const s = await scenario();
    shopifyOrder('SKU-NOT-IN-NETSUITE', '5.00'); // lost webhook, and NetSuite will reject it
    const { inc } = await drive(s.held[0]!.finding!.incidentId);
    expect(inc.status).toBe('verification');
    const acc = inc.accounting as Accounting;
    expect(acc.unresolved).toBe(1);
    expect(acc.zeroLoss).toBe(false);
    expect((inc.evidence as { maintenance: { escalated: string } }).maintenance.escalated).toMatch(/1 transaction\(s\) unresolved/);
    expect(inc.resolvedAt).toBeNull();
  });

  it('the driver is safe to re-run after it finished (idempotent steps, no duplicate records)', async () => {
    const s = await scenario();
    const id = s.held[0]!.finding!.incidentId;
    await drive(id);
    const again = await advanceMaintenance({
      db: db(),
      cipher: testCipher,
      incidentId: id,
      clients,
      enqueueExecution: async () => undefined,
      enqueueReconciliation: async () => undefined,
      enqueueRecovery: async () => undefined,
    });
    expect(again.state).toBe('noop');
    for (const o of [...s.before, ...s.delayed, s.lost]) expect(nsRecords(o.legacyId)).toHaveLength(1);
  });
});
