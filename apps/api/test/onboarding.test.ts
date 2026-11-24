/**
 * SLICE 5 — onboarding through the real API: signup → connect (Shopify OAuth via the fixture, NetSuite
 * M2M) → discover → confirm → protect. The customer's existing integration is their own deployment of the
 * pinned upstream code (test/support/existing-deployment.ts); its NetSuite records are written by that code.
 * Fixture-backed: no live Shopify store or NetSuite account is involved.
 */
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createClient } from '@appport/client';
import { createHttpTransport } from '@appport/transport-http';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { PgBoss } from 'pg-boss';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executeDelivery,
  scanReconciliation,
  shopifyOnboarding,
  tenantClients,
} from '@mi/adopted-order-sync';
import { advanceOnboarding } from '@mi/managed';
import { QUEUES } from '@mi/contracts';
import { auditLog, connections, deliveries, integrations } from '@mi/database';
import { loadServiceConfig } from '@mi/integration-shopify-netsuite';
import { createShopifyFixture, type ShopifyFixture } from '@mi/test-fixtures';
import { buildApp } from '../src/app.ts';
import { ensureQueues } from '../src/queues.ts';
import {
  createHarness,
  FAST_RETRY,
  TEST_DB_URL,
  testCipher,
  type Harness,
} from '../../../test/support/harness.ts';
import { existingDeployment } from '../../../test/support/existing-deployment.ts';

const SHOP = 'northwind-goods.myshopify.com';
let h: Harness;
let shop: ShopifyFixture;
let shopUrl: string;
let app: FastifyInstance;
let boss: PgBoss;
let base: string;

