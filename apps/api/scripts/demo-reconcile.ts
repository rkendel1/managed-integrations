/**
 * SLICE 3 demonstration — reconciliation and missing-delivery recovery for the ADOPTED flow, against
 * the RUNNING stack (make up). Every inspection and action goes through an MCP client calling AppPort
 * capabilities. Providers are the DETERMINISTIC FIXTURES (Bluewave's store is the second Shopify
 * fixture on :4011, NetSuite is the NetSuite fixture), not Shopify or NetSuite.
 *
 * Proves an order that never entered the webhook delivery system is detected by reading Shopify
 * independently, recovered through the adopted upstream code, and verified in NetSuite.
 *
 *   docker compose ... exec -T api pnpm exec tsx apps/api/scripts/demo-reconcile.ts
 */
import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  auditLog,
  createDb,
  deliveries,
  deliveryAttempts,
  reconciliationItems,
  webhookReceipts,
} from '@mi/database';

const API = process.env.DEMO_API_URL ?? 'http://127.0.0.1:3000';
const SHOP_URL = process.env.DEMO_ADOPTED_SHOPIFY_URL ?? 'http://fixtures:4011';
const NETSUITE = process.env.NETSUITE_BASE_URL_OVERRIDE ?? 'http://fixtures:4020';
const SECRET = process.env.SHOPIFY_CLIENT_SECRET ?? 'fixture-shopify-client-secret';
const SHOP = 'bluewave-supply.myshopify.com';
const t0 = Date.now();
const evidence: {
  steps: { n: number; title: string; data: unknown }[];
  startedAt: string;
  providers: string;
} = {
  steps: [],
  startedAt: new Date().toISOString(),
  providers: 'deterministic fixtures (not Shopify or NetSuite)',
};
const step = (n: number, title: string, data: unknown = {}) => {
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${String(n).padStart(2)}. ${title}`);
  evidence.steps.push({ n, title, data });
};
const fail = (msg: string): never => {
  console.error(`FAILED: ${msg}`);
  process.exit(1);
};
const wait = async <T>(what: string, fn: () => Promise<T | undefined | false>, ms = 120_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
};
const json = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, init);
  if (!r.ok) fail(`${init?.method ?? 'GET'} ${url} → ${r.status}`);
  return r.json() as Promise<unknown>;
};

async function login(email: string, password: string) {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) fail(`login ${email}: ${r.status}`);
  return (r.headers.get('set-cookie') ?? '').split(';')[0]!;
}
async function mcp(cookie: string) {
  const client = new Client({ name: 'slice3-demo', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${API}/mcp`), { requestInit: { headers: { cookie } } }),
  );
  const call = async <T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: true; data: T } | { ok: false; error: string }> => {
    const r = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: unknown;
      content?: { type: string; text?: string }[];
    };
    const text = r.content?.find((c) => c.type === 'text')?.text ?? '';
    if (r.isError) return { ok: false, error: text || JSON.stringify(r) };
    return { ok: true, data: (r.structuredContent ?? JSON.parse(text)) as T };
  };
  return { client, call };
}
const must = <T>(r: { ok: true; data: T } | { ok: false; error: string }, what: string): T =>
  r.ok ? r.data : fail(`${what}: ${r.error}`);

type Run = {
  id: string;
  status: string;
  outcome: string | null;
  discovered: number;
  counts: Record<string, number>;
  recovery: Record<string, number>;
  windowFrom: string;
  windowTo: string;
};
type Item = {
  sourceOrderId: string;
  order: string;
  classification: string;
  reason: string | null;
  recoveryState: string;
  recoverable: boolean;
  verifiedDestinationId: string | null;
};
type SalesOrder = { id: string; externalId: string; otherRefNum?: string };

