/**
 * SLICE 7 — target-side and combined changes on Shopify → NetSuite (adopted shopify-erp-order-sync @ d01b51d),
 * against the real database, the deterministic fixtures and the unmodified upstream code.
 *
 * Target change the adopted code cannot meet: the NetSuite account becomes OneWorld and refuses every sales
 * order without a subsidiary; the adopted adapter has no way to send one. Corrections: the customer's decision
 * (which subsidiary), a configuration, and reviewed patch p0002 (operator activation).
 *
 * Combined: while that is open, Shopify moves a field the adopted mapping reads (webhook version 2027-01).
 *
 * INVARIANT: every Shopify order becomes exactly one NetSuite sales order with Shopify's items, quantities and
 * prices, in the subsidiary the customer chose; no order is written with only part of the path corrected;
 * orders already in NetSuite are not rewritten; the pinned upstream files never change.
 */
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adaptations, deliveries, incidents, integrations } from '@mi/database';
import { decide, pinnedDrift } from '@mi/managed';
import {
  activateAdaptation,
  adoptedClients,
  advanceTargetChange,
  executeDelivery,
  MAINTENANCE_KIND,
  rollbackAdaptation,
  runtimeFor,
  TARGET_KIND,
  upstreamDir,
  ADOPTED,
} from '../src/index.ts';
import { createHarness, testCipher, type Harness } from '../../../test/support/harness.ts';
import { attachAdoptedTenant } from '../../../test/support/adopted.ts';
import { maintenanceKit } from '../../../test/support/maintenance.ts';

let h: Harness;
let a: Awaited<ReturnType<typeof attachAdoptedTenant>>;
let clients: Awaited<ReturnType<typeof adoptedClients>>;
let kit: ReturnType<typeof maintenanceKit>;
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
  kit = maintenanceKit(h, a, clients);
});
afterEach(async () => h.close());

/** Plays the worker for the target event: advance it and run what it enqueued, until it waits or settles. */
async function driveTarget(incidentId: string, max = 20) {
  const states: string[] = [];
  for (let i = 0; i < max; i++) {
    const exec: string[] = [];
    const r = await advanceTargetChange(
      { db: db(), cipher: testCipher, clients, enqueueExecution: async (id) => void exec.push(id) },
      incidentId,
    );
    states.push(`${r.state}:${r.detail}`);
    for (const id of exec)
      await executeDelivery({ db: db(), cipher: testCipher, endpoints: h.endpoints, deliveryId: id, trigger: { kind: 'maintenance_recovery', maintenanceEventId: incidentId } });
    if (r.state !== 'continue') break;
  }
  return states;
}
const event = async (kind: string) =>
  (await db().select().from(incidents).where(and(eq(incidents.integrationId, a.integrationId), eq(incidents.kind, kind))))[0]!;
const outcomeOf = async (id: string) => (await db().select().from(deliveries).where(eq(deliveries.id, id)))[0]!.outcome;
const nsRecord = (legacyId: string) => [...h.netsuite.state.salesOrders.values()].find((s) => s.externalId === `shopify-${legacyId}`);

/** NetSuite becomes OneWorld: a second subsidiary exists, and every sales order needs one. */
function oneWorld() {
  h.netsuite.state.oneWorld = true;
  h.netsuite.state.subsidiaries.add('2');
  h.netsuite.state.subsidiaryNames.set('2', 'Bluewave Canada');
}

async function customerChooses(incId: string, optionId: string) {
  const [d] = await db().select().from(adaptations).where(and(eq(adaptations.maintenanceEventId, incId), eq(adaptations.kind, 'decision')));
  return decide(db(), d!.id, { optionId, actor: 'customer', role: 'customer', tenantId: a.tenantId });
}

