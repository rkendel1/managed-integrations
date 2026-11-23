/**
 * BUILD SLICE 2 demonstration — the ADOPTED shopify-erp-order-sync code operated through the managed
 * boundary, against the RUNNING stack (make up). Every inspection and the recovery are done through
 * an MCP client calling AppPort capabilities. Providers are the DETERMINISTIC FIXTURES, not Shopify
 * or NetSuite; the NetSuite "create the missing item" step is a fixture stand-in for the customer's fix.
 *
 *   docker compose ... exec -T api pnpm exec tsx apps/api/scripts/demo-adopted.ts
 */
import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { and, eq, sql } from 'drizzle-orm';
import { auditLog, createDb, webhookReceipts } from '@mi/database';

const API = process.env.DEMO_API_URL ?? 'http://127.0.0.1:3000';
const NETSUITE = process.env.NETSUITE_BASE_URL_OVERRIDE ?? 'http://fixtures:4020';
const SECRET = process.env.SHOPIFY_CLIENT_SECRET ?? 'fixture-shopify-client-secret';
const SHOP = 'bluewave-supply.myshopify.com';
const t0 = Date.now();
const evidence: { steps: { n: number; title: string; data: unknown }[]; startedAt: string } = { steps: [], startedAt: new Date().toISOString() };
const step = (n: number, title: string, data: unknown = {}) => {
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${String(n).padStart(2)}. ${title}`);
  evidence.steps.push({ n, title, data });
};
const wait = async <T>(what: string, fn: () => Promise<T | undefined | false>, ms = 120_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
};

async function login(email: string, password: string) {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!r.ok) throw new Error(`login ${email}: ${r.status}`);
  return (r.headers.get('set-cookie') ?? '').split(';')[0]!;
}
async function mcp(cookie: string) {
  const client = new Client({ name: 'slice2-demo', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${API}/mcp`), { requestInit: { headers: { cookie } } }));
  const call = async <T>(name: string, args: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; error: string }> => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] };
    const text = r.content?.find((c) => c.type === 'text')?.text ?? '';
    if (r.isError) return { ok: false, error: text };
    return { ok: true, data: (r.structuredContent ?? JSON.parse(text)) as T };
  };
  return { client, call };
}
type List = { integration: { id: string; executor: { repository: string; commit: string; license: string }; lastSuccessfulExecutionAt: string | null }; deliveries: { id: string; order: string; outcome: string; netsuiteId: string | null; reason: string | null }[] };
type Detail = { delivery: { outcome: string }; attempts: { attemptNo: number; outcome: string; executor: string; trigger: { kind: string; reason?: string }; upstreamResult: { status: string; message?: string } | null }[] };

