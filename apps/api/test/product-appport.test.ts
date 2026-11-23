/**
 * SLICE 4 boundary tests: the customer product capabilities over the real API (UI client and MCP),
 * observing a maintenance event produced by the real lifecycle (not seeded).
 */
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createClient } from '@appport/client';
import { createHttpTransport } from '@appport/transport-http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adoptedClients, scanReconciliation, startReconciliation } from '@mi/adopted-order-sync';
import { integrations, users } from '@mi/database';
import { loadServiceConfig } from '@mi/integration-shopify-netsuite';
import { buildApp } from '../src/app.ts';
import { hashPassword } from '../src/auth.ts';
import { ensureQueues } from '../src/queues.ts';
import {
  createHarness,
  FAST_RETRY,
  TEST_DB_URL,
  testCipher,
  type Harness,
} from '../../../test/support/harness.ts';
import { attachAdoptedTenant } from '../../../test/support/adopted.ts';
import { maintenanceKit } from '../../../test/support/maintenance.ts';

let h: Harness;
let a: Awaited<ReturnType<typeof attachAdoptedTenant>>;
let app: FastifyInstance;
let boss: PgBoss;
let base: string;
let kit: ReturnType<typeof maintenanceKit>;
let clients: Awaited<ReturnType<typeof adoptedClients>>;
let eventId: string;
const PW = 'correct horse battery';

beforeAll(async () => {
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
  kit = maintenanceKit(h, a, clients);
  const config = loadServiceConfig('api', {
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB_URL,
    CREDENTIAL_ENCRYPTION_KEYS: `k1:${randomBytes(32).toString('base64')}`,
    SHOPIFY_CLIENT_ID: h.shopify.clientId,
    SHOPIFY_CLIENT_SECRET: 'fixture-shopify-client-secret',
  });
  (config as { cipher: unknown }).cipher = testCipher;
  boss = new PgBoss({ connectionString: TEST_DB_URL, schema: 'pgboss_product' });
  await boss.start();
  await ensureQueues(boss);
  app = await buildApp({ db: h.dbh.db, boss, config, logLevel: 'silent' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const pw = await hashPassword(PW);
  await h.dbh.db.insert(users).values([
    { email: 'ops@bluewave.test', passwordHash: pw, role: 'customer', tenantId: a.tenantId },
    { email: 'customer@acme.test', passwordHash: pw, role: 'customer', tenantId: h.tenantId },
    { email: 'operator@mi.test', passwordHash: pw, role: 'operator' },
  ]);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await h?.close();
});

async function cookie(email: string) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  });
  return (r.headers.get('set-cookie') ?? '').split(';')[0]!;
}
async function ui(c: string) {
  const client = createClient({
    transport: createHttpTransport({ url: `${base}/appport`, headers: { cookie: c } }),
  });
  await client.connect();
  await client.load();
  return client;
}
async function mcp(c: string) {
  const client = new Client({ name: 'product-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { cookie: c } } }),
  );
  return client;
}
type ToolResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
};
const json = (r: ToolResult) =>
  (r.structuredContent ?? JSON.parse(r.content?.find((x) => x.type === 'text')?.text ?? 'null')) as Record<
    string,
    unknown
  >;
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};
type Portfolio = {
  integrations: { id: string; status: { code: string; reason: string; definition: string } }[];
};
type Ev = {
  state: string;
  headline: string;
  facts: { label: string; value: string }[];
  claim: { zeroLoss: boolean; statement: string | null };
  customerAction: { required: boolean };
};
const statusOf = async (c: Awaited<ReturnType<typeof ui>>) =>
  ((await c.call('portfolio.list', {})) as Portfolio).integrations.find((i) => i.id === a.integrationId)!
    .status;

