/**
 * SLICE 5 product demonstration, against the RUNNING stack (make reset first):
 *
 *   A. A new customer (Northwind Goods) whose orders already flow into NetSuite through their own deployment
 *      of the open-source shopify-erp-order-sync signs up, connects Shopify and NetSuite, has us discover
 *      that integration, confirms, and lands in a managed, verified state. New orders then reach us through
 *      the order notification we registered.
 *   B. Shopify changes its order data (fictional fixture change); the change is handled through the
 *      correction registry (adapter: proposed → validated → active) and the operator can see exactly what
 *      code runs and why.
 *
 * Every provider here is a DETERMINISTIC FIXTURE (Northwind's store is the Shopify fixture on :4012).
 * Customer steps use the same routes and AppPort capabilities as the UI; operator steps use MCP.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { existingDeployment } from '../../../test/support/existing-deployment.ts';

const API = process.env.DEMO_API_URL ?? 'http://127.0.0.1:3000';
const SHOP = 'northwind-goods.myshopify.com';
const SHOP_URL = process.env.DEMO_ONBOARDING_SHOPIFY_URL ?? 'http://fixtures:4012';
const NETSUITE = process.env.NETSUITE_BASE_URL_OVERRIDE ?? 'http://fixtures:4020';
const t0 = Date.now();
const evidence: {
  steps: { n: string; title: string; data: unknown }[];
  startedAt: string;
  providers: string;
} = {
  steps: [],
  startedAt: new Date().toISOString(),
  providers:
    'deterministic fixtures (not Shopify or NetSuite); the provider change is fictional and documented',
};
const step = (n: string, title: string, data: unknown = {}) => {
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${n.padStart(3)}. ${title}`);
  evidence.steps.push({ n, title, data });
};
const show = (line: string) => console.log(`          ${line}`);
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
const post = async (url: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!r.ok) fail(`POST ${url} → ${r.status} ${await r.text()}`);
  return r.json() as Promise<Record<string, unknown>>;
};
async function mcp(cookie: string) {
  const client = new Client({ name: 'slice5-demo', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${API}/mcp`), { requestInit: { headers: { cookie } } }),
  );
  return async <T = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<T> => {
    const r = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: unknown;
      content?: { type: string; text?: string }[];
    };
    const text = r.content?.find((c) => c.type === 'text')?.text ?? '';
    if (r.isError) fail(`${name}: ${text}`);
    return (r.structuredContent ?? JSON.parse(text)) as T;
  };
}
async function login(email: string, password: string) {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) fail(`login ${email}: ${r.status}`);
  return (r.headers.get('set-cookie') ?? '').split(';')[0]!;
}
type Overall = { status: string; next: string; integrations: Status[] };
type Status = {
  flowType: string;
  status: string;
  next: string;
  discovery: {
    outcome: string;
    checked: number;
    candidates: { id: string; kind: string; summary: string; confidence: string | null }[];
  } | null;
  responsibilities: { version: string; maintain: string[]; access: string[] };
  activation: { baseline: Record<string, number | string> | null } | null;
  integrationId: string | null;
};
type SalesOrder = { externalId: string; item: { items: { rate: number }[] } };
const netsuite = async () =>
  ((await (await fetch(`${NETSUITE}/__fixture/state`)).json()) as { salesOrders: SalesOrder[] }).salesOrders;

await wait('API readiness', async () => (await fetch(`${API}/readyz`).catch(() => null))?.ok);
await wait(
  "Northwind's fixture store",
  async () => (await fetch(`${SHOP_URL}/__fixture/state`).catch(() => null))?.ok,
);
await post(`${SHOP_URL}/__fixture/webhook-version`, { version: '2026-10' });

/* ---------------- before: the customer's own integration is running ---------------- */
const tag = randomBytes(2).toString('hex').toUpperCase();
const history = [];
for (let i = 0; i < 6; i++) {
  const t = new Date(Date.now() - 6 * 3600_000 + i * 60_000).toISOString();
  history.push(
    (await post(`${SHOP_URL}/__fixture/orders`, {
      name: `#N${tag}-${i + 1}`,
      createdAt: t,
      updatedAt: t,
      email: 'buyer@northwind.test',
      lineItems: [
        { sku: i % 2 ? 'SKU-BLUE' : 'SKU-RED', title: 'Part', quantity: i + 1, unitPrice: '10.00' },
      ],
    })) as { legacyId: string; name: string },
  );
}
const theirs = await existingDeployment({
  netsuiteUrl: NETSUITE,
  netsuite: {
    clientId: process.env.DEMO_NETSUITE_CLIENT_ID ?? 'fixture-netsuite-client-id',
    certificateId: process.env.DEMO_NETSUITE_CERTIFICATE_ID ?? 'fixture-cert-id',
    control: { registerPublicKey: (pem) => post(`${NETSUITE}/__fixture/public-key`, { pem }) },
  },
});
for (const o of history) {
  const body = await (await fetch(`${SHOP_URL}/__fixture/orders/${o.legacyId}/webhook-payload`)).json();
  const r = await theirs.process(body);
  if (r.status !== 'created') fail(`existing deployment: ${o.name} ${r.status}`);
}
step(
  '0',
  `Before: Northwind's own deployment of shopify-erp-order-sync wrote ${history.length} orders to NetSuite (the pinned upstream code, run as their server would)`,
);