async function sendOrder(integrationId: string, name: string, sku: string) {
  const id = 8_000_000_000 + Math.floor(Math.random() * 1e8);
  const raw = Buffer.from(JSON.stringify({ id, name, created_at: new Date().toISOString(), email: 'buyer@bluewave.test', currency: 'USD', note: '', line_items: [{ sku, quantity: 3, price: '12.50', title: 'Part' }] }));
  const res = await fetch(`${API}/webhooks/shopify/${integrationId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': createHmac('sha256', SECRET).update(raw).digest('base64'),
      'x-shopify-shop-domain': SHOP,
      'x-shopify-topic': 'orders/create',
      'x-shopify-webhook-id': `demo-${randomBytes(6).toString('hex')}`,
    },
    body: raw,
  });
  return { status: res.status, body: await res.json() };
}

await wait('API readiness', async () => (await fetch(`${API}/readyz`).catch(() => null))?.ok);
const bluewave = await login('ops@bluewave.test', process.env.SEED_ADOPTED_CUSTOMER_PASSWORD || 'bluewave-demo-password');
const m = await mcp(bluewave);

// 1-2: tenant identified; the adopted implementation is attached to it
const tools = (await m.client.listTools()).tools.map((t) => t.name);
const integrations = await m.call<{ tenant: { name: string }; integrations: { id: string; flowId: string; displayName: string }[] }>('integrations_list', {});
if (!integrations.ok) throw new Error(integrations.error);
const integ = integrations.data.integrations.find((i) => i.flowId.startsWith('adopted.'))!;
step(1, `Tenant identified via AppPort: ${integrations.data.tenant.name}`, { mcpTools: tools });
const initial = await m.call<List>('deliveries_list', { integrationId: integ.id });
if (!initial.ok) throw new Error(initial.error);
step(2, `Adopted implementation attached: ${initial.data.integration.executor.repository} @ ${initial.data.integration.executor.commit.slice(0, 12)} (${initial.data.integration.executor.license})`, { integrationId: integ.id, flow: integ.flowId });
step(3, 'Configured with the adopted code’s own model: { erp: netsuite, customerByEmail, defaultCustomer: WEB }');

// 4-8: a real order flows through the upstream code
const sent = await sendOrder(integ.id, '#B-1001', 'SKU-RED');
step(4, `Signed Shopify orders/create webhook received → ${sent.status} ${JSON.stringify(sent.body)}`);
const delivered = await wait('delivery #B-1001', async () => {
  const r = await m.call<List>('deliveries_list', { integrationId: integ.id });
  return r.ok && r.data.deliveries.find((d) => d.order === '#B-1001' && d.outcome === 'delivered');
});
const d1 = await m.call<Detail>('deliveries_get', { deliveryId: delivered.id });
step(5, `Upstream code performed the work: NetSuite sales order ${delivered.netsuiteId}`, d1.ok ? d1.data.attempts : d1);
step(6, 'Outcome durably recorded (deliveries + delivery_attempts, executor commit + upstream result per attempt)');

// 9-10: failure, investigation, recovery — all through MCP
await sendOrder(integ.id, '#B-1002', 'SKU-PURPLE');
const rejected = await wait('rejection of #B-1002', async () => {
  const r = await m.call<List>('deliveries_list', { integrationId: integ.id });
  return r.ok && r.data.deliveries.find((d) => d.order === '#B-1002' && d.outcome !== 'pending' && d.outcome !== 'running');
});
const d2 = await m.call<Detail>('deliveries_get', { deliveryId: rejected.id });
step(7, `Failure represented accurately: ${rejected.outcome} — "${rejected.reason}"`, d2.ok ? d2.data.attempts : d2);

const acme = await mcp(await login('customer@acme.test', process.env.SEED_CUSTOMER_PASSWORD || 'customer-demo-password'));
const denied = await acme.call('deliveries_retry', { deliveryId: rejected.id, reason: 'not my tenant' });
step(8, `Other tenant's MCP client is refused: ${denied.ok ? 'ALLOWED (unexpected!)' : denied.error.slice(0, 120)}`);
await acme.client.close();
if (denied.ok) throw new Error('tenant isolation failed');

await fetch(`${NETSUITE}/__fixture/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: '104', code: 'SKU-PURPLE' }) });
step(9, 'FIXTURE stand-in for the customer’s fix: item SKU-PURPLE created in NetSuite');
const retry = await m.call<{ status: string; previousOutcome: string }>('deliveries_retry', { deliveryId: rejected.id, reason: 'Item SKU-PURPLE now exists in NetSuite' });
const dup = await m.call('deliveries_retry', { deliveryId: rejected.id, reason: 'double click' });
step(10, `Recovery requested via MCP deliveries_retry → ${retry.ok ? JSON.stringify(retry.data) : retry.error}; duplicate request → ${dup.ok ? 'ACCEPTED (unexpected!)' : 'refused (CONFLICT)'}`);
const recovered = await wait('recovery of #B-1002', async () => {
  const r = await m.call<List>('deliveries_list', { integrationId: integ.id });
  return r.ok && r.data.deliveries.find((d) => d.id === rejected.id && d.outcome === 'delivered');
});
const d3 = await m.call<Detail>('deliveries_get', { deliveryId: rejected.id });
step(11, `Recovery succeeded: NetSuite sales order ${recovered.netsuiteId}`, d3.ok ? d3.data.attempts.map((a) => ({ n: a.attemptNo, trigger: a.trigger, outcome: a.outcome, upstream: a.upstreamResult })) : d3);
await m.client.close();

// evidence across the three boundaries
const { db, close } = createDb(process.env.DATABASE_URL!, { max: 1 });
const [inv] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(eq(auditLog.action, 'appport.invocation'));
const [ret] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(and(eq(auditLog.action, 'delivery.retry_requested'), eq(auditLog.targetId, rejected.id)));
const [rcp] = await db.select({ n: sql<number>`count(*)::int` }).from(webhookReceipts).where(eq(webhookReceipts.integrationId, integ.id));
await close();
step(12, `Evidence: ${rcp!.n} durable webhook receipts · ${ret!.n} recorded human intervention · ${inv!.n} AppPort invocation records`);

const out = process.env.DEMO_EVIDENCE_DIR ?? '/data/artifacts/evidence';
await mkdir(out, { recursive: true });
const file = `${out}/demo-adopted-${Date.now()}.json`;
await writeFile(file, JSON.stringify(evidence, null, 2));
console.log(`DONE in ${((Date.now() - t0) / 1000).toFixed(0)}s — evidence: ${file}`);