async function setup() {
  h = await createHarness();
  // The adopted code sends no subsidiary, so OneWorld accounts reject its orders (documented gap since slice 2).
  h.netsuite.state.oneWorld = false;
  shop = createShopifyFixture({ shopDomain: SHOP, firstOrderId: 8_000_000_001n });
  await shop.app.listen({ port: 0, host: '127.0.0.1' });
  shopUrl = `http://127.0.0.1:${(shop.app.server.address() as AddressInfo).port}`;
  boss = new PgBoss({
    connectionString: TEST_DB_URL,
    schema: `pgboss_onb_${randomBytes(3).toString('hex')}`,
  });
  await boss.start();
  await ensureQueues(boss);
  const config = loadServiceConfig('api', {
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB_URL,
    CREDENTIAL_ENCRYPTION_KEYS: `k1:${randomBytes(32).toString('base64')}`,
    SHOPIFY_CLIENT_ID: shop.clientId,
    SHOPIFY_CLIENT_SECRET: shop.clientSecret,
    SHOPIFY_BASE_URL_OVERRIDE: shopUrl,
    NETSUITE_BASE_URL_OVERRIDE: h.netsuiteUrl,
    PUBLIC_BASE_URL: 'http://localhost:3000',
  });
  (config as { cipher: unknown }).cipher = testCipher;
  app = await buildApp({ db: h.dbh.db, boss, config, logLevel: 'silent' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await shop?.app.close();
  await h?.close();
});

/** Orders in the customer's store, created well before onboarding (outside the in-flight grace period). */
function history(n: number, from = Date.now() - 6 * 3600_000) {
  return Array.from({ length: n }, (_, i) => {
    const t = new Date(from + i * 60_000).toISOString();
    return shop.control.upsertOrder({
      createdAt: t,
      updatedAt: t,
      email: 'buyer@northwind.test',
      lineItems: [
        { sku: i % 2 ? 'SKU-BLUE' : 'SKU-RED', title: 'Part', quantity: 1 + i, unitPrice: '10.00' },
      ],
    });
  });
}

/** A browser-like customer session: counts every action the customer takes. */
async function customer(email = 'owner@northwind.test') {
  const actions: string[] = [];
  const r = await fetch(`${base}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ company: 'Northwind Goods', email, password: 'correct horse battery staple' }),
  });
  expect(r.status).toBe(200);
  actions.push('sign up');
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  const csrf = ((await r.json()) as { csrfToken: string }).csrfToken;
  const rest = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const client = createClient({
    transport: createHttpTransport({ url: `${base}/appport`, headers: { cookie } }),
  });
  await client.connect();
  await client.load();
  return {
    actions,
    call: <T = Record<string, unknown>>(name: string, input: unknown = {}) => client.call<T>(name, input),
    async connectShopify(opts: { scope?: string } = {}) {
      actions.push('connect Shopify (shop name)');
      const start = (await (
        await rest('/api/customer/connections/shopify/authorize', { shop: SHOP })
      ).json()) as { url: string };
      const url = new URL(start.url);
      if (opts.scope) url.searchParams.set('scope', opts.scope);
      actions.push('approve in Shopify');
      const red = await fetch(url, { redirect: 'manual' });
      const cb = new URL(red.headers.get('location')!);
      const back = await fetch(`${base}${cb.pathname}${cb.search}`, { redirect: 'manual' });
      return back.headers.get('location');
    },
    async connectNetSuite() {
      actions.push('connect NetSuite (account, client id, certificate id)');
      const res = (await (
        await rest('/api/customer/connections/netsuite', {
          accountDomain: '1234567-sb1.suitetalk.api.netsuite.com',
          clientId: h.netsuite.clientId,
          certificateId: h.netsuite.certificateId,
        })
      ).json()) as { publicKeyPem: string };
      actions.push('upload the certificate in NetSuite');
      h.netsuite.control.registerPublicKey(res.publicKeyPem);
      actions.push('verify NetSuite');
      return (await (await rest('/api/customer/connections/netsuite/verify', {})).json()) as {
        status: string;
      };
    },
  };
}

/** Plays the worker for activation: advance, run queued reconciliation scans inline. */
async function activate(tenantId: string, maxSteps = 30) {
  const clients = await tenantClients(h.dbh.db, testCipher, h.endpoints, tenantId);
  const queued: string[] = [];
  const impl = shopifyOnboarding({
    cipher: testCipher,
    endpoints: h.endpoints,
    webhookBaseUrl: base,
    enqueueReconciliation: async (runId: string) => void queued.push(runId),
    retry: FAST_RETRY,
  });
  const states: string[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const r = await advanceOnboarding(h.dbh.db, tenantId, impl);
    states.push(`${r.state}:${r.detail}`);
    for (const runId of queued.splice(0))
      await scanReconciliation({ db: h.dbh.db, runId, workerId: 'w', clients, retry: FAST_RETRY });
    if (r.state === 'done' || r.state === 'blocked' || r.state === 'noop') break;
  }
  return states;
}
type Flow = {
  flowType: string;
  status: string;
  discovery: {
    outcome: string;
    checked: number;
    candidates: { id: string; kind: string; confidence: string | null; summary: string }[];
  } | null;
  activation: { baseline: Record<string, number | string> | null } | null;
  integrationId: string | null;
  responsibilities: { version: string };
};
type Status = { status: string; integrations: Flow[]; systems: { id: string; connected: boolean }[] };
/** The Shopify → NetSuite onboarding inside the customer's overall view. */
const shopifyFlow = (v: Status) =>
  v.integrations.find((i) => i.flowType === 'adopted.shopify_erp_order_sync.netsuite')!;

describe('onboarding: connect → discover → confirm → protect', () => {
  it('finds the existing integration, puts it under management with a verified baseline, and takes over new orders', async () => {
    await setup();
    const orders = history(6);
    const theirs = await existingDeployment(h);
    for (const o of orders)
      expect((await theirs.process(shop.control.webhookPayload(o))).status).toBe('created');

    const c = await customer();
    expect((await c.call<Status>('onboarding.status')).status).toBe('connect');
    expect(await c.connectShopify()).toBe('/app/welcome?connected=shopify');
    // partial onboarding: NetSuite not connected yet → discovery waits, nothing is guessed
    expect((await c.call<Status>('onboarding.discover')).status).toBe('connect');
    expect((await c.connectNetSuite()).status).toBe('verified');

    const found = await c.call<Status>('onboarding.discover');
    expect(found.status).toBe('confirm');
    expect(shopifyFlow(found).discovery).toMatchObject({ outcome: 'found', checked: 6 });
    expect(shopifyFlow(found).discovery!.candidates).toEqual([
      expect.objectContaining({
        id: 'adopted.shopify_erp_order_sync',
        kind: 'adoptable',
        confidence: 'established',
      }),
    ]);
    expect(shopifyFlow(found).discovery!.candidates[0]!.summary).toMatch(
      /^6 of your last 6 Shopify orders are in NetSuite/,
    );

    // explicit, versioned authorization
    await expect(
      c.call('onboarding.confirm', {
        candidateId: 'adopted.shopify_erp_order_sync',
        responsibilitiesVersion: 'r0',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    c.actions.push('confirm: maintain this integration');
    const confirmed = await c.call<Status>('onboarding.confirm', {
      candidateId: 'adopted.shopify_erp_order_sync',
      responsibilitiesVersion: shopifyFlow(found).responsibilities.version,
    });
    expect(confirmed.status).toBe('activating');
    const [integ] = await h.dbh.db
      .select()
      .from(integrations)
      .where(eq(integrations.id, shopifyFlow(confirmed).integrationId!));
    expect(integ).toMatchObject({
      lifecycle: 'setup',
      enabled: true,
      flowType: 'adopted.shopify_erp_order_sync.netsuite',
    });

    // interrupted activation: one step, then a fresh driver resumes without repeating work
    const tenantId = integ!.tenantId;
    await activate(tenantId, 1);
    const states = await activate(tenantId);
    expect(states.pop()).toBe('done:managed');
    expect(shop.state.subscriptions).toEqual([
      expect.objectContaining({
        topic: 'ORDERS_CREATE',
        callbackUrl: `${base}/webhooks/shopify/${integ!.id}`,
      }),
    ]);

    const managed = await c.call<Status>('onboarding.status');
    expect(managed.status).toBe('managed');
    expect(shopifyFlow(managed).activation!.baseline).toMatchObject({
      checked: 6,
      accountedFor: 6,
      previouslyDelivered: 6,
      missing: 0,
      unresolved: 0,
      outcome: 'consistent',
    });
    const [after] = await h.dbh.db.select().from(integrations).where(eq(integrations.id, integ!.id));
    expect(after!.lifecycle).toBe('active');
    const portfolio = await c.call<{ integrations: { id: string; status: { code: string } }[] }>(
      'portfolio.list',
    );
    expect(portfolio.integrations).toEqual([
      expect.objectContaining({ id: integ!.id, status: expect.objectContaining({ code: 'protected' }) }),
    ]);
    // history is recorded with its provenance, never as something we executed
    const hist = await h.dbh.db.select().from(deliveries).where(eq(deliveries.integrationId, integ!.id));
    expect(hist).toHaveLength(6);
    expect(
      hist.every((d) => d.attempts === 0 && (d.validation as { origin: string }).origin === 'baseline'),
    ).toBe(true);

    // a new order now reaches us through the subscription Shopify (fixture) calls, and runs once
    const fresh = shop.control.upsertOrder({
      email: 'buyer@northwind.test',
      lineItems: [{ sku: 'SKU-RED', title: 'Part', quantity: 2, unitPrice: '10.00' }],
    });
    let job: { id: string; data: { deliveryId: string; trigger: never } } | undefined;
    for (let i = 0; i < 50 && !job; i++) {
      [job] = (await boss.fetch(QUEUES.adoptedExecute)) as never[];
      if (!job) await new Promise((r) => setTimeout(r, 100));
    }
    expect(job).toBeTruthy();
    const ex = await executeDelivery({
      db: h.dbh.db,
      cipher: testCipher,
      endpoints: h.endpoints,
      deliveryId: job!.data.deliveryId,
      trigger: { kind: 'webhook' },
    });
    expect(ex).toMatchObject({ executed: true, outcome: 'delivered' });
    expect(
      [...h.netsuite.state.salesOrders.values()].filter((s) => s.externalId === `shopify-${fresh.legacyId}`),
    ).toHaveLength(1);

    // already managed: discovery does not start over
    expect((await c.call<Status>('onboarding.discover')).status).toBe('managed');
    // the customer's decisions in the happy path
    expect(c.actions).toEqual([
      'sign up',
      'connect Shopify (shop name)',
      'approve in Shopify',
      'connect NetSuite (account, client id, certificate id)',
      'upload the certificate in NetSuite',
      'verify NetSuite',
      'confirm: maintain this integration',
    ]);
    const confirmAudit = await h.dbh.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'onboarding.confirmed'));
    expect(confirmAudit).toHaveLength(1);
  });

  it('ambiguous discovery offers understandable choices and refuses to adopt an unrecognized integration', async () => {
    await setup();
    const orders = history(6);
    const theirs = await existingDeployment(h);
    for (const o of orders.slice(0, 3)) await theirs.process(shop.control.webhookPayload(o));
    // another integration writes the other orders under its own reference scheme
    for (const o of orders.slice(3))
      h.netsuite.control.insertForeignSalesOrder({
        externalId: `SO-${o.name.replace('#', '')}`,
        otherRefNum: o.name,
      });
    const c = await customer();
    await c.connectShopify();
    await c.connectNetSuite();
    const d = await c.call<Status>('onboarding.discover');
    expect(d.status).toBe('select');
    expect(shopifyFlow(d).discovery!.outcome).toBe('ambiguous');
    expect(shopifyFlow(d).discovery!.candidates.map((x) => x.kind)).toEqual([
      'adoptable',
      'unsupported',
      'new',
    ]);
    expect(shopifyFlow(d).discovery!.candidates[0]!.confidence).toBe('partial');
    const unsupported = shopifyFlow(d).discovery!.candidates[1]!;
    await expect(
      c.call('onboarding.confirm', { candidateId: unsupported.id, responsibilitiesVersion: 'r1' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      (
        await c.call<Status>('onboarding.confirm', {
          candidateId: 'adopted.shopify_erp_order_sync',
          responsibilitiesVersion: 'r1',
        })
      ).status,
    ).toBe('activating');
  });

  it('nothing found: the supported integration can be selected and starts from now', async () => {
    await setup();
    history(3); // orders exist, but no integration ever wrote them to NetSuite
    const c = await customer();
    await c.connectShopify();
    await c.connectNetSuite();
    const d = await c.call<Status>('onboarding.discover');
    expect(d.status).toBe('select');
    expect(shopifyFlow(d).discovery).toMatchObject({ outcome: 'not_found' });
    expect(shopifyFlow(d).discovery!.candidates.map((x) => x.id)).toEqual(['new.shopify_orders_netsuite']);
    const conf = await c.call<Status>('onboarding.confirm', {
      candidateId: 'new.shopify_orders_netsuite',
      responsibilitiesVersion: 'r1',
    });
    const [integ] = await h.dbh.db
      .select()
      .from(integrations)
      .where(eq(integrations.id, shopifyFlow(conf).integrationId!));
    expect((await activate(integ!.tenantId)).pop()).toBe('done:managed');
    // the 3 old orders are not treated as missing (the integration did not exist then)
    expect(shopifyFlow(await c.call<Status>('onboarding.status')).activation!.baseline).toMatchObject({
      missing: 0,
      checked: 0,
    });
  });

  it('denied permission: without the order scope Shopify is not connected and nothing proceeds', async () => {
    await setup();
    const c = await customer();
    const where = await c.connectShopify({ scope: 'read_products' });
    expect(where).toMatch(/^\/app\/welcome\?error=/);
    expect(decodeURIComponent(where!)).toMatch(/read_orders scope was not granted/);
    await c.connectNetSuite();
    expect((await c.call<Status>('onboarding.discover')).status).toBe('connect');
    const [conn] = await h.dbh.db.select().from(connections).where(eq(connections.providerId, 'shopify'));
    expect(conn!.status).not.toBe('authorized');
  });

  it('tenant isolation: another customer sees only their own onboarding and cannot confirm someone else’s', async () => {
    await setup();
    history(3);
    const theirs = await existingDeployment(h);
    for (const o of shop.state.orders.values()) await theirs.process(shop.control.webhookPayload(o));
    const a = await customer('a@northwind.test');
    await a.connectShopify();
    await a.connectNetSuite();
    expect((await a.call<Status>('onboarding.discover')).status).toBe('confirm');
    const b = await customer('b@elsewhere.test');
    const bs = await b.call<Status>('onboarding.status');
    expect(bs).toMatchObject({ status: 'connect', integrations: [] });
    await expect(
      b.call('onboarding.confirm', {
        candidateId: 'adopted.shopify_erp_order_sync',
        responsibilitiesVersion: 'r1',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      await h.dbh.db
        .select()
        .from(integrations)
        .where(eq(integrations.flowType, 'adopted.shopify_erp_order_sync.netsuite')),
    ).toHaveLength(0);
  });
});