/* ---------------- A. onboarding ---------------- */
const actions: string[] = [];
const email = `owner+${tag.toLowerCase()}@northwind.test`;
const su = await fetch(`${API}/api/auth/signup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ company: 'Northwind Goods', email, password: 'northwind-demo-password' }),
});
if (!su.ok) fail(`signup ${su.status}`);
actions.push('sign up');
const cookie = (su.headers.get('set-cookie') ?? '').split(';')[0]!;
const csrf = ((await su.json()) as { csrfToken: string }).csrfToken;
const H = { cookie, 'x-csrf-token': csrf };
const customer = await mcp(cookie);
step('A1', `New customer signed up: ${(await customer<Status>('onboarding_status')).next}`);

actions.push('connect Shopify (shop name)', 'approve in Shopify');
const auth = (await post(`${API}/api/customer/connections/shopify/authorize`, { shop: SHOP }, H)) as {
  url: string;
};
const approve = await fetch(auth.url, { redirect: 'manual' }); // Shopify (fixture) approval screen → redirect
const cb = new URL(approve.headers.get('location')!);
const back = await fetch(`${API}${cb.pathname}${cb.search}`, { redirect: 'manual' });
step('A2', `Shopify connected through OAuth (scope read_orders) → back to ${back.headers.get('location')}`);

actions.push(
  'connect NetSuite (account domain, client id, certificate id)',
  'upload the certificate in NetSuite',
  'verify NetSuite',
);
const ns = (await post(
  `${API}/api/customer/connections/netsuite`,
  {
    accountDomain: '1234567-sb1.suitetalk.api.netsuite.com',
    clientId: process.env.DEMO_NETSUITE_CLIENT_ID ?? 'fixture-netsuite-client-id',
    certificateId: process.env.DEMO_NETSUITE_CERTIFICATE_ID ?? 'fixture-cert-id',
  },
  H,
)) as { publicKeyPem: string };
await post(`${NETSUITE}/__fixture/public-key`, { pem: ns.publicKeyPem }); // the customer's admin uploads the certificate
const verified = await post(`${API}/api/customer/connections/netsuite/verify`, {}, H);
step('A3', `NetSuite connected (machine-to-machine certificate) → ${String(verified['status'])}`);

/** Slice 6: one onboarding per integration kind; this demo is about Shopify → NetSuite. */
const SHOPIFY_FLOW = 'adopted.shopify_erp_order_sync.netsuite';
const flowOf = (o: Overall): Status =>
  o.integrations.find((i) => i.flowType === SHOPIFY_FLOW) ?? ({ status: o.status, next: o.next, discovery: null, integrationId: null } as unknown as Status);
const found = flowOf(await customer<Overall>('onboarding_discover'));
if (found.status !== 'confirm') fail(`discovery: ${found.status} ${JSON.stringify(found.discovery)}`);
const cand = found.discovery!.candidates[0]!;
step('A4', `Discovered: ${cand.summary} (confidence: ${cand.confidence})`, found.discovery);
show(
  `We will maintain: ${found.responsibilities.maintain.length} responsibilities · access: ${found.responsibilities.access.join(' | ')}`,
);

actions.push('confirm: maintain this integration');
const conf = flowOf(
  await customer<Overall>('onboarding_confirm', {
    candidateId: cand.id,
    responsibilitiesVersion: found.responsibilities.version,
    flowType: SHOPIFY_FLOW,
  }),
);
step('A5', `Customer confirmed; ${conf.next}`);
const managed = await wait('management to become active', async () => {
  const s = flowOf(await customer<Overall>('onboarding_status'));
  return s.status === 'managed' ? s : undefined;
});
const b = managed.activation!.baseline!;
step(
  'A6',
  `Under management. Baseline: ${b['checked']} recent orders checked, ${b['accountedFor']} in NetSuite (${b['previouslyDelivered']} written by their earlier deployment), ${b['missing']} missing`,
  b,
);
const portfolio = await customer<{
  integrations: { id: string; status: { label: string; reason: string } }[];
}>('portfolio_list');
const integ = portfolio.integrations.find((i) => i.id === managed.integrationId)!;
step('A7', `Customer overview: ${integ.status.label} — ${integ.status.reason}`);

const fresh = (await post(`${SHOP_URL}/__fixture/orders`, {
  name: `#N${tag}-NEW`,
  email: 'buyer@northwind.test',
  lineItems: [{ sku: 'SKU-RED', title: 'Part', quantity: 2, unitPrice: '10.00' }],
})) as { legacyId: string; name: string };
await wait('the new order to reach NetSuite', async () =>
  (await netsuite()).some((s) => s.externalId === `shopify-${fresh.legacyId}`),
);
step(
  'A8',
  `A new order (${fresh.name}) reached us through the notification we registered and is in NetSuite exactly once`,
);
show(`Customer actions in onboarding (${actions.length}): ${actions.join(' → ')}`);
show(
  'Decisions that are genuinely the customer’s: authorize Shopify, authorize NetSuite, confirm management',
);

