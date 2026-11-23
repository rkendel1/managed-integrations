/**
 * SLICE 4 product demonstration, against the RUNNING stack (make reset first). It shows the customer
 * product, not the implementation: every customer step is what Bluewave sees through AppPort (MCP here;
 * the UI calls the same capabilities), and operator evidence is shown to substantiate it.
 *
 * Providers are the DETERMINISTIC FIXTURES. The provider change is a controlled, fictional change made at
 * the fixture boundary (webhook payload version 2027-01 without line_items[].price, documented in
 * docs/provider-docs/shopify/FIXTURE-webhook-changelog.md). Everything after it — detection, investigation,
 * correction, validation, recovery, verification, accounting and the customer story — is done by the
 * running worker; this script only sends Shopify's webhooks (or withholds one) and observes.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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
  providers:
    'deterministic fixtures (not Shopify or NetSuite); the provider change is fictional and documented',
};
const step = (n: number, title: string, data: unknown = {}) => {
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${String(n).padStart(2)}. ${title}`);
  evidence.steps.push({ n, title, data });
};
const show = (line: string) => console.log(`         ${line}`);
const fail = (msg: string): never => {
  console.error(`FAILED: ${msg}`);
  process.exit(1);
};
const wait = async <T>(what: string, fn: () => Promise<T | undefined | false>, ms = 180_000): Promise<T> => {
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
  const client = new Client({ name: 'slice4-demo', version: '1.0.0' });
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

type Status = { code: string; label: string; reason: string; definition: string };
type Card = { id: string; name: string; process: string; status: Status; customerActions: string[] };
type Ev = {
  id: string;
  state: string;
  headline: string;
  summary: string;
  facts: { label: string; value: string }[];
  accounting: Record<string, unknown> | null;
  claim: { zeroLoss: boolean; statement: string | null; basis: string };
  customerAction: { required: boolean; text: string | null };
};
type SalesOrder = { id: string; externalId: string; item: { items: { rate: number; quantity: number }[] } };

await wait('API readiness', async () => (await fetch(`${API}/readyz`).catch(() => null))?.ok);
await wait(
  "Bluewave's fixture store",
  async () => (await fetch(`${SHOP_URL}/__fixture/state`).catch(() => null))?.ok,
);
await json(`${SHOP_URL}/__fixture/webhook-version`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"version":"2026-10"}',
});

const customer = await mcp(
  await login('ops@bluewave.test', process.env.SEED_ADOPTED_CUSTOMER_PASSWORD || 'bluewave-demo-password'),
);
const operator = await mcp(
  await login(
    process.env.SEED_OPERATOR_EMAIL || 'operator@managed-integrations.test',
    process.env.SEED_OPERATOR_PASSWORD || 'operator-demo-password',
  ),
);
const portfolio = async () =>
  must(await customer.call<{ integrations: Card[] }>('portfolio_list', {}), 'portfolio_list').integrations;
const integ = (await portfolio()).find((i) => i.name.includes('adopted') || i.process.includes('Shopify'));
if (!integ) fail('Bluewave has no integration — run `make reset` first');
const integrationId = integ!.id;

const tag = randomBytes(2).toString('hex').toUpperCase();
let seq = 0;
async function newOrder(sku: string, price: string, qty = 2) {
  seq += 1;
  const createdAt = new Date(Date.now() - 30_000 + seq * 100).toISOString();
  return (await json(`${SHOP_URL}/__fixture/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `#P${tag}-${seq}`,
      createdAt,
      updatedAt: createdAt,
      email: 'buyer@bluewave.test',
      lineItems: [{ sku, title: 'Part', quantity: qty, unitPrice: price }],
    }),
  })) as { legacyId: string; name: string; lineItems: { unitPrice: string }[] };
}
/** Shopify sends the order's webhook, in the payload version it currently uses. */
async function sendWebhook(legacyId: string) {
  const r = await fetch(`${SHOP_URL}/__fixture/orders/${legacyId}/webhook-payload`);
  const version = r.headers.get('x-shopify-api-version') ?? '';
  const raw = Buffer.from(JSON.stringify(await r.json()));
  const res = await fetch(`${API}/webhooks/shopify/${integrationId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': createHmac('sha256', SECRET).update(raw).digest('base64'),
      'x-shopify-shop-domain': SHOP,
      'x-shopify-topic': 'orders/create',
      'x-shopify-webhook-id': `demo-${randomBytes(6).toString('hex')}`,
      'x-shopify-api-version': version,
    },
    body: raw,
  });
  return { status: res.status, version };
}
const netsuite = async () =>
  ((await json(`${NETSUITE}/__fixture/state`)) as { salesOrders: SalesOrder[] }).salesOrders;
const inNetSuite = async (legacyId: string) =>
  (await netsuite()).filter((s) => s.externalId === `shopify-${legacyId}`);

/* 1. the normal customer experience */
const normal = [await newOrder('SKU-RED', '12.50'), await newOrder('SKU-BLUE', '7.25')];
for (const o of normal) await sendWebhook(o.legacyId);
await wait('normal orders delivered', async () =>
  (await Promise.all(normal.map((o) => inNetSuite(o.legacyId)))).every((r) => r.length === 1),
);
const check = must(
  await operator.call<{ runId: string }>('reconciliation_start', { integrationId }),
  'reconciliation_start',
);
await wait('completeness check', async () => {
  const runs = must(
    await operator.call<{ runs: { id: string; status: string }[] }>('reconciliation_runs', { integrationId }),
    'runs',
  ).runs;
  return runs.find((r) => r.id === check.runId && r.status !== 'running');
});
const s1 = (await portfolio()).find((i) => i.id === integrationId)!.status;
if (s1.code !== 'protected') fail(`expected protected, got ${s1.code}: ${s1.reason}`);
step(1, `Customer sees "${integ!.name}" — ${s1.label}: ${s1.reason}`, s1);
show(`(${s1.label} means: ${s1.definition})`);

/* 2. a real provider change, at the fixture boundary */
await json(`${SHOP_URL}/__fixture/webhook-version`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"version":"2027-01"}',
});
const delayed = [await newOrder('SKU-RED', '12.50', 3), await newOrder('SKU-BLUE', '7.25', 1)];
const sent = [];
for (const o of delayed) sent.push(await sendWebhook(o.legacyId));
const lost = await newOrder('SKU-RED', '9.99', 4); // Shopify never delivers this one's webhook
step(
  2,
  `FIXTURE: Shopify switches its order webhooks to format 2027-01 (unit price moved). ${delayed.length} new orders arrive (${sent.map((x) => `${x.status}/${x.version}`).join(', ')}); a 3rd order's notification is lost.`,
  {
    delayed: delayed.map((o) => o.name),
    lost: lost.name,
  },
);

/* 3–5. detection, the affected integration and scope, the event */
const event = await wait(
  'maintenance event',
  async () => {
    const d = must(
      await customer.call<{ maintenance: { id: string; category: string; detectedAt: string }[] }>(
        'portfolio_integration',
        { integrationId },
      ),
      'portfolio_integration',
    );
    return d.maintenance.find((m) => m.category === 'Provider change' && Date.parse(m.detectedAt) >= t0);
  },
  60_000,
);
const ev0 = must(
  await operator.call<{ finding: Record<string, unknown>; event: Ev }>('maintenance_events_evidence', {
    eventId: event.id,
  }),
  'evidence',
);
const f = ev0.finding as {
  observed: { apiVersion: string; violations: { path: string }[] };
  expected: { baseline: { apiVersion: string } | null };
  shapeDiff: { removed: string[] };
  dependency: { integrationId: string };
};
step(
  3,
  `Detected: order webhook format ${f.expected.baseline?.apiVersion} → ${f.observed.apiVersion}; removed ${f.shapeDiff.removed.join(', ')} (read by the adopted code)`,
  ev0.finding,
);
if (f.dependency.integrationId !== integrationId) fail('wrong integration identified');
step(
  4,
  `Affected integration identified (${integ!.name}); scope: orders arriving in the new format are held, not written`,
  { integrationId },
);
step(5, `Maintenance event created — customer sees: "${ev0.event.headline}" (${ev0.event.state})`, ev0.event);

/* 6–9. investigation, correction, validation, recovery, verification — all by the worker */
const done = await wait('maintenance to complete', async () => {
  const e = must(await customer.call<Ev>('maintenance_events_get', { eventId: event.id }), 'event');
  return e.state === 'completed' ? e : undefined;
});
const ev = must(
  await operator.call<{
    investigation: {
      codePaths: { reads: { file: string; line: number; code: string; matchesPinnedCommit: boolean }[] }[];
      risk: string;
    };
    correction: {
      rules: { target: string; source: string }[];
      configVersion: number;
      upstreamModified: boolean;
    };
    validation: { passed: boolean; checks: { name: string; passed: boolean; detail: string }[] };
    accounting: {
      orders: { order: string; category: string; verified: boolean }[];
      duplicates: number;
      zeroLoss: boolean;
      populationComplete: boolean;
    };
    reconciliationRuns: { role: string; outcome: string | null }[];
    event: Ev;
  }>('maintenance_events_evidence', { eventId: event.id }),
  'evidence',
);
const read = ev.investigation.codePaths[0]!.reads[0]!;
step(
  6,
  `Investigated: ${read.file}:${read.line} \`${read.code}\` (pinned: ${read.matchesPinnedCommit}). ${ev.investigation.risk}`,
  ev.investigation,
);
step(
  7,
  `Corrected at the adoption boundary: ${ev.correction.rules.map((r) => `${r.target} ← ${r.source}`).join('; ')} (configuration v${ev.correction.configVersion}; upstream modified: ${ev.correction.upstreamModified})`,
  ev.correction,
);
if (!ev.validation.passed) fail('validation did not pass');
step(
  8,
  `Validated before activation: ${ev.validation.checks.map((c) => `${c.name} ✓ (${c.detail})`).join('; ')}`,
  ev.validation,
);
// Proof from durable attempt records that the changed orders were held (no NetSuite write) before the fix.
const dl = must(
  await operator.call<{ deliveries: { id: string; order: string }[] }>('deliveries_list', { integrationId }),
  'deliveries_list',
).deliveries;
for (const o of delayed) {
  const d = dl.find((x) => x.order === o.name);
  if (!d) fail(`${o.name}: no delivery`);
  const g = must(
    await operator.call<{
      attempts: { attemptNo: number; outcome: string; trigger: { kind: string } | null }[];
    }>('deliveries_get', { deliveryId: d!.id }),
    'deliveries_get',
  );
  const first = g.attempts[0];
  if (first?.outcome !== 'held') fail(`${o.name}: first attempt was ${first?.outcome}, not held`);
  show(
    `${o.name}: ${g.attempts.map((x) => `attempt ${x.attemptNo} ${x.outcome}${x.trigger ? ` (${x.trigger.kind})` : ''}`).join(' → ')}`,
  );
}
const recovered = ev.accounting.orders.filter((o) =>
  ['delayed', 'discovered', 'failed'].includes(o.category),
);
step(
  9,
  `Recovered ${recovered.length} order(s): ${recovered.map((o) => `${o.order} (${o.category})`).join(', ')}`,
  recovered,
);

/* 10–11. verification of destination records, zero duplicates */
const all = [...normal, ...delayed, lost];
const ns = await netsuite();
for (const o of all) {
  const recs = ns.filter((s) => s.externalId === `shopify-${o.legacyId}`);
  if (recs.length !== 1) fail(`${o.name}: ${recs.length} NetSuite records`);
  if (recs[0]!.item.items[0]!.rate !== Number(o.lineItems[0]!.unitPrice))
    fail(`${o.name}: wrong rate ${recs[0]!.item.items[0]!.rate}`);
}
const ids = ns.map((s) => s.externalId);
step(
  10,
  `Verified independently (${ev.reconciliationRuns.map((r) => `${r.role} run: ${r.outcome}`).join(', ')}): every order in the affected period is in NetSuite with Shopify's items, quantities and prices`,
  ev.accounting,
);
step(
  11,
  `Zero duplicates: NetSuite holds ${ids.length} sales orders, ${new Set(ids).size} distinct externalIds; accounting duplicates = ${ev.accounting.duplicates}`,
  { total: ids.length, distinct: new Set(ids).size },
);

/* 12. what the customer sees */
if (!done.claim.zeroLoss) fail(`no zero-loss claim: ${done.claim.basis}`);
const s2 = (await portfolio()).find((i) => i.id === integrationId)!.status;
step(12, `Customer sees the completed event and status "${s2.label}" — no intervention was asked for`, {
  status: s2,
  event: done,
});
show('');
show(`  ${done.headline}`);
show(`  ${integ!.name}`);
show(`  ${done.summary}`);
for (const x of done.facts) show(`  • ${x.label}: ${x.value}`);
show(`  ${done.claim.statement}`);
show('');
if (done.customerAction.required) fail('customer action was required');
if (JSON.stringify(ev.event) !== JSON.stringify(done)) fail('operator and customer views disagree');
show('Operator evidence (maintenance_events_evidence) embeds the identical customer projection.');

const acme = await mcp(
  await login(
    process.env.SEED_CUSTOMER_EMAIL || 'customer@acme.test',
    process.env.SEED_CUSTOMER_PASSWORD || 'customer-demo-password',
  ),
);
const denied = await acme.call('maintenance_events_get', { eventId: event.id });
if (denied.ok) fail('another tenant could read the event');
show(`Another tenant is refused: ${(denied as { error: string }).error.slice(0, 80)}`);
const later = await newOrder('SKU-BLUE', '7.25');
await sendWebhook(later.legacyId);
await wait('a new order in the new format', async () => (await inNetSuite(later.legacyId)).length === 1);
show(`A new order in the 2027-01 format (${later.name}) now flows normally.`);
for (const c of [customer, operator, acme]) await c.client.close();

const out = process.env.DEMO_EVIDENCE_DIR ?? '/data/artifacts/evidence';
await mkdir(out, { recursive: true });
const file = `${out}/demo-maintenance-${Date.now()}.json`;
await writeFile(file, JSON.stringify(evidence, null, 2));
console.log(`DONE in ${((Date.now() - t0) / 1000).toFixed(0)}s — evidence: ${file}`);
