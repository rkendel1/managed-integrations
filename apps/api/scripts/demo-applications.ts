/**
 * SLICE 7 demonstration, against the RUNNING stack (make reset first): provider-centric adoption — two real
 * open-source APPLICATIONS that each depend on one provider, adopted and maintained on the shared mechanisms
 * (not wrapped in the Stripe → QuickBooks pipeline).
 *
 *   S1–S3  Stripe-dependent application (stripe-webhooks-subscriptions-node-ts @ 4812d25): discovered by its
 *          webhook endpoint at Stripe; hosted with its own database rebuilt from Stripe's events and verified
 *   S4–S6  Stripe-side change: the endpoint moves to 2025-03-31.basil; the application answers 200 but records
 *          wrong data; detected, reviewed patch validated by replay, switched on by an operator (MCP),
 *          records recovered and verified against Stripe; the customer sees an outcome, no internals
 *   Q1–Q2  QuickBooks-dependent application (quickbooks-mcp @ ce1317e): the customer's agent creates an invoice
 *          through MCP (applications_invoke); one invoice, read back from QuickBooks; a repeat does nothing
 *   Q3     provider-side change: QuickBooks authorization revoked; the request is held, the customer
 *          reconnects, it runs once and the period is verified
 *   Q4     application-side change: upstream v0.12.0 (node-quickbooks 2.0.50) validated by replay, switched on
 *          by an operator, verified on real work, rolled back
 *
 * Every provider is a DETERMINISTIC FIXTURE (Stripe on :4030, QuickBooks on :4040).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { QBO_TOOLS_APP, QBO_TOOLS_FLOW_TYPE, pinnedSource as qboPinned } from '@mi/adopted-qbo-tools';
import { STRIPE_APP_FLOW_TYPE, STRIPE_SUBSCRIPTIONS_APP, pinnedSource as appPinned } from '@mi/adopted-stripe-subscriptions';
import { pinnedDrift } from '@mi/managed';

const API = process.env.DEMO_API_URL ?? 'http://127.0.0.1:3000';
const STRIPE = process.env.STRIPE_BASE_URL_OVERRIDE ?? 'http://fixtures:4030';
const QBO = process.env.QBO_BASE_URL_OVERRIDE ?? 'http://fixtures:4040';
const t0 = Date.now();
const evidence: { steps: { n: string; title: string; data: unknown }[]; startedAt: string; providers: string } = {
  steps: [],
  startedAt: new Date().toISOString(),
  providers: 'deterministic fixtures (not Stripe or QuickBooks), modelled on their public documentation',
};
const step = (n: string, title: string, data: unknown = {}) => {
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${n.padStart(3)}. ${title}`);
  evidence.steps.push({ n, title, data });
};
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
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!r.ok) fail(`POST ${url} → ${r.status} ${await r.text()}`);
  return r.json() as Promise<Record<string, unknown>>;
};
async function mcp(cookie: string) {
  const client = new Client({ name: 'slice7-demo', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${API}/mcp`), { requestInit: { headers: { cookie } } }));
  return async <T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] };
    const text = r.content?.find((c) => c.type === 'text')?.text ?? '';
    if (r.isError) fail(`${name}: ${text}`);
    return (r.structuredContent ?? JSON.parse(text)) as T;
  };
}
async function login(email: string, password: string) {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!r.ok) fail(`login ${email}: ${r.status}`);
  return (r.headers.get('set-cookie') ?? '').split(';')[0]!;
}
async function signup(company: string, email: string) {
  const su = await fetch(`${API}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company, email, password: 'demo-password-slice7' }) });
  if (!su.ok) fail(`signup ${su.status}`);
  const cookie = (su.headers.get('set-cookie') ?? '').split(';')[0]!;
  return { cookie, H: { cookie, 'x-csrf-token': ((await su.json()) as { csrfToken: string }).csrfToken }, call: await mcp(cookie) };
}
type Flow = { flowType: string; status: string; systems?: string[]; integrationId: string | null; discovery: { candidates: { id: string; kind: string; summary: string }[] } | null; responsibilities: { version: string }; activation: { baseline: Record<string, unknown> | null } | null };
type Overall = { integrations: Flow[] };
type Portfolio = { maintenance: { id: string; state: string; headline: string; zeroLoss: boolean }[] };
type Story = { state: string; headline: string; facts: { label: string; value: string }[]; decision: unknown };
type Evidence = { kind: string; status: string; boundary: string | null; provider: string | null; impactAssessment: Record<string, unknown> | null; corrections: { id: string; kind: string; status: string; validation?: { checks?: { name: string; status: string; detail: string }[] } }[] };

await wait('API readiness', async () => (await fetch(`${API}/readyz`).catch(() => null))?.ok);
await wait('fixtures', async () => (await fetch(`${STRIPE}/__fixture/state`).catch(() => null))?.ok && (await fetch(`${QBO}/__fixture/state`).catch(() => null))?.ok);
const STRIPE_KEY = ((await (await fetch(`${STRIPE}/__fixture/state`)).json()) as { apiKey: string }).apiKey;
const operator = await mcp(await login('operator@managed-integrations.test', 'operator-demo-password'));
const tag = randomBytes(2).toString('hex');

/* ======================= Stripe-dependent application ======================= */
step('S1', `Adopted ${STRIPE_SUBSCRIPTIONS_APP.repository} @ ${STRIPE_SUBSCRIPTIONS_APP.commit.slice(0, 12)} (${STRIPE_SUBSCRIPTIONS_APP.license}), vendored; ${Object.keys(STRIPE_SUBSCRIPTIONS_APP.fileSha256).length} executed files pinned; match: ${pinnedDrift(appPinned()).length === 0}`);
// Before: their own deployment of the application has a webhook endpoint at Stripe; they have subscribers.
await fetch(`${STRIPE}/v1/webhook_endpoints`, {
  method: 'POST',
  headers: { authorization: `Bearer ${STRIPE_KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams([['url', `https://subs-${tag}.lumen.test/v1/stripe/webhook`], ['api_version', STRIPE_SUBSCRIPTIONS_APP.stripeApiVersion], ['enabled_events[0]', 'customer.subscription.updated'], ['enabled_events[1]', 'customer.subscription.created'], ['enabled_events[2]', 'invoice.payment_succeeded'], ['enabled_events[3]', 'invoice.payment_failed']] as [string, string][]).toString(),
});
const subA = (await post(`${STRIPE}/__fixture/subscription`, { amount: 2_900 })) as { subscriptionId: string };
const subB = (await post(`${STRIPE}/__fixture/subscription`, { amount: 9_900 })) as { subscriptionId: string };
const s = await signup('Lumen Subscriptions', `ops+${tag}@lumen.test`);
await post(`${API}/api/customer/connections/stripe`, { apiKey: STRIPE_KEY }, s.H);
const sFlow = (await s.call<Overall>('onboarding_discover')).integrations.find((i) => i.flowType === STRIPE_APP_FLOW_TYPE)!;
if (!['confirm', 'select'].includes(sFlow.status)) fail(`discovery: ${JSON.stringify(sFlow)}`);
const myCand = sFlow.discovery!.candidates.find((c) => c.summary.includes('/v1/stripe/webhook'))!;
step('S2', `Discovered (one provider: ${sFlow.systems?.join(', ')}): ${myCand.summary}`);
await s.call('onboarding_confirm', { candidateId: myCand.id, responsibilitiesVersion: sFlow.responsibilities.version, flowType: STRIPE_APP_FLOW_TYPE });
const sManaged = await wait('the application to be managed', async () => {
  const f = (await s.call<Overall>('onboarding_status')).integrations.find((i) => i.flowType === STRIPE_APP_FLOW_TYPE);
  return f?.status === 'managed' ? f : undefined;
});
const appId = sManaged.integrationId!;
step('S3', `Hosted and verified: ${JSON.stringify(sManaged.activation?.baseline)} (the application’s own database rebuilt from Stripe’s events; every record checked against Stripe)`);

// Stripe-side change: our endpoint for this application moves to basil.
const eps = ((await (await fetch(`${STRIPE}/__fixture/state`)).json()) as { endpoints: { id: string; url: string }[] }).endpoints;
const ours = eps.find((e) => e.url.endsWith(`/webhooks/stripe/${appId}`))!;
await post(`${STRIPE}/__fixture/endpoint-version`, { endpointId: ours.id, version: '2025-03-31.basil' });
await post(`${STRIPE}/__fixture/subscription/${subA.subscriptionId}/renew`, {});
await post(`${STRIPE}/__fixture/subscription/${subB.subscriptionId}/fail`, {});
const evId = await wait('the provider change to be detected', async () => (await s.call<Portfolio>('portfolio_integration', { integrationId: appId })).maintenance[0]?.id);
const ready = await wait('the correction to be validated', async () => {
  const e = await operator<Evidence>('maintenance_events_evidence', { eventId: evId });
  const c = e.corrections.find((x) => x.kind === 'patch' && x.status === 'validated');
  return c ? { e, c } : undefined;
});
step('S4', `Detected: boundary ${ready.e.boundary}, provider ${ready.e.provider}; impact ${JSON.stringify((ready.e.impactAssessment as { fields?: string[] })?.fields)}; reviewed patch validated by replay: ${ready.c.validation?.checks?.map((c) => `${c.status === 'passed' ? '✓' : '✗'} ${c.name}`).join(' · ')}`);
await operator('adaptations_activate', { adaptationId: ready.c.id, reason: 'Reviewed: reads the basil field locations; webhook handler unchanged' });
const sDone = await wait('the event to resolve', async () => {
  const story = await s.call<Story>('maintenance_events_get', { eventId: evId });
  return story.state === 'completed' ? story : undefined;
});
step('S5', `Operator switched the patch on (MCP). Customer view: “${sDone.headline}” — ${sDone.facts.map((f) => `${f.label}: ${f.value}`).join(' | ')}`);
if (/p0001|stripeEventProcessor|sha256/.test(JSON.stringify(sDone))) fail('customer view leaks internals');
const sEv = await operator<Evidence & { event: { claim: { zeroLoss: boolean; statement: string | null } } }>('maintenance_events_evidence', { eventId: evId });
step('S6', `Zero loss: ${sEv.event.claim.zeroLoss} — ${sEv.event.claim.statement}`);
if (!sEv.event.claim.zeroLoss) fail('no zero-loss claim for the Stripe application');

/* ======================= QuickBooks-dependent application ======================= */
const q = await signup('Lumen Books', `books+${tag}@lumen.test`);
const start = (await post(`${API}/api/customer/connections/quickbooks/authorize`, {}, q.H)) as { url: string };
const connectQbo = async (url: string) => {
  const approve = await fetch(url, { redirect: 'manual' });
  const cb = new URL(approve.headers.get('location')!);
  return (await fetch(`${API}${cb.pathname}${cb.search}`, { redirect: 'manual', headers: { cookie: q.cookie } })).headers.get('location');
};
await connectQbo(start.url);
const qFlow = (await q.call<Overall>('onboarding_discover')).integrations.find((i) => i.flowType === QBO_TOOLS_FLOW_TYPE)!;
await q.call('onboarding_confirm', { candidateId: qFlow.discovery!.candidates[0]!.id, responsibilitiesVersion: qFlow.responsibilities.version, flowType: QBO_TOOLS_FLOW_TYPE });
const qManaged = await wait('the QuickBooks tools to be managed', async () => {
  const f = (await q.call<Overall>('onboarding_status')).integrations.find((i) => i.flowType === QBO_TOOLS_FLOW_TYPE);
  return f?.status === 'managed' ? f : undefined;
});
const qboId = qManaged.integrationId!;
step('Q1', `Adopted ${QBO_TOOLS_APP.repository} @ ${QBO_TOOLS_APP.commit.slice(0, 12)} (v${QBO_TOOLS_APP.version}); ${Object.keys(QBO_TOOLS_APP.fileSha256).length} executed files pinned (match: ${pinnedDrift(qboPinned()).length === 0}); one provider: ${qFlow.systems?.join(', ')}; candidate: ${qFlow.discovery!.candidates[0]!.kind}`);
const inv = (n: number) => ({ txn_date: new Date().toISOString().slice(0, 10), customer_name: 'Acme Corp', doc_number: `D7-${tag}-${n}`, lines: [{ item_name: 'Consulting', amount: 300 }, { item_name: 'Design', qty: 2, unit_price: 120 }] });
type Invoked = { outcome: string; replayed: boolean; verification: { verified?: boolean; invoiceId?: string } };
const r1 = await q.call<Invoked>('applications_invoke', { integrationId: qboId, operation: 'create_invoice', requestId: `r1-${tag}`, input: inv(1) });
const r1b = await q.call<Invoked>('applications_invoke', { integrationId: qboId, operation: 'create_invoice', requestId: `r1-${tag}`, input: inv(1) });
const invoices = async () => ((await (await fetch(`${QBO}/__fixture/state`)).json()) as { invoices: { DocNumber: string; TotalAmt: number }[] }).invoices.filter((i) => i.DocNumber.startsWith(`D7-${tag}`));
step('Q2', `Agent created invoice ${r1.verification.invoiceId} via MCP: ${r1.outcome}, verified in QuickBooks: ${r1.verification.verified}; the same request again: replayed=${r1b.replayed}; invoices: ${(await invoices()).map((i) => `${i.DocNumber} $${i.TotalAmt}`).join(', ')}`);
if ((await invoices()).length !== 1) fail('duplicate invoice');

// Provider-side change: QuickBooks authorization revoked.
await post(`${QBO}/__fixture/revoke`, {});
const held = await q.call<Invoked>('applications_invoke', { integrationId: qboId, operation: 'create_invoice', requestId: `r2-${tag}`, input: inv(2) });
if (held.outcome !== 'awaiting_authorization') fail(`expected a held request, got ${held.outcome}`);
const authEv = await wait('the reauthorization event', async () => (await q.call<Portfolio>('portfolio_integration', { integrationId: qboId })).maintenance.find((m) => m.state === 'needs_you')?.id);
const again = (await post(`${API}/api/customer/connections/quickbooks/authorize`, {}, q.H)) as { url: string };
await connectQbo(again.url);
const authDone = await wait('the reauthorization to resolve', async () => {
  const st = await q.call<Story & { claim: { zeroLoss: boolean } }>('maintenance_events_get', { eventId: authEv });
  return st.state === 'completed' ? st : undefined;
});
step('Q3', `QuickBooks authorization lost → request held (QuickBooks processed nothing) → customer reconnected → ran once. “${authDone.headline}”; zero loss: ${authDone.claim.zeroLoss}; invoices: ${(await invoices()).length}`);
if ((await invoices()).length !== 2) fail('held request not delivered exactly once');

// Application-side change: upstream v0.12.0 (node-quickbooks 2.0.48 → 2.0.50), found by the worker's sweep.
const upEv = await wait('the upstream release event', async () => {
  const p = await operator<{ maintenance: { id: string; headline: string }[] }>('portfolio_integration', { integrationId: qboId });
  for (const m of p.maintenance) {
    const e = await operator<Evidence>('maintenance_events_evidence', { eventId: m.id });
    const c = e.kind === 'application_change' ? e.corrections.find((x) => x.status === 'validated') : undefined;
    if (c) return { id: m.id, e, c };
  }
  return undefined;
});
step('Q4', `Upstream v${QBO_TOOLS_APP.nextRelease.version}: ${upEv.c.validation?.checks?.map((c) => `${c.status === 'passed' ? '✓' : '✗'} ${c.name} (${c.detail})`).join(' · ')}`);
await operator('adaptations_activate', { adaptationId: upEv.c.id, reason: 'Reviewed: upstream release, executed files unchanged' });
await q.call('applications_invoke', { integrationId: qboId, operation: 'create_invoice', requestId: `r3-${tag}`, input: inv(3) });
const ua = ((await (await fetch(`${QBO}/__fixture/state`)).json()) as { requestLog: { userAgent?: string | null }[] }).requestLog.filter((x) => x.userAgent?.startsWith('node-quickbooks')).at(-1)?.userAgent;
await wait('the upgrade event to resolve', async () => (await q.call<Story>('maintenance_events_get', { eventId: upEv.id })).state === 'completed');
await operator('adaptations_rollback', { adaptationId: upEv.c.id, reason: 'Rollback drill' });
step('Q5', `Operator switched it on; next request used “${ua}”; verified on real work and resolved; rolled back to the pinned set (drill)`);

const out = `docs/evidence/runs/demo-applications-${new Date().toISOString().slice(0, 10)}.json`;
await mkdir('docs/evidence/runs', { recursive: true }).catch(() => undefined);
await writeFile(out, JSON.stringify(evidence, null, 2)).catch(() => undefined);
console.log(`PASSED in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(0);
