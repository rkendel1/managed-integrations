/**
 * SLICE 6 demonstration, against the RUNNING stack (make reset first): the second integration —
 * Stripe → QuickBooks, the adopted open-source ledgerly — on the same product mechanisms as Shopify → NetSuite.
 *
 *   B1–B2  adoption: pinned upstream source and provenance (operator, MCP)
 *   B3–B6  a customer whose Stripe payments already reach QuickBooks through their own ledgerly deployment
 *          signs up, connects Stripe (key) and QuickBooks (OAuth), we discover the integration, they confirm,
 *          a baseline is verified and management becomes active
 *   B7–B8  a new payment is booked through the notification endpoint we registered; independent verification
 *   P1–P3  a provider retired a dependency (QuickBooks minor versions < 75): reviewed patch validated by the
 *          system, switched on by an operator (MCP), verified on real work
 *   B9–B10 failure: QuickBooks authorization lost — transactions held, the customer reconnects, held and missed
 *          transactions booked and verified; zero loss proven from persisted accounting
 *
 * Every provider is a DETERMINISTIC FIXTURE (Stripe on :4030, QuickBooks on :4040).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LEDGERLY, LEDGERLY_FLOW_TYPE, pinnedSource } from '@mi/adopted-ledgerly';
import { pinnedDrift } from '@mi/managed';
import { theirLedgerly } from '../../../test/support/stripe-quickbooks.ts';

const API = process.env.DEMO_API_URL ?? 'http://127.0.0.1:3000';
const STRIPE = process.env.STRIPE_BASE_URL_OVERRIDE ?? 'http://fixtures:4030';
const QBO = process.env.QBO_BASE_URL_OVERRIDE ?? 'http://fixtures:4040';
/** The fixture's key is read from the fixture itself (no key-shaped literal in the repository). */
let STRIPE_KEY = process.env.DEMO_STRIPE_KEY ?? '';
const t0 = Date.now();
const evidence: {
  steps: { n: string; title: string; data: unknown }[];
  startedAt: string;
  providers: string;
} = {
  steps: [],
  startedAt: new Date().toISOString(),
  providers: 'deterministic fixtures (not Stripe or QuickBooks), modelled on their public documentation',
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
const wait = async <T>(what: string, fn: () => Promise<T | undefined | false>, ms = 240_000): Promise<T> => {
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
  const client = new Client({ name: 'slice6-demo', version: '1.0.0' });
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
type Je = { DocNumber?: string; Line: { Amount: number; JournalEntryLineDetail: { PostingType: string } }[] };
const qboState = async () =>
  (await (await fetch(`${QBO}/__fixture/state`)).json()) as {
    realmId: string;
    journalEntries: Je[];
    requestLog: { method: string; path: string; minorRequested: number | null; minorServed: number | null }[];
  };
const entriesFor = async (eventId: string) =>
  (await qboState()).journalEntries.filter((e) => e.DocNumber === eventId.slice(-21));
type Flow = {
  flowType: string;
  status: string;
  discovery: {
    outcome: string;
    checked: number;
    candidates: { id: string; kind: string; summary: string; confidence: string | null }[];
  } | null;
  responsibilities: { version: string; maintain: string[]; access: string[] };
  activation: { baseline: Record<string, number | string> | null } | null;
  integrationId: string | null;
};
type Overall = { status: string; next: string; integrations: Flow[] };
const stripeFlow = (o: Overall) => o.integrations.find((i) => i.flowType === LEDGERLY_FLOW_TYPE);

await wait('API readiness', async () => (await fetch(`${API}/readyz`).catch(() => null))?.ok);
await wait(
  'the Stripe and QuickBooks fixtures',
  async () =>
    (await fetch(`${STRIPE}/__fixture/state`).catch(() => null))?.ok &&
    (await fetch(`${QBO}/__fixture/state`).catch(() => null))?.ok,
);

STRIPE_KEY ||= ((await (await fetch(`${STRIPE}/__fixture/state`)).json()) as { apiKey: string }).apiKey;

/* ---------------- B1. adoption: pinned source and provenance ---------------- */
const drift = pinnedDrift(pinnedSource());
step(
  'B1',
  `Adopted ${LEDGERLY.repository} @ ${LEDGERLY.commit.slice(0, 12)} (${LEDGERLY.license}); ${Object.keys(LEDGERLY.fileSha256).length} executed files hash-pinned; installed copy matches: ${drift.length === 0}`,
  {
    repository: LEDGERLY.repository,
    commit: LEDGERLY.commit,
    license: LEDGERLY.license,
    entryPoints: LEDGERLY.entryPoints,
  },
);
if (drift.length) fail('installed upstream differs from the pin');

/* ---------------- before: the customer's own ledgerly deployment books their payments ---------------- */
const realmId = ((await qboState()) as { realmId: string }).realmId;
const theirs = await theirLedgerly({
  stripeUrl: STRIPE,
  stripeKey: STRIPE_KEY,
  qboUrl: QBO,
  qboClientId: process.env.QBO_CLIENT_ID ?? 'qbo-fixture-client',
  qboClientSecret: process.env.QBO_CLIENT_SECRET ?? 'qbo-fixture-secret',
  realmId,
});
const hist: string[] = [];
for (const [path, body] of [
  ['charge', { amount: 12_000, daysAgo: 4 }],
  ['charge', { amount: 4_900, daysAgo: 3 }],
  ['invoice', { amount: 2_900, daysAgo: 3 }],
  ['charge', { amount: 26_500, daysAgo: 2 }],
  ['payout', { amount: 30_000, daysAgo: 1 }],
] as const) {
  const r = (await post(`${STRIPE}/__fixture/${path}`, body)) as { eventId: string; chargeEventId?: string };
  if (r.chargeEventId) await theirs.process(r.chargeEventId);
  await theirs.process(r.eventId);
  hist.push(r.eventId);
}
step(
  'B0',
  `Before: Lumen Studio's own ledgerly deployment booked ${hist.length} Stripe transactions in QuickBooks (the pinned upstream code, with their own QuickBooks authorization)`,
);

/* ---------------- B3–B6. onboarding ---------------- */
const tag = randomBytes(2).toString('hex');
const actions: string[] = [];
const su = await fetch(`${API}/api/auth/signup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    company: 'Lumen Studio',
    email: `finance+${tag}@lumen.test`,
    password: 'lumen-demo-password',
  }),
});
if (!su.ok) fail(`signup ${su.status}`);
actions.push('sign up');
const cookie = (su.headers.get('set-cookie') ?? '').split(';')[0]!;
const H = { cookie, 'x-csrf-token': ((await su.json()) as { csrfToken: string }).csrfToken };
const customer = await mcp(cookie);
actions.push('connect Stripe (restricted key)');
const sc = await post(`${API}/api/customer/connections/stripe`, { apiKey: STRIPE_KEY }, H);
step('B3', `Stripe connected with a restricted key → ${String(sc['status'])} (${String(sc['account'])})`);
async function connectQuickBooks() {
  const start = (await post(`${API}/api/customer/connections/quickbooks/authorize`, {}, H)) as {
    url: string;
  };
  const approve = await fetch(start.url, { redirect: 'manual' }); // Intuit (fixture) approval → redirect
  const cb = new URL(approve.headers.get('location')!);
  return (await fetch(`${API}${cb.pathname}${cb.search}`, { redirect: 'manual' })).headers.get('location');
}
actions.push('connect QuickBooks', 'approve in QuickBooks');
show(`QuickBooks connected through OAuth → back to ${await connectQuickBooks()}`);

const found = stripeFlow(await customer<Overall>('onboarding_discover'))!;
if (found.status !== 'confirm') fail(`discovery: ${found.status} ${JSON.stringify(found.discovery)}`);
const cand = found.discovery!.candidates[0]!;
step('B4', `Discovered: ${cand.summary} (confidence: ${cand.confidence})`, found.discovery);
show(
  `We will maintain: ${found.responsibilities.maintain.length} responsibilities · access: ${found.responsibilities.access.join(' | ')}`,
);
actions.push('confirm: maintain this integration');
await customer<Overall>('onboarding_confirm', {
  candidateId: cand.id,
  responsibilitiesVersion: found.responsibilities.version,
  flowType: LEDGERLY_FLOW_TYPE,
});
const managed = await wait('management to become active', async () => {
  const f = stripeFlow(await customer<Overall>('onboarding_status'));
  return f?.status === 'managed' ? f : undefined;
});
const b = managed.activation!.baseline!;
step(
  'B5',
  `Baseline: ${b['checked']} recent Stripe transactions checked, ${b['accountedFor']} in QuickBooks (${b['previouslyDelivered']} written by their earlier deployment), ${b['missing']} missing`,
  b,
);
const integrationId = managed.integrationId!;
step('B6', `Under management. Customer actions (${actions.length}): ${actions.join(' → ')}`);

/* ---------------- B7–B8. execution and independent verification ---------------- */
const pay = (await post(`${STRIPE}/__fixture/charge`, { amount: 8_800, fee: 285 })) as { eventId: string };
const [je] = await wait('the new payment to be booked', async () => {
  const e = await entriesFor(pay.eventId);
  return e.length ? e : undefined;
});
const sum = (t: string) =>
  je!.Line.filter((l) => l.JournalEntryLineDetail.PostingType === t).reduce((a, l) => a + l.Amount, 0);
step(
  'B7',
  `New payment ${pay.eventId} booked once by the adopted code: debits ${sum('Debit').toFixed(2)} = credits ${sum('Credit').toFixed(2)} (net 85.15 + fee 2.85 = 88.00)`,
);
const run = await customer<{ runId: string }>('reconciliation_start', { integrationId });
const checked = await wait('the independent check', async () => {
  const r = await customer<{
    runs: { id: string; status: string; outcome: string | null; discovered: number; matched?: number }[];
  }>('reconciliation_runs', { integrationId });
  const x = r.runs.find((y) => y.id === run.runId);
  return x?.status === 'completed' ? x : undefined;
});
step(
  'B8',
  `Independent check (Stripe Events API vs QuickBooks entries: once, balanced, amounts equal Stripe): ${checked.outcome}`,
  checked,
);

/* ---------------- P1–P3. a dependency the provider retired: reviewed patch, operator decision ---------------- */
const operator = await mcp(
  await login(
    process.env.SEED_OPERATOR_EMAIL || 'operator@managed-integrations.test',
    process.env.SEED_OPERATOR_PASSWORD || 'operator-demo-password',
  ),
);
type Inspect = {
  running: { id: string };
  contracts: { path: string; reads: { file: string; line: number }[] }[];
  adaptations: {
    id: string;
    kind: string;
    status: string;
    history: { to: string }[];
    validation: {
      checks: { name: string; status: string }[];
      postActivation: Record<string, unknown> | null;
    } | null;
  }[];
};
const validated = await wait(
  'the reviewed patch to be validated by maintenance (the worker tick checks dependencies)',
  async () => {
    const x = await operator<Inspect>('adaptations_inspect', { integrationId });
    const a = x.adaptations.find((r) => r.kind === 'patch');
    return a?.status === 'validated' ? { x, a } : undefined;
  },
);
const mv = validated.x.contracts.find((c) => c.path === 'quickbooks.minorversion')!;
step(
  'P1',
  `Detected: the running code (${validated.x.running.id}) requests QuickBooks minorversion 70 at ${mv.reads.map((r) => `${r.file}:${r.line}`).join(', ')}; Intuit serves 75 since 2025-08-01`,
);
show(`Validation: ${validated.a.validation!.checks.map((c) => `${c.name} ${c.status}`).join('; ')}`);
await operator('adaptations_activate', {
  adaptationId: validated.a.id,
  reason: 'Reviewed: declare the minor version QuickBooks serves',
});
const pay2 = (await post(`${STRIPE}/__fixture/charge`, { amount: 3_100 })) as { eventId: string };
await wait('the next payment on the patched code', async () => (await entriesFor(pay2.eventId)).length === 1);
const active = await wait('the correction to be verified after activation', async () => {
  const x = await operator<Inspect>('adaptations_inspect', { integrationId });
  const a = x.adaptations.find((r) => r.id === validated.a.id)!;
  return a.validation?.postActivation ? { x, a } : undefined;
});
const lastPost = (await qboState()).requestLog
  .filter((r) => r.method === 'POST' && r.path.endsWith('/journalentry'))
  .at(-1)!;
step(
  'P2',
  `Operator switched the patch on (MCP adaptations_activate): ${active.a.history.map((h) => h.to).join(' → ')}; now running ${active.x.running.id}`,
  active.a,
);
step(
  'P3',
  `QuickBooks request now declares minorversion ${lastPost.minorRequested} (served ${lastPost.minorServed}); after activation: ${JSON.stringify(active.a.validation!.postActivation)}`,
);

/* ---------------- B9–B10. failure: QuickBooks authorization lost ---------------- */
await post(`${QBO}/__fixture/revoke`, {});
const held = (await post(`${STRIPE}/__fixture/charge`, { amount: 15_000 })) as { eventId: string };
type Portfolio = { integrations: { id: string; status: { code: string; reason: string } }[] };
const needs = await wait('the customer to be asked', async () => {
  const p = await customer<Portfolio>('portfolio_list');
  const i = p.integrations.find((x) => x.id === integrationId);
  return i?.status.code === 'customer_action' ? i : undefined;
});
await post(`${STRIPE}/__fixture/drop-webhooks`, { n: 1 });
const lost = (await post(`${STRIPE}/__fixture/charge`, { amount: 2_200 })) as { eventId: string };
step(
  'B9',
  `FIXTURE: Intuit revokes the QuickBooks authorization. Customer sees "${needs.status.reason}"; ${held.eventId} is held (not lost); a further notification is lost in transit (${lost.eventId})`,
);
show(
  `In QuickBooks while access is down: ${(await entriesFor(held.eventId)).length} entries for the held payment`,
);
actions.length = 0;
show(`Customer reconnects QuickBooks → ${await connectQuickBooks()}`);
type Ev = {
  id: string;
  state: string;
  headline: string;
  summary: string;
  facts: { label: string; value: string }[];
  claim: { zeroLoss: boolean; statement: string | null };
};
const eventId = await wait('the maintenance event to resolve', async () => {
  const d = await customer<{ maintenance: { id: string; category: string; state: string }[] }>(
    'portfolio_integration',
    { integrationId },
  );
  const e = d.maintenance.find((m) => m.category === 'Access');
  return e?.state === 'completed' ? e.id : undefined;
});
const ev = await customer<Ev>('maintenance_events_get', { eventId });
step('B10', `"${ev.headline}" — ${ev.summary}`, ev);
for (const f of ev.facts) show(`• ${f.label}: ${f.value}`);
if (!ev.claim.zeroLoss) fail('zero loss not proven');
for (const e of [held.eventId, lost.eventId])
  if ((await entriesFor(e)).length !== 1) fail(`${e} not booked exactly once`);
show(`Both transactions are in QuickBooks exactly once. Claim: ${ev.claim.statement}`);

const mon = await operator<{
  monitoring: { health: string; signals: { signal: string; state: string }[] } | null;
}>('monitoring_integration', { integrationId });
step(
  'B11',
  `Operator monitoring (durable facts): health ${mon.monitoring?.health ?? 'not probed yet'}; ${
    mon.monitoring?.signals
      .filter((s) => s.state !== 'not_monitored')
      .map((s) => `${s.signal}=${s.state}`)
      .join(', ') ?? ''
  }`,
);

const out = process.env.DEMO_EVIDENCE_DIR ?? '/data/artifacts/evidence';
await mkdir(out, { recursive: true });
const file = `${out}/demo-stripe-${Date.now()}.json`;
await writeFile(file, JSON.stringify(evidence, null, 2));
console.log(`\nDONE in ${Math.round((Date.now() - t0) / 1000)}s — evidence: ${file}`);
process.exit(0);
