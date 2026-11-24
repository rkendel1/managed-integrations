/**
 * SLICE 7 (scope correction) — provider-centric adoption: an APPLICATION that depends on one provider, adopted
 * and maintained on the shared mechanisms without being forced into a source → target pipeline.
 *
 * Stripe-dependent application: stripe-webhooks-subscriptions-node-ts @ 4812d25 (MIT), vendored and pinned,
 * hosted per customer (its own Express app, webhook handler, idempotency and Stripe client; its own database
 * hosted by us). Fixture-backed: no live Stripe account.
 *
 * INVARIANT (per scenario): every Stripe event of the application is received once and processed by the
 * application; every record it keeps (subscription status and period end, invoice subscription/paid/amount,
 * payment status/amount) equals what Stripe states; no history is rewritten; corrections never modify the
 * pinned upstream files.
 */
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createClient } from '@appport/client';
import { createHttpTransport } from '@appport/transport-http';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { PgBoss } from 'pg-boss';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appStore,
  closeAllInstances,
  compare,
  expectationOf,
  pinnedSource,
  STRIPE_APP_FLOW_TYPE,
  STRIPE_SUBSCRIPTIONS_APP,
} from '@mi/adopted-stripe-subscriptions';
import { adaptations, contractObservations, deliveries, incidents, integrations, users, type DbHandle } from '@mi/database';
import { loadServiceConfig, type ServiceConfig } from '@mi/integration-shopify-netsuite';
import { pinnedDrift } from '@mi/managed';
import { createLogger } from '@mi/observability';
import { createStripeFixture, STRIPE_BASIL, type StripeFixture } from '@mi/test-fixtures';
import { buildApp } from '../src/app.ts';
import { ensureQueues } from '../src/queues.ts';
import { createRuntimeWorker } from '../../worker/src/runtime-worker.ts';
import { freshDb, TEST_DB_URL, testCipher } from '../../../test/support/harness.ts';
import { drainer } from '../../../test/support/stripe-quickbooks.ts';

let dbh: DbHandle;
let stripe: StripeFixture;
let stripeUrl: string;
let app: FastifyInstance;
let boss: PgBoss;
let base: string;
let config: ServiceConfig;
let worker: ReturnType<typeof createRuntimeWorker>;
let jobs: ReturnType<typeof drainer>;

const ACACIA = '2025-02-24.acacia';