await wait('API readiness', async () => (await fetch(`${API}/readyz`).catch(() => null))?.ok);
await wait(
  "Bluewave's fixture store",
  async () => (await fetch(`${SHOP_URL}/__fixture/state`).catch(() => null))?.ok,
);
const bw = await mcp(
  await login('ops@bluewave.test', process.env.SEED_ADOPTED_CUSTOMER_PASSWORD || 'bluewave-demo-password'),
);
const integ = must(
  await bw.call<{ integrations: { id: string; flowId: string }[] }>('integrations_list', {}),
  'integrations_list',
).integrations.find((i) => i.flowId.startsWith('adopted.'));
if (!integ) fail('Bluewave has no adopted integration — run `make reset` first');
const integrationId = integ!.id;
const tag = randomBytes(2).toString('hex').toUpperCase();
const createdAt = new Date(Date.now() - 60_000).toISOString();
const newOrder = (name: string) =>
  json(`${SHOP_URL}/__fixture/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      createdAt,
      updatedAt: createdAt,
      email: 'buyer@bluewave.test',
      lineItems: [{ sku: 'SKU-RED', title: 'Part', quantity: 2, unitPrice: '12.50' }],
    }),
  }) as Promise<{ legacyId: string; name: string }>;
const salesOrders = async () =>
  ((await json(`${NETSUITE}/__fixture/state`)) as { salesOrders: SalesOrder[] }).salesOrders;
const inNetSuite = async (legacyId: string) =>
  (await salesOrders()).filter((s) => s.externalId === `shopify-${legacyId}`);

// 1. An order delivered normally: it exists in Bluewave's store and Shopify's webhook arrives.
const a = await newOrder(`#R${tag}-1`);
const payload = await json(`${SHOP_URL}/__fixture/orders/${a.legacyId}/webhook-payload`);
const raw = Buffer.from(JSON.stringify(payload));
const wh = await fetch(`${API}/webhooks/shopify/${integrationId}`, {
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
await wait(`order ${a.name} delivered by webhook`, async () => (await inNetSuite(a.legacyId)).length === 1);
step(
  1,
  `Order ${a.name} created in Shopify; its webhook was received (${wh.status}) and delivered to NetSuite by the adopted code`,
  {
    legacyId: a.legacyId,
    netsuite: await inNetSuite(a.legacyId),
  },
);

// 2-3. An order whose webhook is never sent.
const b = await newOrder(`#R${tag}-2`);
const bGid = `gid://shopify/Order/${b.legacyId}`;
step(2, `Order ${b.name} created in Shopify; NO webhook is sent (simulated lost delivery)`, {
  legacyId: b.legacyId,
});
if ((await inNetSuite(b.legacyId)).length !== 0) fail('NetSuite unexpectedly already has the missed order');
step(3, `NetSuite has no sales order for ${b.name} (externalId shopify-${b.legacyId})`);

// 4. Reconciliation through AppPort.
const start = must(
  await bw.call<{ runId: string; deduplicated: boolean; windowFrom: string; windowTo: string }>(
    'reconciliation_start',
    { integrationId },
  ),
  'reconciliation_start',
);
const run1 = await wait('reconciliation run 1 to finish', async () => {
  const r = must(
    await bw.call<{ runs: Run[] }>('reconciliation_runs', { integrationId }),
    'reconciliation_runs',
  ).runs.find((x) => x.id === start.runId);
  return r && r.status !== 'running' ? r : undefined;
});
step(
  4,
  `reconciliation_start (MCP) → run ${run1.id}: ${run1.status}/${run1.outcome}, ${run1.discovered} Shopify orders read in window ${run1.windowFrom} → ${run1.windowTo}`,
  run1,
);

// 5. Classification.
const items1 = must(
  await bw.call<{ items: Item[] }>('reconciliation_items', { runId: run1.id }),
  'reconciliation_items',
).items;
const ia = items1.find((i) => i.sourceOrderId === `gid://shopify/Order/${a.legacyId}`);
const ib = items1.find((i) => i.sourceOrderId === bGid);
if (ia?.classification !== 'delivered') fail(`${a.name} classified ${ia?.classification}`);
if (ib?.classification !== 'missing_delivery' || !ib.recoverable)
  fail(`${b.name} classified ${ib?.classification}`);
step(5, `${a.name} → delivered; ${b.name} → missing_delivery (“${ib!.reason}”)`, {
  delivered: ia,
  missing: ib,
});

// 6. Recovery through AppPort.
const rec = must(
  await bw.call<{ accepted: unknown[]; refused: unknown[] }>('reconciliation_recover', {
    runId: run1.id,
    sourceOrderIds: [bGid],
    reason: 'Webhook never arrived (demo)',
  }),
  'reconciliation_recover',
);
if (rec.accepted.length !== 1) fail(`recovery not accepted: ${JSON.stringify(rec)}`);
step(6, `reconciliation_recover (MCP) for ${b.name}: accepted`, rec);

// 7-9. Executed by the adopted code; NetSuite contains it; verified.
const done = await wait('recovery to finish', async () => {
  const i = must(
    await bw.call<{ items: Item[] }>('reconciliation_items', { runId: run1.id }),
    'reconciliation_items',
  ).items.find((x) => x.sourceOrderId === bGid);
  return i && !['requested', 'executing'].includes(i.recoveryState) ? i : undefined;
});
const { db, close } = createDb(process.env.DATABASE_URL!, { max: 1 });
const [item] = await db
  .select()
  .from(reconciliationItems)
  .where(and(eq(reconciliationItems.runId, run1.id), eq(reconciliationItems.sourceOrderId, bGid)));
const attempts = item?.deliveryId
  ? await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.deliveryId, item.deliveryId))
  : [];
const [del] = item?.deliveryId
  ? await db.select().from(deliveries).where(eq(deliveries.id, item.deliveryId))
  : [];
const inputs = del?.receiptId
  ? await db
      .select({ origin: webhookReceipts.origin, disposition: webhookReceipts.disposition })
      .from(webhookReceipts)
      .where(eq(webhookReceipts.id, del.receiptId))
  : [];
step(
  7,
  `Executed by the adopted upstream code: ${attempts.map((x) => `attempt ${x.attemptNo} ${x.outcome} via ${x.implementationVersionId}`).join('; ')} (input origin: ${inputs[0]?.origin}/${inputs[0]?.disposition})`,
  { attempts, input: inputs[0] },
);
const ns = await inNetSuite(b.legacyId);
if (ns.length !== 1) fail(`NetSuite has ${ns.length} sales orders for ${b.name}`);
step(8, `NetSuite contains exactly one sales order for ${b.name}: id ${ns[0]!.id}`, ns);
if (done.recoveryState !== 'recovered' || done.verifiedDestinationId !== ns[0]!.id)
  fail(`recovery state ${done.recoveryState}`);
step(
  9,
  `Verified by reading NetSuite back after execution: recovery ${done.recoveryState}, destination ${done.verifiedDestinationId}`,
  item?.verification,
);

// 10. A second run classifies the recovered order as delivered.
const start2 = must(
  await bw.call<{ runId: string }>('reconciliation_start', { integrationId }),
  'reconciliation_start #2',
);
const run2 = await wait('reconciliation run 2 to finish', async () => {
  const r = must(
    await bw.call<{ runs: Run[] }>('reconciliation_runs', { integrationId }),
    'reconciliation_runs',
  ).runs.find((x) => x.id === start2.runId);
  return r && r.status !== 'running' ? r : undefined;
});
const ib2 = must(
  await bw.call<{ items: Item[] }>('reconciliation_items', { runId: run2.id }),
  'reconciliation_items',
).items.find((i) => i.sourceOrderId === bGid);
if (ib2?.classification !== 'delivered') fail(`second run classified ${b.name} as ${ib2?.classification}`);
step(10, `Second run ${run2.id}: ${b.name} → delivered`, { run: run2, item: ib2 });

// 11. A duplicate recovery is refused (both on the old run and the new one); NetSuite still has one.
const dup1 = must(
  await bw.call<{ accepted: unknown[]; refused: { reason: string }[] }>('reconciliation_recover', {
    runId: run1.id,
    sourceOrderIds: [bGid],
    reason: 'duplicate attempt (demo)',
  }),
  'dup1',
);
const dup2 = must(
  await bw.call<{ accepted: unknown[]; refused: { reason: string }[] }>('reconciliation_recover', {
    runId: run2.id,
    sourceOrderIds: [bGid],
    reason: 'duplicate attempt (demo)',
  }),
  'dup2',
);
if (dup1.accepted.length || dup2.accepted.length) fail('duplicate recovery accepted');
if ((await inNetSuite(b.legacyId)).length !== 1) fail('duplicate sales order');
step(
  11,
  `Duplicate recovery refused: “${dup1.refused[0]?.reason}” / “${dup2.refused[0]?.reason}”; NetSuite still has exactly one`,
  { dup1, dup2 },
);

// 12. Another tenant is refused.
const acme = await mcp(
  await login(
    process.env.SEED_CUSTOMER_EMAIL || 'customer@acme.test',
    process.env.SEED_CUSTOMER_PASSWORD || 'customer-demo-password',
  ),
);
const x1 = await acme.call('reconciliation_items', { runId: run1.id });
const x2 = await acme.call('reconciliation_recover', {
  runId: run1.id,
  sourceOrderIds: [bGid],
  reason: 'cross-tenant attempt (demo)',
});
const x3 = await acme.call('reconciliation_start', { integrationId });
if (x1.ok || x2.ok || x3.ok) fail('cross-tenant call allowed');
step(
  12,
  'Acme (another tenant) is refused reconciliation_items / reconciliation_recover / reconciliation_start on Bluewave',
  {
    items: (x1 as { error: string }).error.slice(0, 200),
    recover: (x2 as { error: string }).error.slice(0, 200),
    start: (x3 as { error: string }).error.slice(0, 200),
  },
);
await acme.client.close();
await bw.client.close();

const audit = await db
  .select({ action: auditLog.action, n: sql<number>`count(*)::int` })
  .from(auditLog)
  .where(
    inArray(auditLog.action, [
      'reconciliation.requested',
      'reconciliation.recovery_requested',
      'appport.invocation',
    ]),
  )
  .groupBy(auditLog.action);
await close();
evidence.steps.push({ n: 13, title: 'Audit evidence (all-time counts)', data: audit });
console.log(`         evidence: ${audit.map((r) => `${r.action}=${r.n}`).join(' · ')}`);

const out = process.env.DEMO_EVIDENCE_DIR ?? '/data/artifacts/evidence';
await mkdir(out, { recursive: true });
const file = `${out}/demo-reconcile-${Date.now()}.json`;
await writeFile(file, JSON.stringify(evidence, null, 2));
console.log(`DONE in ${((Date.now() - t0) / 1000).toFixed(0)}s — evidence: ${file}`);