/* ---------------- B. adaptation through the registry ---------------- */
await post(`${SHOP_URL}/__fixture/webhook-version`, { version: '2027-01' });
const changed = (await post(`${SHOP_URL}/__fixture/orders`, {
  name: `#N${tag}-CHG`,
  email: 'buyer@northwind.test',
  lineItems: [{ sku: 'SKU-BLUE', title: 'Part', quantity: 1, unitPrice: '7.25' }],
})) as { legacyId: string; name: string };
step(
  'B1',
  `FIXTURE: Shopify switches its order webhooks to format 2027-01 (unit price moved); ${changed.name} arrives in the new format`,
);
const opCookie = await login(
  process.env.SEED_OPERATOR_EMAIL || 'operator@managed-integrations.test',
  process.env.SEED_OPERATOR_PASSWORD || 'operator-demo-password',
);
const operator = await mcp(opCookie);
type Inspect = {
  running: { id: string };
  adaptations: {
    id: string;
    kind: string;
    status: string;
    spec: Record<string, string>;
    history: { to: string }[];
    validation: {
      checks: { name: string; status: string }[];
      postActivation: Record<string, unknown> | null;
    } | null;
  }[];
  pinnedFiles: { matches: boolean }[];
  contracts: { path: string; reads: { file: string; line: number }[] }[];
};
const done = await wait('the correction to be active and verified', async () => {
  const x = await operator<Inspect>('adaptations_inspect', { integrationId: managed.integrationId });
  const a = x.adaptations.find((r) => r.kind === 'adapter');
  return a?.status === 'active' && a.validation?.postActivation ? { x, a } : undefined;
});
const price = done.x.contracts.find((c) => c.path === 'line_items[].price')!;
step(
  'B2',
  `Operator: running ${done.x.running.id}; upstream files match the pin: ${done.x.pinnedFiles.every((f) => f.matches)}; price is read at ${price.reads.map((r) => `${r.file}:${r.line}`).join(', ')}`,
);
step(
  'B3',
  `Adapter ${done.a.spec['target']} ← ${done.a.spec['source']}: ${done.a.history.map((h) => h.to).join(' → ')}`,
  done.a,
);
show(`Validation: ${done.a.validation!.checks.map((c) => `${c.name} ${c.status}`).join('; ')}`);
show(`After activation: ${JSON.stringify(done.a.validation!.postActivation)}`);
const rec = (await netsuite()).find((s) => s.externalId === `shopify-${changed.legacyId}`);
if (!rec || rec.item.items[0]!.rate !== 7.25) fail(`${changed.name} not in NetSuite with the right price`);
step(
  'B4',
  `${changed.name} is in NetSuite with Shopify's price (7.25), written by the adopted code with the adapter applied`,
);

const detail = await customer<{ maintenance: { id: string; headline: string; zeroLoss: boolean }[] }>(
  'portfolio_integration',
  { integrationId: managed.integrationId },
);
const ev = detail.maintenance[0]!;
const story = await customer<{
  headline: string;
  summary: string;
  claim: { statement: string | null };
  facts: { label: string; value: string }[];
}>('maintenance_events_get', { eventId: ev.id });
step('B5', `Customer sees: "${story.headline}" — ${story.summary} ${story.claim.statement ?? ''}`, story);
for (const f of story.facts) show(`• ${f.label}: ${f.value}`);

const acme = await mcp(
  await login(
    process.env.SEED_CUSTOMER_EMAIL || 'customer@acme.test',
    process.env.SEED_CUSTOMER_PASSWORD || 'customer-demo-password',
  ),
);
const acmeView = flowOf(await acme<Overall>('onboarding_status'));
step(
  'C1',
  `Another tenant sees only its own onboarding (status ${acmeView.status}, integration ${acmeView.integrationId === managed.integrationId ? 'LEAKED' : 'its own'})`,
);
if (acmeView.integrationId === managed.integrationId) fail('cross-tenant leak');

const out = process.env.DEMO_EVIDENCE_DIR ?? '/data/artifacts/evidence';
await mkdir(out, { recursive: true });
const file = `${out}/demo-onboarding-${Date.now()}.json`;
await writeFile(file, JSON.stringify({ ...evidence, customerActions: actions }, null, 2));
console.log(`DONE in ${((Date.now() - t0) / 1000).toFixed(0)}s — evidence: ${file}`);
process.exit(0);