async function setup() {
  dbh = await freshDb();
  stripe = createStripeFixture({ accountApiVersion: ACACIA, prefix: 'Ap' });
  await stripe.app.listen({ port: 0, host: '127.0.0.1' });
  stripeUrl = `http://127.0.0.1:${(stripe.app.server.address() as AddressInfo).port}`;
  boss = new PgBoss({ connectionString: TEST_DB_URL, schema: `pgboss_pa_${randomBytes(3).toString('hex')}` });
  await boss.start();
  await ensureQueues(boss);
  config = loadServiceConfig('api', {
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB_URL,
    CREDENTIAL_ENCRYPTION_KEYS: `k1:${randomBytes(32).toString('base64')}`,
    PUBLIC_BASE_URL: 'http://localhost:3000',
    STRIPE_BASE_URL_OVERRIDE: stripeUrl,
  });
  (config as { cipher: unknown }).cipher = testCipher;
  app = await buildApp({ db: dbh.db, boss, config, logLevel: 'silent' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  config.env.PUBLIC_BASE_URL = base;
  config.env.WEBHOOK_BASE_URL = base;
  worker = createRuntimeWorker({ db: dbh.db, boss, config, logger: createLogger('test', 'silent'), workerId: 'test-worker' });
  jobs = drainer(boss, worker.handlers as never);
}
afterEach(async () => {
  await closeAllInstances();
  await app?.close();
  await boss?.stop({ graceful: false });
  await stripe?.app.close();
  await dbh?.close();
});

async function customer(email = 'ops@lumen.test') {
  const r = await fetch(`${base}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ company: 'Lumen Studio', email, password: 'correct horse battery staple' }),
  });
  expect(r.status).toBe(200);
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  const csrf = ((await r.json()) as { csrfToken: string }).csrfToken;
  const client = createClient({ transport: createHttpTransport({ url: `${base}/appport`, headers: { cookie } }) });
  await client.connect();
  await client.load();
  const [u] = await dbh.db.select().from(users).where(eq(users.email, email));
  return {
    tenantId: u!.tenantId!,
    call: <T = Record<string, unknown>>(name: string, input: unknown = {}) => client.call<T>(name, input),
    async connectStripe() {
      const res = await fetch(`${base}/api/customer/connections/stripe`, {
        method: 'POST',
        headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: stripe.apiKey() }),
      });
      return res.status;
    },
  };
}

/** Their business before they come to us: their own deployment's endpoint at Stripe, and subscriptions. */
async function history() {
  const res = await fetch(`${stripeUrl}/v1/webhook_endpoints`, {
    method: 'POST',
    headers: { authorization: `Bearer ${stripe.apiKey()}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([
      ['url', 'https://subs.lumen.test/v1/stripe/webhook'],
      ['api_version', ACACIA],
      ...['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.payment_succeeded', 'invoice.payment_failed'].map((e, i) => [`enabled_events[${i}]`, e] as [string, string]),
    ] as [string, string][]).toString(),
  });
  expect(res.status).toBe(200);
  const a = stripe.control.createSubscription({ amount: 2_900 });
  const b = stripe.control.createSubscription({ amount: 9_900, price: 'price_ApTeam' });
  return { a: a.subscription.id, b: b.subscription.id };
}

type Flow = { flowType: string; status: string; discovery: { outcome: string; candidates: { id: string; kind: string; summary: string }[] } | null; responsibilities: { version: string }; systems?: string[] };
type Status = { status: string; integrations: Flow[] };

async function onboard() {
  const h = await history();
  const c = await customer();
  expect(await c.connectStripe()).toBe(200);
  const found = await c.call<Status>('onboarding.discover');
  const flow = found.integrations.find((i) => i.flowType === STRIPE_APP_FLOW_TYPE)!;
  await c.call('onboarding.confirm', {
    candidateId: flow.discovery!.candidates[0]!.id,
    responsibilitiesVersion: flow.responsibilities.version,
    flowType: STRIPE_APP_FLOW_TYPE,
  });
  await jobs.drain(async () => {
    const [i] = await dbh.db.select().from(integrations).where(and(eq(integrations.tenantId, c.tenantId), eq(integrations.flowType, STRIPE_APP_FLOW_TYPE)));
    return i?.lifecycle === 'active';
  }, 60_000);
  const [integ] = await dbh.db.select().from(integrations).where(and(eq(integrations.tenantId, c.tenantId), eq(integrations.flowType, STRIPE_APP_FLOW_TYPE)));
  return { ...h, c, found, flow, integ: integ! };
}

/** Every record the application keeps, compared with what Stripe states now (live). */
async function recordsAgreeWithStripe(integrationId: string) {
  const store = appStore(dbh.db, integrationId);
  const out: string[] = [];
  for (const [model, path] of [['subscription', 'subscriptions'], ['invoice', 'invoices']] as const)
    for (const r of await store.all(model)) {
      const id = String(r[model === 'subscription' ? 'stripeSubscriptionId' : 'stripeInvoiceId']);
      const live = (await (await fetch(`${stripeUrl}/v1/${path}/${id}`, { headers: { authorization: `Bearer ${stripe.apiKey()}` } })).json()) as Record<string, unknown>;
      out.push(...compare(expectationOf(live)!, r).map((m) => `${id}.${m.field}`));
    }
  return out;
}

describe('provider-centric adoption: a Stripe-dependent application', { timeout: 180_000 }, () => {
  it('discovers the application’s deployment at Stripe, hosts the pinned application, rebuilds and verifies its records; new events, duplicates and its own writes are handled exactly once', async () => {
    await setup();
    const { c, found, flow, integ, a } = await onboard();
    // A single-provider application: only Stripe had to be connected; not forced into a source → target shape.
    expect(found.integrations.find((i) => i.flowType === STRIPE_APP_FLOW_TYPE)!.systems).toEqual(['Stripe']);
    expect(flow.discovery).toMatchObject({ outcome: 'found', candidates: [expect.objectContaining({ kind: 'adoptable' })] });
    expect(flow.discovery!.candidates[0]!.summary).toMatch(/\/v1\/stripe\/webhook.*2025-02-24\.acacia/);
    // our endpoint carries the payload contract the application was running with
    const ours = stripe.state.endpoints.find((e) => e.url === `${base}/webhooks/stripe/${integ.id}`)!;
    expect(ours.api_version).toBe(ACACIA);
    // the application's own database was rebuilt from Stripe's events and agrees with Stripe
    const store = appStore(dbh.db, integ.id);
    expect((await store.all('subscription')).length).toBe(2);
    expect(await recordsAgreeWithStripe(integ.id)).toEqual([]);

    // a new event: through our ingress into the application's own webhook route, verified
    const renewed = stripe.control.renewSubscription(a).event;
    await jobs.drain(async () => (await dbh.db.select().from(deliveries).where(eq(deliveries.sourceId, renewed.id)))[0]?.outcome === 'delivered');
    expect(await recordsAgreeWithStripe(integ.id)).toEqual([]);
    // duplicate delivery of the same event: received once, the application runs once
    const body = JSON.stringify(stripe.control.eventBody(renewed.id, ACACIA));
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${base}/webhooks/stripe/${integ.id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripe.control.sign(ours.secret, body) }, body });
      expect(((await r.json()) as { disposition: string }).disposition).toBe('duplicate_webhook');
    }
    await jobs.drain();
    expect(await store.get('stripeEvent', renewed.id)).toMatchObject({ status: 'processed', attemptCount: 1 });
    // a forged event is refused at our ingress
    expect((await fetch(`${base}/webhooks/stripe/${integ.id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripe.control.sign('whsec_wrong', body) }, body })).status).toBe(400);

    // the application's own writes to Stripe (its checkout route), recorded and read back; a repeated request does nothing again
    const rt = worker.registry.get(STRIPE_APP_FLOW_TYPE)!;
    const input = { priceId: 'price_ApPro', successUrl: 'https://subs.lumen.test/ok', cancelUrl: 'https://subs.lumen.test/no' };
    const w1 = await rt.invoke!({ integrationId: integ.id, operation: 'checkout-session', input, requestId: 'req-1', principalId: 'test' });
    const w2 = await rt.invoke!({ integrationId: integ.id, operation: 'checkout-session', input, requestId: 'req-1', principalId: 'test' });
    expect(w1).toMatchObject({ outcome: 'delivered', replayed: false, verification: { verified: true } });
    expect(w2).toMatchObject({ deliveryId: w1.deliveryId, replayed: true });
    expect(stripe.state.checkoutSessions.size).toBe(1);
    // the request carried the application's own pinned API version (its client, not ours)
    expect(stripe.state.requestLog.filter((x) => x.path === '/v1/checkout/sessions').map((x) => x.version)).toEqual([STRIPE_SUBSCRIPTIONS_APP.stripeApiVersion]);
    expect(c.tenantId).toBeTruthy();
  });

  it('Stripe-side change: the endpoint moves to 2025-03-31.basil — the application answers 200 but records wrong data; detected, a reviewed patch is validated by replay, activated by an operator, records recovered and verified against Stripe; rollback restores the pinned code', async () => {
    await setup();
    const { integ, a, b } = await onboard();
    const ours = stripe.state.endpoints.find((e) => e.url === `${base}/webhooks/stripe/${integ.id}`)!;
    // Stripe (or the customer) moves the endpoint to the current API version.
    stripe.control.setEndpointVersion(ours.id, STRIPE_BASIL);
    const e1 = stripe.control.renewSubscription(a).event;
    const e2 = stripe.control.failRenewal(b);
    await jobs.drain(async () => {
      const [ev] = await dbh.db.select().from(incidents).where(and(eq(incidents.integrationId, integ.id), eq(incidents.kind, 'provider_contract_change')));
      return (ev?.evidence as { maintenance?: { phase?: string } })?.maintenance?.phase === 'await_activation';
    }, 60_000);
    const [ev] = await dbh.db.select().from(incidents).where(and(eq(incidents.integrationId, integ.id), eq(incidents.kind, 'provider_contract_change')));
    // detection with evidence: the payload drifted (fields removed/added), and the application's records differ from Stripe
    expect(ev).toMatchObject({ boundary: 'provider', provider: 'stripe' });
    const f = ev!.finding as { contracts: { contract: string; removed: string[]; added: string[]; observedVersion: string }[]; mismatches: { field: string }[] };
    expect(f.contracts.length).toBeGreaterThan(0);
    expect(f.contracts.every((x) => x.observedVersion === STRIPE_BASIL)).toBe(true);
    expect(f.mismatches.length).toBeGreaterThan(0);
    const [d1] = await dbh.db.select().from(deliveries).where(eq(deliveries.sourceId, e1.id));
    expect(d1).toMatchObject({ outcome: 'failed', lastErrorClass: 'verification' });
    expect((d1!.summary as { applicationStatus: number }).applicationStatus).toBe(200); // the application said OK
    await jobs.drain(); // events still in flight widen the impact until the correction activates
    const [ev2] = await dbh.db.select().from(incidents).where(eq(incidents.id, ev!.id));
    const impact = ev2!.impactAssessment as { fields: string[]; contracts: typeof f.contracts };
    expect(impact).toMatchObject({ boundary: 'provider', provider: 'stripe' });
    expect(impact.fields).toEqual(expect.arrayContaining(['currentPeriodEnd', 'stripeSubscriptionId', 'paid']));
    const sub = impact.contracts.find((x) => x.contract === 'stripe.subscription')!;
    expect(sub).toMatchObject({ observedVersion: STRIPE_BASIL, baselineVersion: ACACIA });
    expect(sub.removed).toEqual(expect.arrayContaining(['current_period_end', 'current_period_start']));
    expect(sub.added).toEqual(expect.arrayContaining(['items.data[].current_period_end']));
    const inv = impact.contracts.find((x) => x.contract === 'stripe.invoice')!;
    expect(inv.removed).toEqual(expect.arrayContaining(['subscription', 'paid', 'charge']));
    expect(inv.added).toEqual(expect.arrayContaining(['parent']));
    // the reviewed correction, validated by replaying this customer's own events before/after
    const [corr] = await dbh.db.select().from(adaptations).where(eq(adaptations.maintenanceEventId, ev!.id));
    expect(corr).toMatchObject({ kind: 'patch', status: 'validated', provider: 'stripe', spec: { patchId: 'p0001-stripe-basil-field-locations' } });
    const checks = (corr!.validation as { checks: { name: string; status: string; detail: string }[] }).checks;
    expect(checks.map((x) => x.status)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed']);
    expect(checks[2]!.detail).toMatch(/^\d+\/\d+ match Stripe after \(\d+ did not before\)/);
    // never automatic for a change to the customer's application code: it waits for an operator
    const rt = worker.registry.get(STRIPE_APP_FLOW_TYPE)!;
    await rt.adaptations!.activate(corr!.id, 'operator:test', 'reviewed');
    await jobs.drain(async () => (await dbh.db.select().from(incidents).where(eq(incidents.id, ev!.id)))[0]!.status === 'resolved', 60_000);
    const [done] = await dbh.db.select().from(incidents).where(eq(incidents.id, ev!.id));
    expect(done!.accounting).toMatchObject({ zeroLoss: true, populationComplete: true, unresolved: 0, duplicates: 0 });
    expect((done!.accounting as { failedDuringDisruption: number }).failedDuringDisruption).toBeGreaterThanOrEqual(2);
    expect(await recordsAgreeWithStripe(integ.id)).toEqual([]);
    // new basil events are now recorded correctly by the corrected application
    const e3 = stripe.control.renewSubscription(b).event;
    await jobs.drain(async () => (await dbh.db.select().from(deliveries).where(eq(deliveries.sourceId, e3.id)))[0]?.outcome === 'delivered');
    expect(await recordsAgreeWithStripe(integ.id)).toEqual([]);
    // durable boundary record: the drifted variants are accepted (history kept)
    const obs = await dbh.db.select().from(contractObservations).where(and(eq(contractObservations.integrationId, integ.id), eq(contractObservations.contract, 'stripe.subscription')));
    expect(obs.map((o) => o.status).sort()).toEqual(['accepted', 'baseline']);
    // which code runs: the patched content-addressed copy; the pinned vendored files are untouched
    const running = await rt.inspect!(integ.id);
    expect(running.running!.id).toBe('stripe-subscriptions-app:4812d259e7e8+p0001');
    expect(pinnedDrift(pinnedSource())).toEqual([]);
    // rollback restores the pinned code; the records and the event's evidence stay
    await rt.adaptations!.rollback(corr!.id, 'operator:test', 'rollback drill');
    expect((await rt.inspect!(integ.id)).running!.id).toBe('stripe-subscriptions-app:4812d259e7e8');
    expect((await dbh.db.select().from(incidents).where(eq(incidents.id, ev!.id)))[0]!.accounting).toMatchObject({ zeroLoss: true });
    expect(e2).toBeTruthy();
  });
});