describe('target-side and combined changes on Shopify → NetSuite', () => {
  it('target-only: NetSuite becomes OneWorld — orders held (not rejected), the customer chooses the subsidiary, the reviewed patch is validated whole-path and activated by an operator, held orders released once and verified; history untouched; rollback', async () => {
    const early = kit.shopifyOrder();
    expect((await kit.webhook(early.legacyId)).exec).toMatchObject({ outcome: 'delivered' });
    oneWorld();
    const o1 = kit.shopifyOrder('SKU-BLUE', '7.25');
    const w1 = await kit.webhook(o1.legacyId);
    expect(w1.exec).toMatchObject({ outcome: 'held', errorClass: 'target_contract', requiredField: 'Subsidiary' });
    const ev = w1.target!;
    expect(ev).toMatchObject({ kind: TARGET_KIND, boundary: 'target', provider: 'netsuite' });
    // impact, then a business question only the customer may answer (options read from NetSuite)
    await driveTarget(ev.id);
    expect(await event(TARGET_KIND)).toMatchObject({ status: 'requires_action', customerAction: 'Choose the subsidiary for your Shopify orders.' });
    const [q] = await db().select().from(adaptations).where(and(eq(adaptations.maintenanceEventId, ev.id), eq(adaptations.kind, 'decision')));
    expect((q!.spec as { options: { label: string }[] }).options.map((o) => o.label)).toEqual(['Bluewave Holdings', 'Bluewave Canada']);
    await expect(decide(db(), q!.id, { optionId: '2', actor: 'op', role: 'operator', tenantId: null })).rejects.toThrow();
    await customerChooses(ev.id, '2');
    const s2 = await driveTarget(ev.id);
    expect(s2.at(-1)).toBe('wait:validated; awaiting operator activation');
    const corr = await db().select().from(adaptations).where(eq(adaptations.maintenanceEventId, ev.id));
    expect(corr.map((x) => [x.kind, x.status])).toEqual([['decision', 'active'], ['configuration', 'active'], ['patch', 'validated']]);
    const patch = corr.find((x) => x.kind === 'patch')!;
    expect((patch.validation as { checks: { status: string }[] }).checks.map((c) => c.status)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed']);
    expect(await outcomeOf(w1.deliveryId)).toBe('held'); // nothing released before the code can send it
    await activateAdaptation(db(), patch.id, 'operator:test', 'reviewed');
    expect((await runtimeFor(db(), a.integrationId)).artifact.id).toBe(`adopted:${ADOPTED.commit.slice(0, 12)}+p0002`);
    await driveTarget(ev.id);
    const done = await event(TARGET_KIND);
    expect(done.status).toBe('resolved');
    expect(done.accounting).toMatchObject({ zeroLoss: true, unresolved: 0, duplicates: 0, delayed: 1 });
    expect(nsRecord(o1.legacyId)!.subsidiary).toEqual({ id: '2' });
    expect(nsRecord(early.legacyId)!.subsidiary ?? null).toBeNull(); // history untouched
    expect(pinnedDrift({ label: 'adopted', repository: ADOPTED.repository, commit: ADOPTED.commit, dir: upstreamDir(), fileSha256: ADOPTED.fileSha256 })).toEqual([]);
    // rollback restores the original adapter; the event's evidence stays
    await rollbackAdaptation(db(), patch.id, 'operator:test', 'rollback drill');
    expect((await runtimeFor(db(), a.integrationId)).artifact.id).toBe(`adopted:${ADOPTED.commit.slice(0, 12)}`);
  });

  it('combined: OneWorld and a Shopify payload change at the same time — neither event releases or validates on part of the path; corrected together, every order delivered once with the right prices and subsidiary', async () => {
    const early = kit.shopifyOrder();
    await kit.webhook(early.legacyId);
    oneWorld();
    const o1 = kit.shopifyOrder('SKU-BLUE', '7.25');
    const w1 = await kit.webhook(o1.legacyId); // reaches NetSuite: refused for the subsidiary
    a.shopify.control.setWebhookVersion('2027-01'); // Shopify moves line_items[].price
    const o2 = kit.shopifyOrder('SKU-RED', '12.50');
    const w2 = await kit.webhook(o2.legacyId); // held at the source boundary; never reaches NetSuite
    expect(w1.exec).toMatchObject({ errorClass: 'target_contract' });
    expect(w2.exec).toMatchObject({ outcome: 'held' });
    expect(w2.finding).toBeTruthy();
    const T = w1.target!;
    const S = await event(MAINTENANCE_KIND);
    expect(S.boundary).toBe('source');
    await driveTarget(T.id);
    await customerChooses(T.id, '2');
    // the target event cannot validate on part of the path: the source change is not corrected yet
    const t1 = await driveTarget(T.id);
    expect(t1.at(-1)).toBe('wait:validation waits for input_contract_change');
    // the source event corrects itself (adapter, validated, activated) but does not release on part of the path
    await kit.drive(S.id).catch(() => undefined);
    const s1 = await event(MAINTENANCE_KIND);
    expect((s1.correction as { activatedAt?: string }).activatedAt).toBeTruthy();
    expect(await outcomeOf(w1.deliveryId)).toBe('held');
    expect(await outcomeOf(w2.deliveryId)).toBe('held');
    // now the whole path validates (both held orders through the source adapter, mapping and patched adapter)
    expect((await driveTarget(T.id)).at(-1)).toBe('wait:validated; awaiting operator activation');
    const patch = (await db().select().from(adaptations).where(and(eq(adaptations.maintenanceEventId, T.id), eq(adaptations.kind, 'patch'))))[0]!;
    const checks = (patch.validation as { checks: { name: string; status: string; detail: string }[] }).checks;
    expect(checks[0]).toMatchObject({ status: 'passed', detail: '2/2 held orders' });
    await activateAdaptation(db(), patch.id, 'operator:test', 'reviewed');
    await driveTarget(T.id);
    expect((await event(TARGET_KIND)).status).toBe('resolved');
    // the source event finishes its own verification on the corrected path
    await kit.drive(S.id);
    expect((await event(MAINTENANCE_KIND)).status).toBe('resolved');
    // every order exactly once, with Shopify's prices, in the chosen subsidiary
    for (const [o, price] of [[o1, 7.25], [o2, 12.5]] as const) {
      const recs = [...h.netsuite.state.salesOrders.values()].filter((s) => s.externalId === `shopify-${o.legacyId}`);
      expect(recs).toHaveLength(1);
      expect(recs[0]!.subsidiary).toEqual({ id: '2' });
      expect(recs[0]!.item.items[0]!.rate).toBe(price);
    }
    expect(nsRecord(early.legacyId)!.subsidiary ?? null).toBeNull();
  });
});