describe('customer product through AppPort', () => {
  it('status is not optimistic: no recent check → "checking"; a completed, consistent check → "protected"', async () => {
    const c = await ui(await cookie('ops@bluewave.test'));
    expect((await statusOf(c)).code).toBe('checking');
    for (const o of [kit.shopifyOrder(), kit.shopifyOrder('SKU-BLUE', '7.25')]) await kit.webhook(o.legacyId);
    expect((await statusOf(c)).code).toBe('checking'); // deliveries succeeding is not evidence of completeness
    const s = await startReconciliation(h.dbh.db, { integrationId: a.integrationId, trigger: 'manual' });
    await scanReconciliation({ db: h.dbh.db, runId: s.runId, workerId: 'w', clients, retry: FAST_RETRY });
    const st = await statusOf(c);
    expect(st).toMatchObject({
      code: 'protected',
      reason: expect.stringMatching(/checked 2 order\(s\).*all accounted for/),
    });
  });

  it('a provider change opens a maintenance event; the customer sees "maintaining" and no premature claim', async () => {
    a.shopify.control.setWebhookVersion('2027-01');
    const r = await kit.webhook(kit.shopifyOrder('SKU-RED', '12.50').legacyId);
    await kit.webhook(kit.shopifyOrder('SKU-BLUE', '7.25').legacyId);
    kit.shopifyOrder('SKU-RED', '9.99'); // lost webhook
    eventId = r.finding!.incidentId;
    const c = await ui(await cookie('ops@bluewave.test'));
    expect((await statusOf(c)).code).toBe('maintaining');
    const ev = (await c.call('maintenance.events.get', { eventId })) as Ev;
    expect(ev).toMatchObject({
      state: 'in_progress',
      claim: { zeroLoss: false, statement: null },
      customerAction: { required: false },
    });
    expect(ev.facts.find((f) => f.label === 'Change detected')!.value).toMatch(
      /2026-10 → 2027-01.*unit price of each order line/,
    );
    expect(ev.facts.find((f) => f.label === 'Transactions affected')!.value).toBe('Being established.');
    // operators still see the operational detail, including the held orders
    const op = await ui(await cookie('operator@mi.test'));
    const list = (await op.call('deliveries.list', { integrationId: a.integrationId })) as {
      counts: Record<string, number>;
    };
    expect(list.counts['held']).toBe(2);
  });

  it('after the lifecycle resolves it, the customer sees the verified outcome and a proven zero-loss claim (test 16)', async () => {
    const { inc } = await kit.drive(eventId);
    expect(inc.status).toBe('resolved');
    const c = await ui(await cookie('ops@bluewave.test'));
    expect((await statusOf(c)).code).toBe('verified');
    const ev = (await c.call('maintenance.events.get', { eventId })) as Ev & {
      accounting: Record<string, number>;
    };
    expect(ev).toMatchObject({
      state: 'completed',
      headline: 'We resolved a compatibility issue',
      claim: { zeroLoss: true, statement: 'Zero transactions lost.' },
      customerAction: { required: false },
    });
    const fact = (l: string) => ev.facts.find((f) => f.label === l)!.value;
    expect(fact('Transactions affected')).toMatch(
      /^3: 2 orders held and delayed; 1 order whose notification never reached us/,
    );
    expect(fact('Transactions recovered')).toBe('3 of 3.');
    expect(fact('Final outcome')).toMatch(/^All 4 orders .* exactly once/);
    expect(fact('Customer action')).toBe('None required.');
    // the numbers on screen are the persisted accounting, not text
    expect(ev.accounting).toMatchObject({
      ordersInWindow: 4,
      delayed: 2,
      foundByChecking: 1,
      recovered: 3,
      verified: 4,
      unresolved: 0,
      duplicates: 0,
    });
    const detail = (await c.call('portfolio.integration', { integrationId: a.integrationId })) as {
      responsibilities: string[];
      maintenance: { id: string; zeroLoss: boolean }[];
    };
    expect(detail.responsibilities.length).toBeGreaterThanOrEqual(4);
    expect(detail.maintenance.find((m) => m.id === eventId)).toMatchObject({ zeroLoss: true });
  });

  it('customer (UI client) and operator (MCP) see the same authoritative outcome; evidence is operator-only (test 19)', async () => {
    const customer = await ui(await cookie('ops@bluewave.test'));
    const viaCustomer = await customer.call('maintenance.events.get', { eventId });
    const m = await mcp(await cookie('operator@mi.test'));
    const viaOperator = json(
      (await m.callTool({ name: 'maintenance_events_get', arguments: { eventId } })) as ToolResult,
    );
    const evidence = json(
      (await m.callTool({ name: 'maintenance_events_evidence', arguments: { eventId } })) as ToolResult,
    );
    await m.close();
    expect(viaOperator).toEqual(viaCustomer);
    expect(evidence['event']).toEqual(viaCustomer);
    expect(evidence).toMatchObject({
      kind: 'input_contract_change',
      status: 'resolved',
      finding: expect.objectContaining({ observed: expect.objectContaining({ apiVersion: '2027-01' }) }),
      validation: expect.objectContaining({ passed: true }),
      accounting: expect.objectContaining({ zeroLoss: true }),
    });
    expect(await code(customer.call('maintenance.events.evidence', { eventId }))).toBe('FORBIDDEN');
  });

  it('tenant isolation: another tenant cannot see the event or the integration (test 18)', async () => {
    const acme = await ui(await cookie('customer@acme.test'));
    expect(await code(acme.call('maintenance.events.get', { eventId }))).toBe('FORBIDDEN');
    expect(await code(acme.call('portfolio.integration', { integrationId: a.integrationId }))).toBe(
      'FORBIDDEN',
    );
    const own = (await acme.call('portfolio.list', {})) as Portfolio;
    expect(own.integrations.map((i) => i.id)).toEqual([h.integrationId]);
    const m = await mcp(await cookie('customer@acme.test'));
    const r = (await m.callTool({ name: 'maintenance_events_get', arguments: { eventId } })) as ToolResult;
    await m.close();
    expect(r.isError).toBe(true);
  });

  it('nothing on the AppPort surface can write maintenance state (test 15, boundary side)', async () => {
    const m = await mcp(await cookie('operator@mi.test'));
    const tools = (await m.listTools()).tools;
    await m.close();
    const maint = tools
      .filter((t) => /^(maintenance|portfolio)_/.test(t.name))
      .map((t) => t.name)
      .sort();
    expect(maint).toEqual([
      'maintenance_events_evidence',
      'maintenance_events_get',
      'portfolio_integration',
      'portfolio_list',
    ]);
    expect(tools.map((t) => t.name).some((n) => /incident|resolve/.test(n))).toBe(false);
  });
});
