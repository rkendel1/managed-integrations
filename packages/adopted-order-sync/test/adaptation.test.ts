/**
 * SLICE 5 — the adaptation mechanism: adapters and reviewed patches with provenance, validation,
 * activation and rollback. Real PostgreSQL, deterministic provider fixtures, the unmodified upstream code.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adaptations, deliveries, deliveryAttempts, incidents, integrations } from '@mi/database';
import {
  activateAdaptation,
  ADOPTED,
  adoptedClients,
  applyInputCompat,
  checkInputContract,
  evaluateInput,
  executeDelivery,
  ingestShopifyWebhook,
  loadArtifact,
  MAINTENANCE_KIND,
  patchCatalog,
  proposeAdaptation,
  recordInputContractFinding,
  rejectAdaptation,
  rollbackAdaptation,
  runningCode,
  runtimeFor,
  upstreamDir,
  validateAdaptation,
  type Accounting,
} from '../src/index.ts';
import { createHarness, FAST_RETRY, testCipher, type Harness } from '../../../test/support/harness.ts';
import { attachAdoptedTenant, signedWebhook } from '../../../test/support/adopted.ts';
import { maintenanceKit } from '../../../test/support/maintenance.ts';

const RULE = { target: 'line_items[].price', source: 'line_items[].price_set.shop_money.amount' };
const line = (o: Record<string, unknown>) => ({
  id: 1,
  name: '#1',
  currency: 'USD',
  line_items: [{ sku: 'SKU-RED', quantity: 2, ...o }],
});
const money = (amount: unknown) => ({ shop_money: { amount, currency_code: 'USD' } });

describe('field-moved adapter (pure)', () => {
  const run = (p: unknown) => {
    const a = applyInputCompat(p, [RULE]);
    return { ...a, violations: checkInputContract(a.payload) };
  };
  const price = (r: { payload: unknown }) =>
    (r.payload as { line_items: { price?: unknown }[] }).line_items[0]!.price;

  it('old provider shape: unchanged, nothing applied', () => {
    const r = run(line({ price: '12.50' }));
    expect(r).toMatchObject({ applied: [], conflicts: [], violations: [] });
    expect(price(r)).toBe('12.50');
  });
  it('new provider shape: the replacement is copied', () => {
    const r = run(line({ price_set: money('12.50') }));
    expect(price(r)).toBe('12.50');
    expect(r.applied).toEqual([{ ...RULE, count: 1 }]);
    expect(r.violations).toEqual([]);
  });
  it('both present and equal: no conflict, nothing to do', () => {
    const r = run(line({ price: '12.50', price_set: money('12.5') }));
    expect(r).toMatchObject({ applied: [], conflicts: [], violations: [] });
  });
  it('both present and DIFFERENT: a conflict, never resolved silently', () => {
    const r = run(line({ price: '10.00', price_set: money('12.50') }));
    expect(r.conflicts).toEqual([{ ...RULE, line: 0 }]);
    expect(price(r)).toBe('10.00');
    expect(
      evaluateInput(line({ price: '10.00', price_set: money('12.50') }), {
        artifact: { precision: { 'line_items[].price': 2 } } as never,
        adapters: [RULE] as never,
      }).violations,
    ).toEqual([expect.objectContaining({ path: 'line_items[].price', observed: 'conflict' })]);
  });
  it('missing replacement: nothing copied; the contract reports the field absent', () => {
    const r = run(line({}));
    expect(r.applied).toEqual([]);
    expect(r.violations).toEqual([
      expect.objectContaining({ path: 'line_items[].price', observed: 'absent' }),
    ]);
  });
  it('wrong type: an object is never copied; a non-numeric price is reported', () => {
    expect(run(line({ price_set: money({ value: '12.50' }) })).violations).toEqual([
      expect.objectContaining({ observed: 'absent' }),
    ]);
    expect(run(line({ price: 'twelve' })).violations).toEqual([
      expect.objectContaining({ observed: 'wrong_type' }),
    ]);
  });
  it('null and empty values are never copied', () => {
    expect(run(line({ price_set: money(null) })).violations).toEqual([
      expect.objectContaining({ observed: 'absent' }),
    ]);
    expect(run(line({ price_set: money('') })).violations).toEqual([
      expect.objectContaining({ observed: 'absent' }),
    ]);
    expect(run(line({ price: null, price_set: money('12.50') })).applied).toEqual([{ ...RULE, count: 1 }]);
  });
  it('unexpected nested structure is not interpreted', () => {
    expect(run(line({ price_set: '12.50' })).violations).toEqual([
      expect.objectContaining({ observed: 'absent' }),
    ]);
    expect(run(line({ price_set: { presentment_money: { amount: '12.50' } } })).violations).toEqual([
      expect.objectContaining({ observed: 'absent' }),
    ]);
  });
  it('repeated execution is idempotent', () => {
    const once = applyInputCompat(line({ price_set: money('12.50') }), [RULE]);
    const twice = applyInputCompat(once.payload, [RULE]);
    expect(twice.payload).toEqual(once.payload);
    expect(twice.applied).toEqual([]);
  });
  it('the input contract knows the original code rounds prices to 2 decimals', () => {
    expect(checkInputContract(line({ price: '12.345' }))).toEqual([
      expect.objectContaining({ path: 'line_items[].price', observed: 'precision' }),
    ]);
    expect(checkInputContract(line({ price: '12.340' }))).toEqual([]);
    expect(checkInputContract(line({ price: '12.345' }), { precision: { 'line_items[].price': 4 } })).toEqual(
      [],
    );
  });
});

describe('artifacts: what code runs', () => {
  it('the original artifact is the pinned upstream package; a patched artifact is a separate, content-addressed copy', async () => {
    const original = await loadArtifact([]);
    const patched = await loadArtifact(patchCatalog());
    expect(original.id).toBe(`adopted:${ADOPTED.commit.slice(0, 12)}`);
    expect(patched.id).toBe(`adopted:${ADOPTED.commit.slice(0, 12)}+p0001`);
    expect(original.files).toEqual(ADOPTED.fileSha256 as unknown as Record<string, string>);
    expect(patched.files['src/mapping.js']).toBe(patchCatalog()[0]!.resultSha256);
    const order = line({ price: '12.345' });
    expect(original.modules.toCanonicalOrder(order, {}).lines[0]!.unitPrice).toBe(12.35);
    expect(patched.modules.toCanonicalOrder(order, {}).lines[0]!.unitPrice).toBe(12.345);
    // the installed upstream package was not touched
    const sha = createHash('sha256')
      .update(readFileSync(join(upstreamDir(), 'src/mapping.js')))
      .digest('hex');
    expect(sha).toBe(ADOPTED.fileSha256['src/mapping.js']);
  });
  it('a patch that does not match its base refuses to load', async () => {
    const p = { ...patchCatalog()[0]!, id: 'p0999-bad', baseSha256: '0'.repeat(64) };
    await expect(loadArtifact([p])).rejects.toThrow(/base file hash/);
  });
});

describe('the correction registry', () => {
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
      .set({
        config: {
          ...(integ!.config as object),
          reconcileFrom: '2026-11-01T00:00:00Z',
          reconcileGraceMinutes: 0,
        },
      })
      .where(eq(integrations.id, a.integrationId));
    clients = await adoptedClients(db(), testCipher, h.endpoints, a.integrationId);
    kit = maintenanceKit(h, a, clients);
  });
  afterEach(() => h.close());
  const ns = (legacyId: string) =>
    [...h.netsuite.state.salesOrders.values()].filter((s) => s.externalId === `shopify-${legacyId}`);
  const rows = () => db().select().from(adaptations).where(eq(adaptations.integrationId, a.integrationId));

  it('rollback restores the previous behaviour; the same correction is not re-applied automatically', async () => {
    const s = await kit.scenario();
    const { inc } = await kit.drive(s.held[0]!.finding!.incidentId);
    expect(inc.status).toBe('resolved');
    const [adapter] = await rows();
    expect((await runtimeFor(db(), a.integrationId)).adapters).toHaveLength(1);

    const back = await rollbackAdaptation(db(), adapter!.id, 'operator:test', 'test rollback');
    expect(back.status).toBe('rolled_back');
    expect((back.history as { to: string }[]).map((x) => x.to)).toEqual([
      'proposed',
      'validating',
      'validated',
      'active',
      'rolled_back',
    ]);
    const rt = await runtimeFor(db(), a.integrationId);
    expect(rt).toMatchObject({ adapters: [], artifact: { id: `adopted:${ADOPTED.commit.slice(0, 12)}` } });

    // previous behaviour: a changed-format order is held again (not written)
    const o = kit.shopifyOrder('SKU-RED', '9.00');
    const r = await kit.webhook(o.legacyId);
    expect(r.exec).toMatchObject({ executed: true, outcome: 'held' });
    expect(ns(o.legacyId)).toHaveLength(0);
    // …and maintenance does not silently re-apply what an operator rolled back
    const again = await kit.drive(r.finding!.incidentId);
    expect(again.inc.status).toBe('investigating');
    expect((again.inc.evidence as { maintenance: { escalated: string } }).maintenance.escalated).toMatch(
      /rolled back before/,
    );
    expect((await rows()).map((x) => [x.kind, x.status]).sort()).toEqual([
      ['adapter', 'rolled_back'],
      ['unsupported', 'unsupported'],
    ]);
  });

  it('refuses conflicting data: the order is held and the change is routed to a person', async () => {
    kit.shopifyOrder(); // baseline order so the store has history
    const o = kit.shopifyOrder('SKU-RED', '12.50');
    const body = a.shopify.control.webhookPayload(a.shopify.state.orders.get(o.legacyId)!) as {
      line_items: { price?: string; price_set: { shop_money: { amount: string } } }[];
    };
    body.line_items[0]!.price = '10.00'; // disagrees with price_set (12.50)
    // an adapter for this field is already active (from an earlier change)
    const proposed = await proposeAdaptation(db(), {
      integrationId: a.integrationId,
      kind: 'adapter',
      dependency: { provider: 'shopify' },
      codePath: {},
      spec: { type: 'field_moved', ...RULE },
      rationale: 'test',
      actor: 'operator:test',
    });
    await db()
      .update(adaptations)
      .set({ status: 'active', activatedAt: new Date() })
      .where(eq(adaptations.id, proposed.id));
    const w = signedWebhook(body, 'fixture-shopify-client-secret', a.shop);
    const ing = await ingestShopifyWebhook({
      db: db(),
      cipher: testCipher,
      integrationId: a.integrationId,
      rawBody: w.raw,
      headers: w.headers,
      webhookSecret: 'fixture-shopify-client-secret',
    });
    const exec = await executeDelivery({
      db: db(),
      cipher: testCipher,
      endpoints: h.endpoints,
      deliveryId: ing.deliveryId!,
      trigger: { kind: 'webhook' },
    });
    expect(exec).toMatchObject({
      outcome: 'held',
      violations: [expect.objectContaining({ observed: 'conflict' })],
    });
    expect(ns(o.legacyId)).toHaveLength(0);
    const f = await recordInputContractFinding(db(), testCipher, ing.deliveryId!);
    const { inc } = await kit.drive(f!.incidentId);
    expect((inc.evidence as { maintenance: { escalated: string } }).maintenance.escalated).toMatch(
      /business decision/,
    );
    expect((await rows()).find((x) => x.kind === 'unsupported')).toBeTruthy();
  });

  it('activation guards: only validated corrections, decisions for limited validations, one per field', async () => {
    const mk = () =>
      proposeAdaptation(db(), {
        integrationId: a.integrationId,
        kind: 'adapter',
        dependency: {},
        codePath: {},
        spec: { type: 'field_moved', ...RULE },
        rationale: 'operator proposal without affected orders',
        actor: 'operator:test',
      });
    const p1 = await mk();
    await expect(activateAdaptation(db(), p1.id, 'operator:test', 'x')).rejects.toThrow(/Only a validated/);
    const v1 = await validateAdaptation(db(), testCipher, p1.id, clients, FAST_RETRY);
    expect(v1.status).toBe('validated');
    expect(v1.validation).toMatchObject({ passed: true, requiresDecision: true }); // no held orders to test against
    await expect(activateAdaptation(db(), p1.id, 'operator:test', 'x')).rejects.toThrow(/explicit decision/);
    await activateAdaptation(db(), p1.id, 'operator:test', 'accepted', { acceptLimitations: true });
    const p2 = await mk();
    await validateAdaptation(db(), testCipher, p2.id, clients, FAST_RETRY);
    await expect(
      activateAdaptation(db(), p2.id, 'operator:test', 'x', { acceptLimitations: true }),
    ).rejects.toThrow(/same behaviour \(a:line_items\[\]\.price\)/);
    await rejectAdaptation(db(), p2.id, 'operator:test', 'duplicate');
    await expect(
      proposeAdaptation(db(), {
        integrationId: a.integrationId,
        kind: 'patch',
        dependency: {},
        codePath: {},
        spec: { patchId: 'p9999-not-reviewed' },
        rationale: 'x',
        actor: 'operator:test',
      }),
    ).rejects.toThrow(/reviewed patches/);
  });

  it('a reviewed PATCH: proposed by maintenance, validated, activated by an operator, verified exactly, and rolled back', async () => {
    // normal operation, then an order in a three-decimal currency
    for (const o of [kit.shopifyOrder(), kit.shopifyOrder('SKU-BLUE', '7.25')]) await kit.webhook(o.legacyId);
    const t = new Date(Date.now() - 1000).toISOString();
    const kwd = a.shopify.control.upsertOrder({
      name: '#KWD1',
      createdAt: t,
      updatedAt: t,
      currencyCode: 'KWD',
      email: 'b@bluewave.test',
      lineItems: [{ sku: 'SKU-RED', title: 'Part', quantity: 2, unitPrice: '12.345' }],
    });
    const r = await kit.webhook(kwd.legacyId);
    expect(r.exec).toMatchObject({
      outcome: 'held',
      violations: [expect.objectContaining({ observed: 'precision' })],
    });
    expect(ns(kwd.legacyId)).toHaveLength(0);

    const first = await kit.drive(r.finding!.incidentId);
    expect(first.inc.status).toBe('investigating'); // waiting for a person
    const inv = first.inc.investigation as { dryRun: { wouldChangeAmount: number }; risk: string };
    expect(inv.dryRun.wouldChangeAmount).toBe(1);
    const [patch] = (await rows()).filter((x) => x.kind === 'patch');
    expect(patch).toMatchObject({
      status: 'validated',
      maintenanceEventId: r.finding!.incidentId,
      spec: expect.objectContaining({ patchId: 'p0001-preserve-price-precision' }),
    });
    expect(
      (patch!.validation as { checks: { name: string; status: string }[] }).checks.map((c) => [
        c.name,
        c.status,
      ]),
    ).toEqual([
      ['applies to the adopted artifact', 'passed'],
      ['original adopted code unchanged', 'passed'],
      ['patch reproduces the reviewed change exactly', 'passed'],
      ['regression: stored orders unchanged', 'passed'],
      ['affected orders handled', 'passed'],
      ['business data preserved (Shopify Admin API)', 'passed'],
      ['no conflicting data accepted', 'passed'],
      ['rollback target available', 'passed'],
    ]);

    await activateAdaptation(db(), patch!.id, 'operator:test', 'Reviewed and approved');
    const done = await kit.drive(r.finding!.incidentId);
    expect(done.inc.status, done.states.join('\n')).toBe('resolved');
    expect((done.inc.accounting as Accounting).zeroLoss).toBe(true);
    expect(ns(kwd.legacyId)[0]!.item.items[0]!.rate).toBe(12.345); // exact, not 12.35
    const [att] = await db()
      .select()
      .from(deliveryAttempts)
      .innerJoin(deliveries, eq(deliveries.id, deliveryAttempts.deliveryId))
      .where(and(eq(deliveries.sourceLegacyId, kwd.legacyId), eq(deliveryAttempts.outcome, 'delivered')));
    expect(att!.delivery_attempts.implementationVersionId).toBe(
      `adopted:${ADOPTED.commit.slice(0, 12)}+p0001`,
    );
    expect(att!.delivery_attempts.evidence).toMatchObject({
      artifact: { patches: ['p0001-preserve-price-precision'], adaptations: [patch!.id] },
    });

    // the operator's answer to "what is running and why"
    const code = await runningCode(db(), a.integrationId);
    expect(code.running).toMatchObject({ id: `adopted:${ADOPTED.commit.slice(0, 12)}+p0001` });
    expect(code.pinnedFiles.every((f) => f.matches)).toBe(true);

    // rollback: the original artifact runs again; a new KWD order is held, not rounded
    await rollbackAdaptation(db(), patch!.id, 'operator:test', 'rollback test');
    expect((await runtimeFor(db(), a.integrationId)).artifact.id).toBe(
      `adopted:${ADOPTED.commit.slice(0, 12)}`,
    );
    const kwd2 = a.shopify.control.upsertOrder({
      name: '#KWD2',
      createdAt: t,
      updatedAt: t,
      currencyCode: 'KWD',
      email: 'b@bluewave.test',
      lineItems: [{ sku: 'SKU-RED', title: 'Part', quantity: 1, unitPrice: '3.125' }],
    });
    expect((await kit.webhook(kwd2.legacyId)).exec).toMatchObject({ outcome: 'held' });
    expect(ns(kwd2.legacyId)).toHaveLength(0);
    expect(await db().select().from(incidents).where(eq(incidents.kind, MAINTENANCE_KIND))).toHaveLength(2);
  });
});
