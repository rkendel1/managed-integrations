/**
 * SLICE 6 — the second integration, through the real API, the real worker handlers and the shared mechanisms:
 * Stripe → QuickBooks (adopted ledgerly @ 3101182). The customer's existing integration is their own ledgerly
 * deployment (test/support/stripe-quickbooks.ts), whose QuickBooks entries are written by the pinned upstream code.
 * Fixture-backed: no live Stripe account or QuickBooks company.
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
  LEDGERLY_FLOW_TYPE,
  recoverLedgerlyItem,
  startLedgerlyReconciliation,
  scanLedgerlyReconciliation,
} from '@mi/adopted-ledgerly';
import {
  adaptations,
  connections,
  deliveries,
  deliveryAttempts,
  incidents,
  integrations,
  observations,
  onboardings,
  reconciliationItems,
  reconciliationRuns,
  contractObservations,
  users,
  type DbHandle,
} from '@mi/database';
import { loadServiceConfig, type ServiceConfig } from '@mi/integration-shopify-netsuite';
import { createLogger } from '@mi/observability';
import {
  createNetSuiteFixture,
  createShopifyFixture,
  type NetSuiteFixture,
  type ShopifyFixture,
} from '@mi/test-fixtures';
import { SHOPIFY_NETSUITE } from '@mi/adopted-order-sync';
import { accountTransactions } from '@mi/managed';
import { buildApp } from '../src/app.ts';
import { ensureQueues } from '../src/queues.ts';
import { createRuntimeWorker } from '../../worker/src/runtime-worker.ts';
import { freshDb, TEST_DB_URL, testCipher } from '../../../test/support/harness.ts';
import { drainer, startStripeQuickbooks, theirLedgerly } from '../../../test/support/stripe-quickbooks.ts';

let dbh: DbHandle;
let fx: Awaited<ReturnType<typeof startStripeQuickbooks>>;
let shop: ShopifyFixture | undefined;
let ns: NetSuiteFixture | undefined;
let app: FastifyInstance;
let boss: PgBoss;
let base: string;
let config: ServiceConfig;
let worker: ReturnType<typeof createRuntimeWorker>;
let jobs: ReturnType<typeof drainer>;

async function setup(extraEnv: Record<string, string> = {}) {
  dbh = await freshDb();
  fx = await startStripeQuickbooks();
  boss = new PgBoss({ connectionString: TEST_DB_URL, schema: `pgboss_sq_${randomBytes(3).toString('hex')}` });
  await boss.start();
  await ensureQueues(boss);
  // The API must exist before its address is known: providers call back to it.
  config = loadServiceConfig('api', {
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB_URL,
    CREDENTIAL_ENCRYPTION_KEYS: `k1:${randomBytes(32).toString('base64')}`,
    PUBLIC_BASE_URL: 'http://localhost:3000',
    ...fx.env,
    ...extraEnv,
  });
  (config as { cipher: unknown }).cipher = testCipher;
  app = await buildApp({ db: dbh.db, boss, config, logLevel: 'silent' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  config.env.PUBLIC_BASE_URL = base;
  config.env.WEBHOOK_BASE_URL = base;
  worker = createRuntimeWorker({
    db: dbh.db,
    boss,
    config,
    logger: createLogger('test', 'silent'),
    workerId: 'test-worker',
  });
  jobs = drainer(boss, worker.handlers as never);
}
afterEach(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await fx?.close();
  await shop?.app.close();
  await ns?.app.close();
  shop = ns = undefined;
  await dbh?.close();
});

const days = (n: number) => new Date(Date.now() - n * 86_400_000);

/** Their business before they come to us: payments their own ledgerly deployment already booked. */
async function history() {
  const theirs = await theirLedgerly(fx);
  const ev = [
    fx.stripe.control.createCharge({ amount: 10_000, at: days(3) }).event,
    fx.stripe.control.createCharge({ amount: 4_500, at: days(3) }).event,
    fx.stripe.control.payInvoice({ amount: 5_000, at: days(2) }),
    fx.stripe.control.createCharge({ amount: 25_000, at: days(2) }).event,
    fx.stripe.control.createPayout({ amount: 30_000, at: days(1) }).event,
  ];
  let booked = 0;
  for (const e of ev) {
    if ('chargeEvent' in e) {
      booked += await theirs.process(e.chargeEvent.id);
      booked += await theirs.process(e.event.id);
    } else booked += await theirs.process(e.id);
  }
  return { theirs, booked };
}

async function customer(email = 'finance@lumen.test') {
  const actions: string[] = [];
  const r = await fetch(`${base}/api/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ company: 'Lumen Studio', email, password: 'correct horse battery staple' }),
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
      redirect: 'manual',
    });
  const client = createClient({
    transport: createHttpTransport({ url: `${base}/appport`, headers: { cookie } }),
  });
  await client.connect();
  await client.load();
  const [u] = await dbh.db.select().from(users).where(eq(users.email, email));
  return {
    actions,
    tenantId: u!.tenantId!,
    call: <T = Record<string, unknown>>(name: string, input: unknown = {}) => client.call<T>(name, input),
    async connectStripe(apiKey = fx.stripe.apiKey()) {
      actions.push('connect Stripe (restricted key)');
      const res = await rest('/api/customer/connections/stripe', { apiKey });
      return { status: res.status, body: (await res.json()) as { status?: string; error?: string } };
    },
    async connectShopify(domain: string) {
      actions.push('connect Shopify (shop name)');
      const start = (await (
        await rest('/api/customer/connections/shopify/authorize', { shop: domain })
      ).json()) as { url: string };
      actions.push('approve in Shopify');
      const red = await fetch(start.url, { redirect: 'manual' });
      const cb = new URL(red.headers.get('location')!);
      return (await fetch(`${base}${cb.pathname}${cb.search}`, { redirect: 'manual' })).headers.get(
        'location',
      );
    },
    async connectNetSuite() {
      actions.push('connect NetSuite');
      const res = (await (
        await rest('/api/customer/connections/netsuite', {
          accountDomain: '1234567-sb1.suitetalk.api.netsuite.com',
          clientId: ns!.clientId,
          certificateId: ns!.certificateId,
        })
      ).json()) as { publicKeyPem: string };
      ns!.control.registerPublicKey(res.publicKeyPem);
      return (await (await rest('/api/customer/connections/netsuite/verify', {})).json()) as {
        status: string;
      };
    },
    async connectQuickBooks(opts: { deny?: boolean } = {}) {
      actions.push('connect QuickBooks');
      const start = (await (await rest('/api/customer/connections/quickbooks/authorize', {})).json()) as {
        url: string;
      };
      if (opts.deny) fx.qbo.state.denyNext = true;
      actions.push('approve in QuickBooks');
      const red = await fetch(start.url, { redirect: 'manual' });
      const cb = new URL(red.headers.get('location')!);
      const back = await fetch(`${base}${cb.pathname}${cb.search}`, { redirect: 'manual' });
      return back.headers.get('location');
    },
  };
}

type Flow = {
  flowType: string;
  status: string;
  discovery: {
    outcome: string;
    checked: number;
    candidates: { id: string; kind: string; confidence: string | null; summary: string }[];
  } | null;
  activation: {
    steps: { label: string; done: boolean }[];
    baseline: Record<string, number | string> | null;
  } | null;
  integrationId: string | null;
  responsibilities: { version: string };
};
type Status = { status: string; integrations: Flow[]; systems: { id: string; connected: boolean }[] };
const stripeFlow = (v: Status) => v.integrations.find((i) => i.flowType === LEDGERLY_FLOW_TYPE)!;

const onboarded = async (tenantId: string) => {
  const [i] = await dbh.db
    .select()
    .from(integrations)
    .where(and(eq(integrations.tenantId, tenantId), eq(integrations.flowType, LEDGERLY_FLOW_TYPE)));
  return i?.lifecycle === 'active';
};
const entriesFor = (docPrefix: string) =>
  [...fx.qbo.state.journalEntries.values()].filter((e) => e.DocNumber === docPrefix.slice(-21));

/** Signs up, connects both systems, discovers, confirms and lets the worker activate management. */
async function onboard() {
  const h = await history();
  const c = await customer();
  expect((await c.connectStripe()).status).toBe(200);
  expect(await c.connectQuickBooks()).toBe('/app/welcome?connected=quickbooks');
  const found = await c.call<Status>('onboarding.discover');
  const flow = stripeFlow(found);
  c.actions.push('confirm: maintain this integration');
  await c.call('onboarding.confirm', {
    candidateId: flow.discovery!.candidates[0]!.id,
    responsibilitiesVersion: flow.responsibilities.version,
  });
  await jobs.drain(() => onboarded(c.tenantId));
  const [integ] = await dbh.db.select().from(integrations).where(eq(integrations.tenantId, c.tenantId));
  return { ...h, c, found, integ: integ! };
}

describe(
  'Stripe → QuickBooks: a second adopted integration on the shared mechanisms',
  { timeout: 120_000 },
  () => {
    it('discovers the customer’s ledgerly integration, puts it under management with a verified baseline, and books new Stripe transactions exactly once', async () => {
      await setup();
      const { c, found, integ, booked } = await onboard();
      expect(booked).toBe(5);
      // discovery: evidence from their books, account mapping read from history (no mapping questions)
      expect(found.status).toBe('confirm');
      const d = stripeFlow(found).discovery!;
      expect(d).toMatchObject({ outcome: 'found', checked: 5 });
      expect(d.candidates).toEqual([
        expect.objectContaining({ id: 'adopted.ledgerly', kind: 'adoptable', confidence: 'established' }),
      ]);
      expect(d.candidates[0]!.summary).toMatch(/^5 of your last 5 Stripe transactions are in QuickBooks/);
      expect(integ.config).toMatchObject({
        accountMapSource: 'history',
        accountMap: { '1010': { qboId: '91' }, '6000': { qboId: '97' }, '4000': { qboId: '79' } },
      });

      // protect: our Stripe endpoint pinned to the version the adopted code is written for; baseline verified
      expect(fx.stripe.state.endpoints).toEqual([
        expect.objectContaining({
          url: `${base}/webhooks/stripe/${integ.id}`,
          api_version: '2024-06-20',
          enabled_events: ['charge.succeeded', 'charge.refunded', 'invoice.payment_succeeded', 'payout.paid'],
        }),
      ]);
      const managed = await c.call<Status>('onboarding.status');
      expect(stripeFlow(managed).status).toBe('managed');
      expect(stripeFlow(managed).activation!.baseline).toMatchObject({
        checked: 5,
        accountedFor: 5,
        previouslyDelivered: 5,
        missing: 0,
        unresolved: 0,
        outcome: 'consistent',
      });
      const hist = await dbh.db.select().from(deliveries).where(eq(deliveries.integrationId, integ.id));
      expect(
        hist.every((x) => x.attempts === 0 && (x.validation as { origin: string }).origin === 'baseline'),
      ).toBe(true);

      // a new payment reaches us through the endpoint we registered, and is booked once by the adopted code
      const before = fx.qbo.state.journalEntries.size;
      const { event } = fx.stripe.control.createCharge({ amount: 7_700, fee: 253 });
      await jobs.drain(async () => entriesFor(event.id).length === 1);
      const [je] = entriesFor(event.id);
      expect(
        je!.Line.map((l) => [
          l.JournalEntryLineDetail.PostingType,
          l.JournalEntryLineDetail.AccountRef.value,
          l.Amount,
        ]),
      ).toEqual([
        ['Debit', '91', 74.47],
        ['Debit', '97', 2.53],
        ['Credit', '79', 77],
      ]);
      expect(fx.qbo.state.journalEntries.size).toBe(before + 1);
      const [del] = await dbh.db.select().from(deliveries).where(eq(deliveries.sourceId, event.id));
      expect(del).toMatchObject({ outcome: 'delivered', externalId: event.id.slice(-21) });

      // the customer product reads the same generic status for this integration
      const portfolio = await c.call<{ integrations: { id: string; name: string; process: string }[] }>(
        'portfolio.list',
      );
      expect(portfolio.integrations).toEqual([
        expect.objectContaining({ id: integ.id, name: 'Stripe → QuickBooks accounting' }),
      ]);
      expect(c.actions).toEqual([
        'sign up',
        'connect Stripe (restricted key)',
        'connect QuickBooks',
        'approve in QuickBooks',
        'confirm: maintain this integration',
      ]);
    });

    it('lost QuickBooks authorization: transactions are held (none lost), the customer reconnects, held and missed ones are booked and verified — zero loss proven', async () => {
      await setup();
      const { c, integ } = await onboard();
      // Intuit: the refresh token is revoked (the customer disconnected the app) and the access token expires.
      fx.qbo.control.revokeRefreshTokens();
      fx.qbo.control.expireAccessTokens();
      const a = fx.stripe.control.createCharge({ amount: 12_000 }).event;
      await jobs.drain(async () => {
        const [x] = await dbh.db.select().from(deliveries).where(eq(deliveries.sourceId, a.id));
        return x?.outcome === 'awaiting_authorization';
      });
      // one webhook is lost while access is down (it will only be found by checking Stripe)
      fx.stripe.control.dropNextWebhooks(1);
      const b = fx.stripe.control.createCharge({ amount: 3_300 }).event;
      const [ev] = await dbh.db
        .select()
        .from(incidents)
        .where(and(eq(incidents.integrationId, integ.id), eq(incidents.kind, 'connection_auth')));
      expect(ev).toMatchObject({ status: 'requires_action', customerAction: 'Reconnect QuickBooks.' });
      const [conn] = await dbh.db
        .select()
        .from(connections)
        .where(and(eq(connections.tenantId, c.tenantId), eq(connections.providerId, 'quickbooks')));
      expect(conn!.status).toBe('revoked');
      const story = await c.call<{
        state: string;
        customerAction: { required: boolean; text: string | null };
      }>('maintenance.events.get', { eventId: ev!.id });
      expect(story).toMatchObject({
        state: 'needs_you',
        customerAction: { required: true, text: 'Reconnect QuickBooks.' },
      });
      expect(entriesFor(a.id)).toHaveLength(0);

      // the customer reconnects; the maintenance event validates the authorization, releases, recovers, verifies
      expect(await c.connectQuickBooks()).toMatch(/connected=quickbooks/);
      await jobs.drain(async () => {
        const [x] = await dbh.db.select().from(incidents).where(eq(incidents.id, ev!.id));
        return x?.status === 'resolved';
      }, 60_000);
      const [done] = await dbh.db.select().from(incidents).where(eq(incidents.id, ev!.id));
      expect(done!.validation).toMatchObject({ passed: true });
      expect(done!.correction).toMatchObject({ kind: 'reauthorization', upstreamModified: false });
      expect(done!.accounting).toMatchObject({
        zeroLoss: true,
        populationComplete: true,
        unresolved: 0,
        duplicates: 0,
        delayed: 1,
        discoveredByReconciliation: 1,
      });
      expect(entriesFor(a.id)).toHaveLength(1);
      expect(entriesFor(b.id)).toHaveLength(1);
      const view = await c.call<{ state: string; claim: { zeroLoss: boolean } }>('maintenance.events.get', {
        eventId: ev!.id,
      });
      expect(view).toMatchObject({ state: 'completed', claim: { zeroLoss: true } });
    });

    it('a dependency the provider retired: reviewed patch proposed, validated, activated by an operator, verified — and rolled back', async () => {
      await setup();
      const { integ } = await onboard();
      // a transaction booked by us (the regression corpus for validating a correction)
      const first = fx.stripe.control.createCharge({ amount: 6_400 }).event;
      await jobs.drain(async () => entriesFor(first.id).length === 1);
      // The tick checks the pinned code against provider documentation (QuickBooks minor versions < 75 retired).
      await worker.handlers.tick();
      const [ev] = await dbh.db
        .select()
        .from(incidents)
        .where(and(eq(incidents.integrationId, integ.id), eq(incidents.kind, 'dependency_contract_change')));
      expect(ev!.finding).toMatchObject({
        declared: '70',
        served: '75',
        codePath: [expect.objectContaining({ file: 'src/server/dispatchers/qbo.ts', line: 25 })],
      });
      await jobs.drain(async () => {
        const [row] = await dbh.db
          .select()
          .from(adaptations)
          .where(eq(adaptations.maintenanceEventId, ev!.id));
        return row?.status === 'validated';
      });
      const [row] = await dbh.db.select().from(adaptations).where(eq(adaptations.maintenanceEventId, ev!.id));
      const v = row!.validation as {
        passed: boolean;
        requiresDecision: boolean;
        checks: { name: string; status: string }[];
      };
      expect(v).toMatchObject({ passed: true, requiresDecision: false });
      expect(v.checks.map((x) => [x.name, x.status])).toEqual([
        ['applies to the adopted artifact', 'passed'],
        ['original adopted code unchanged', 'passed'],
        ['patch reproduces the reviewed change exactly', 'passed'],
        ['regression: stored transactions unchanged', 'passed'],
        ['destination request changes only as reviewed', 'passed'],
        ['business data preserved (QuickBooks)', 'passed'],
        ['rollback target available', 'passed'],
      ]);
      // never automatic: the event waits for an operator
      expect((await dbh.db.select().from(incidents).where(eq(incidents.id, ev!.id)))[0]!.status).not.toBe(
        'resolved',
      );
      const rt = worker.registry.get(LEDGERLY_FLOW_TYPE)!;
      await rt.adaptations!.activate(
        row!.id,
        'operator:test',
        'reviewed: align with the served minor version',
      );
      // verified only after real work ran through the patched code: the next transaction
      const { event } = fx.stripe.control.createCharge({ amount: 2_000 });
      await jobs
        .drain(
          async () =>
            (await dbh.db.select().from(incidents).where(eq(incidents.id, ev!.id)))[0]!.status === 'resolved',
          60_000,
        )
        .catch(async (e: Error) => {
          // say WHY it did not resolve (the event's own persisted facts)
          const [x] = await dbh.db.select().from(incidents).where(eq(incidents.id, ev!.id));
          const runs = await dbh.db
            .select()
            .from(reconciliationRuns)
            .where(eq(reconciliationRuns.integrationId, integ.id));
          throw new Error(
            `${e.message}\nevent: ${x!.status} ${JSON.stringify(x!.evidence)} accounting: ${JSON.stringify(x!.accounting)}\nruns: ${JSON.stringify(runs.map((r) => [r.trigger, r.status, r.outcome, r.sourceCount, r.errorMessage, r.windowFrom, r.windowTo]))}\nevents: ${JSON.stringify(fx.stripe.state.events.slice(-4).map((e) => [e.id, e.created]))}`,
          );
        });
      // what runs now asks for 75; QuickBooks serves 75 as before
      await jobs.drain(async () => entriesFor(event.id).length === 1);
      const posts = fx.qbo.state.requestLog.filter(
        (r) => r.method === 'POST' && r.path.endsWith('/journalentry'),
      );
      expect(posts.at(-1)).toMatchObject({ minorRequested: 75, minorServed: 75 });
      const [after] = await dbh.db.select().from(deliveries).where(eq(deliveries.sourceId, event.id));
      expect(after!.outcome).toBe('delivered');
      // rollback: the original artifact runs again
      await rt.adaptations!.rollback(row!.id, 'operator:test', 'rollback drill');
      const e2 = fx.stripe.control.createCharge({ amount: 2_100 }).event;
      await jobs.drain(async () => entriesFor(e2.id).length === 1);
      expect(
        fx.qbo.state.requestLog.filter((r) => r.method === 'POST' && r.path.endsWith('/journalentry')).at(-1),
      ).toMatchObject({ minorRequested: 70, minorServed: 75 });
      const inspect = await rt.inspect!(integ.id);
      expect(inspect.running!.id).toBe('ledgerly:3101182eadc9');
      expect(inspect.contracts.find((x) => x.path === 'quickbooks.minorversion')!.reads[0]).toMatchObject({
        file: 'src/server/dispatchers/qbo.ts',
        line: 25,
      });
    });

    it('safety: repeated events, a partial outage, a missing event and duplicate recovery requests all end with exactly one entry each', async () => {
      await setup();
      const { integ } = await onboard();
      // repeated delivery of the same event (Stripe retries): one delivery, one entry
      const { event } = fx.stripe.control.createCharge({ amount: 9_900 });
      await jobs.drain(async () => entriesFor(event.id).length === 1);
      const body = JSON.stringify(fx.stripe.control.eventBody(event.id, '2024-06-20'));
      const secretless = await fetch(`${base}/webhooks/stripe/${integ.id}`, {
        method: 'POST',
        headers: { 'stripe-signature': 't=1,v1=00' },
        body,
      });
      expect(secretless.status).toBe(400);
      // partial outage of QuickBooks: the first attempt fails, the scheduled retry books it once
      fx.qbo.state.faults.add({ target: 'api', type: 'http503', count: 1 });
      const o = fx.stripe.control.createCharge({ amount: 5_100 }).event;
      const attempts = async () => {
        const [x] = await dbh.db.select().from(deliveries).where(eq(deliveries.sourceId, o.id));
        return x ? dbh.db.select().from(deliveryAttempts).where(eq(deliveryAttempts.deliveryId, x.id)) : [];
      };
      await jobs.drain(async () => (await attempts()).some((a) => a.outcome === 'failed'));
      // the failed attempt is rescheduled automatically (pending, with a delayed job); run it now
      const [retrying] = await dbh.db.select().from(deliveries).where(eq(deliveries.sourceId, o.id));
      expect(retrying!.outcome).toBe('pending');
      await worker.handlers.adoptedExecute({
        deliveryId: retrying!.id,
        trigger: { kind: 'automatic_retry' },
      });
      expect(entriesFor(o.id)).toHaveLength(1);
      expect((await attempts()).map((a) => a.outcome)).toEqual(['failed', 'delivered']);
      // a missing event: found by reconciliation, recovered twice concurrently → one entry
      fx.stripe.control.dropNextWebhooks(1);
      const m = fx.stripe.control.createCharge({ amount: 1_250 }).event;
      const s = await startLedgerlyReconciliation(dbh.db, {
        integrationId: integ.id,
        trigger: 'manual',
        window: { from: days(1), to: new Date(Date.now() + 1000) },
      });
      await scanLedgerlyReconciliation({
        db: dbh.db,
        cipher: testCipher,
        endpoints: config.endpoints,
        runId: s.runId,
        workerId: 'w',
      });
      const [item] = await dbh.db
        .select()
        .from(reconciliationItems)
        .where(and(eq(reconciliationItems.runId, s.runId), eq(reconciliationItems.sourceOrderId, m.id)));
      expect(item!.classification).toBe('missing_delivery');
      const deps = {
        db: dbh.db,
        cipher: testCipher,
        endpoints: config.endpoints,
        itemId: item!.id,
        requestedBy: 'operator:test',
      };
      const [r1, r2] = await Promise.all([recoverLedgerlyItem(deps), recoverLedgerlyItem(deps)]);
      expect([r1.done, r2.done].sort()).toEqual([false, true]);
      expect(entriesFor(m.id)).toHaveLength(1);
      const dels = await dbh.db.select().from(deliveries).where(eq(deliveries.sourceId, m.id));
      expect(dels).toHaveLength(1);
    });

    it('unsupported: a transaction the adopted code refuses, and Stripe data without what it reads (an unsettled charge has no balance transaction), are never written; the latter is held and routed to a person', async () => {
      await setup();
      const { integ } = await onboard();
      // upstream refuses cross-currency payouts (no FX accounting): rejected, nothing written, visible to monitoring
      const p = fx.stripe.control.createPayout({ amount: 10_000, destinationCurrency: 'eur' }).event;
      await jobs.drain(async () => {
        const [x] = await dbh.db.select().from(deliveries).where(eq(deliveries.sourceId, p.id));
        return x?.outcome === 'rejected';
      });
      const [rej] = await dbh.db.select().from(deliveries).where(eq(deliveries.sourceId, p.id));
      expect(rej!.lastError).toMatch(/cross-currency|currency/i);
      expect(entriesFor(p.id)).toHaveLength(0);
      // Stripe data without what upstream reads: a charge whose funds have not settled has no balance transaction
      const { charge, event } = fx.stripe.control.createCharge({ amount: 4_000 });
      fx.stripe.state.bts.delete(charge.balance_transaction);
      (fx.stripe.state.charges.get(charge.id) as { balance_transaction: string | null }).balance_transaction =
        null as never;
      await jobs.drain(async () => {
        const [x] = await dbh.db
          .select()
          .from(incidents)
          .where(and(eq(incidents.integrationId, integ.id), eq(incidents.kind, 'input_contract_change')));
        return !!(x?.evidence as { maintenance?: { escalated?: string } })?.maintenance?.escalated;
      });
      const [held] = await dbh.db.select().from(deliveries).where(eq(deliveries.sourceId, event.id));
      expect(held!.outcome).toBe('held');
      const [un] = await dbh.db.select().from(adaptations).where(eq(adaptations.integrationId, integ.id));
      expect(un).toMatchObject({ kind: 'unsupported', status: 'unsupported' });
      expect(entriesFor(event.id)).toHaveLength(0);
    });

    it('one organization, two integrations: shared connections, one onboarding per integration, both managed and monitored through their own runtimes', async () => {
      shop = createShopifyFixture({ shopDomain: 'lumen-studio.myshopify.com', firstOrderId: 7_100_000_001n });
      ns = createNetSuiteFixture();
      await shop.app.listen({ port: 0, host: '127.0.0.1' });
      await ns.app.listen({ port: 0, host: '127.0.0.1' });
      ns.state.oneWorld = false; // the adopted Shopify code sends no subsidiary (documented gap)
      await setup({
        SHOPIFY_CLIENT_ID: shop.clientId,
        SHOPIFY_CLIENT_SECRET: shop.clientSecret,
        SHOPIFY_BASE_URL_OVERRIDE: `http://127.0.0.1:${(shop.app.server.address() as AddressInfo).port}`,
        NETSUITE_BASE_URL_OVERRIDE: `http://127.0.0.1:${(ns.app.server.address() as AddressInfo).port}`,
      });
      const { c, integ: stripeInteg } = await onboard();
      // the same customer adds their store: Shopify and NetSuite are connected once, next to Stripe and QuickBooks
      expect(await c.connectShopify('lumen-studio.myshopify.com')).toMatch(/connected=shopify/);
      expect((await c.connectNetSuite()).status).toBe('verified');
      const both = await c.call<Status>('onboarding.discover');
      expect(both.systems.map((x) => [x.id, x.connected])).toEqual([
        ['shopify', true],
        ['netsuite', true],
        ['stripe', true],
        ['quickbooks', true],
      ]);
      // (slice 7: applications that depend on one of these providers are offered too; this test is about the pipelines)
      expect(
        both.integrations
          .filter((x) => [SHOPIFY_NETSUITE.flowType, LEDGERLY_FLOW_TYPE].includes(x.flowType))
          .map((x) => [x.flowType, x.status]),
      ).toEqual([
        [SHOPIFY_NETSUITE.flowType, 'select'],
        [LEDGERLY_FLOW_TYPE, 'managed'],
      ]);
      // the Shopify store has no existing integration: the customer chooses the managed one (starts now)
      const shopFlow = both.integrations.find((x) => x.flowType === SHOPIFY_NETSUITE.flowType)!;
      expect(shopFlow.discovery!.candidates.map((x) => x.id)).toEqual(['new.shopify_orders_netsuite']);
      await c.call('onboarding.confirm', {
        candidateId: 'new.shopify_orders_netsuite',
        responsibilitiesVersion: shopFlow.responsibilities.version,
        flowType: SHOPIFY_NETSUITE.flowType,
      });
      await jobs.drain(
        async () =>
          (await c.call<Status>('onboarding.status')).integrations
            .filter((x) => [SHOPIFY_NETSUITE.flowType, LEDGERLY_FLOW_TYPE].includes(x.flowType))
            .every((x) => x.status === 'managed'),
        60_000,
      );
      // one connection per provider, one onboarding record per integration kind
      expect(
        (await dbh.db.select().from(connections).where(eq(connections.tenantId, c.tenantId)))
          .map((x) => x.providerId)
          .sort(),
      ).toEqual(['netsuite', 'quickbooks', 'shopify', 'stripe']);
      const obs = (await dbh.db.select().from(onboardings).where(eq(onboardings.tenantId, c.tenantId))).map((x) => x.flowType);
      expect(new Set(obs).size).toBe(obs.length);
      expect(obs).toEqual(expect.arrayContaining([SHOPIFY_NETSUITE.flowType, LEDGERLY_FLOW_TYPE]));
      // the customer product: two integrations, each described in its own business terms
      const portfolio = await c.call<{ integrations: { name: string; process: string }[] }>('portfolio.list');
      expect(portfolio.integrations.map((x) => [x.name, x.process]).sort()).toEqual([
        ['Shopify → NetSuite orders', 'Shopify orders become NetSuite sales orders'],
        [
          'Stripe → QuickBooks accounting',
          'Stripe payments, refunds and payouts become balanced QuickBooks journal entries',
        ],
      ]);
      // monitoring: the shared tick probes each integration through its own runtime and records durable facts
      await worker.handlers.tick();
      const facts = await dbh.db.select().from(observations).where(eq(observations.kind, 'monitoring'));
      expect(new Set(facts.map((f) => f.integrationId)).size).toBe(2);
      const stripeFacts = facts.find((f) => f.integrationId === stripeInteg.id)!.data as {
        signals: { signal: string; state: string }[];
      };
      expect(
        stripeFacts.signals
          .filter((x) => ['source_available', 'destination_available', 'credentials'].includes(x.signal))
          .map((x) => x.state),
      ).toEqual(['ok', 'ok', 'ok']);
    });

    it('isolation and authority: another customer sees nothing of it, cannot confirm it, and no customer can touch corrections', async () => {
      await setup();
      const { c, integ } = await onboard();
      const other = await customer('someone@else.test');
      expect(await other.call<Status>('onboarding.status')).toMatchObject({
        status: 'connect',
        integrations: [],
      });
      await expect(
        other.call('onboarding.confirm', { candidateId: 'adopted.ledgerly', responsibilitiesVersion: 's1' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(other.call('portfolio.integration', { integrationId: integ.id })).rejects.toBeTruthy();
      // duplicate activation: confirming again is refused; one integration exists
      await expect(
        c.call('onboarding.confirm', {
          candidateId: 'adopted.ledgerly',
          responsibilitiesVersion: 's1',
          flowType: LEDGERLY_FLOW_TYPE,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(
        await dbh.db.select().from(integrations).where(eq(integrations.flowType, LEDGERLY_FLOW_TYPE)),
      ).toHaveLength(1);
      for (const [name, input] of [
        ['adaptations.inspect', { integrationId: integ.id }],
        [
          'adaptations.propose',
          { integrationId: integ.id, patchId: 'p0001-qbo-minor-version-75', reason: 'customer tries' },
        ],
        ['monitoring.integration', { integrationId: integ.id }],
      ] as const)
        await expect(c.call(name, input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    /* ======================= slice 7: target boundary ======================= */

    it('target-only change: an account the mapping posts to is made inactive — held, customer decides, a failed validation is rejected, the corrected configuration is validated, recovered, verified; history untouched; rollback restores', async () => {
      // INVARIANT: every Stripe transaction lands in QuickBooks exactly once, balanced, with the same amounts and
      // sides, on an account of the same kind; entries already in the books are never rewritten.
      await setup();
      const { c, integ } = await onboard();
      const before = fx.stripe.control.createCharge({ amount: 4_200 }).event;
      await jobs.drain(async () => entriesFor(before.id).length === 1);
      // The customer reorganizes their chart of accounts: a new clearing account, the old one made inactive.
      const newId = fx.qbo.control.addAccount('Stripe Clearing 2027', 'Other Current Asset');
      fx.qbo.control.deactivateAccount('91');
      const held = fx.stripe.control.createCharge({ amount: 6_600 }).event;
      await jobs.drain(async () => {
        const [x] = await dbh.db
          .select()
          .from(incidents)
          .where(and(eq(incidents.integrationId, integ.id), eq(incidents.kind, 'target_contract_change')));
        return x?.status === 'requires_action';
      });
      const [ev] = await dbh.db
        .select()
        .from(incidents)
        .where(and(eq(incidents.integrationId, integ.id), eq(incidents.kind, 'target_contract_change')));
      // detection with evidence: the refusal AND QuickBooks' own account record
      expect(ev).toMatchObject({
        boundary: 'target',
        finding: {
          observed: { code: '610' },
          inactiveAccounts: [{ qboId: '91', code: '1010', type: 'Other Current Asset' }],
        },
      });
      expect(ev!.impactAssessment).toMatchObject({
        boundary: 'target',
        affectedTransactions: [expect.stringContaining('Charge')],
      });
      const [hd] = await dbh.db.select().from(deliveries).where(eq(deliveries.sourceId, held.id));
      expect(hd).toMatchObject({ outcome: 'held', lastErrorClass: 'target_contract' });
      expect(entriesFor(held.id)).toHaveLength(0);
      // the customer sees a business question with evidence-backed options (same account type only)
      type Ev = {
        state: string;
        decision: { id: string; question: string; options: { id: string; label: string }[] } | null;
      };
      const story = await c.call<Ev>('maintenance.events.get', { eventId: ev!.id });
      expect(story.state).toBe('needs_you');
      expect(story.decision!.options.map((o) => o.label).sort()).toEqual([
        'Disputes Receivable',
        'Stripe Clearing 2027',
      ]);
      // a choice that fails validation (the account was made inactive after the question was asked) is rejected
      fx.qbo.control.deactivateAccount('92');
      await c.call('maintenance.decide', { eventId: ev!.id, decisionId: story.decision!.id, optionId: '92' });
      await jobs.drain(
        async () => !!(await c.call<Ev>('maintenance.events.get', { eventId: ev!.id })).decision,
      );
      const corr1 = await dbh.db
        .select()
        .from(adaptations)
        .where(and(eq(adaptations.maintenanceEventId, ev!.id), eq(adaptations.kind, 'configuration')));
      expect(corr1.map((x) => x.status)).toEqual(['rejected']);
      expect(
        (corr1[0]!.validation as { checks: { name: string; status: string }[] }).checks.find((x) =>
          x.name.startsWith('replacement account'),
        )!.status,
      ).toBe('failed');
      expect(entriesFor(held.id)).toHaveLength(0); // still held: nothing activated
      // the customer chooses again; validated; activated; held work posted and verified
      const again = await c.call<Ev>('maintenance.events.get', { eventId: ev!.id });
      expect(again.decision!.options.map((o) => o.id)).toEqual([newId]);
      await c.call('maintenance.decide', {
        eventId: ev!.id,
        decisionId: again.decision!.id,
        optionId: newId,
      });
      await jobs.drain(
        async () =>
          (await dbh.db.select().from(incidents).where(eq(incidents.id, ev!.id)))[0]!.status === 'resolved',
        60_000,
      );
      const [done] = await dbh.db.select().from(incidents).where(eq(incidents.id, ev!.id));
      expect(done!.accounting).toMatchObject({
        zeroLoss: true,
        populationComplete: true,
        unresolved: 0,
        duplicates: 0,
        delayed: 1,
      });
      const [je] = entriesFor(held.id);
      expect(
        je!.Line.find(
          (l) =>
            l.JournalEntryLineDetail.PostingType === 'Debit' &&
            l.JournalEntryLineDetail.AccountRef.value === newId,
        ),
      ).toBeTruthy();
      // history untouched: the earlier entry still posts to the (now inactive) original account, and still verifies
      expect(
        entriesFor(before.id)[0]!.Line.some((l) => l.JournalEntryLineDetail.AccountRef.value === '91'),
      ).toBe(true);
      const corr = await dbh.db.select().from(adaptations).where(eq(adaptations.maintenanceEventId, ev!.id));
      expect(corr.map((x) => [x.kind, x.boundary, x.status])).toEqual([
        ['decision', 'target', 'active'],
        ['configuration', 'target', 'rejected'],
        ['decision', 'target', 'active'],
        ['configuration', 'target', 'active'],
      ]);
      // the boundary's durable record: baseline acceptance, the refusal (answered), what is active
      const obs = await dbh.db
        .select()
        .from(contractObservations)
        .where(
          and(
            eq(contractObservations.integrationId, integ.id),
            eq(contractObservations.contract, 'quickbooks.journalentry.write'),
          ),
        );
      expect(obs.map((o) => o.status).sort()).toEqual(['accepted', 'baseline']);
      // rollback restores the previous mapping; accounting and evidence of the event remain
      const active = corr.find((x) => x.kind === 'configuration' && x.status === 'active')!;
      await worker.registry
        .get(LEDGERLY_FLOW_TYPE)!
        .adaptations!.rollback(active.id, 'operator:test', 'rollback drill');
      const [after] = await dbh.db.select().from(integrations).where(eq(integrations.id, integ.id));
      expect(
        (after!.config as { accountMap: Record<string, { qboId: string }> }).accountMap['1010']!.qboId,
      ).toBe('91');
      expect(
        (await dbh.db.select().from(incidents).where(eq(incidents.id, ev!.id)))[0]!.accounting,
      ).toMatchObject({ zeroLoss: true });
    });

    it('incorrect destination data despite a successful API response: detected by read-back, nothing edited in the books, the customer is asked, no zero-loss claim', async () => {
      await setup();
      const { c, integ } = await onboard();
      // Something in the customer's company rewrites entries after they are saved (QuickBooks still answers 200).
      fx.qbo.state.mutateOnCreate = (e) => {
        const fee = e.Line.find((l) => l.JournalEntryLineDetail.AccountRef.value === '97');
        const clearing = e.Line.find((l) => l.JournalEntryLineDetail.AccountRef.value === '91');
        if (fee && clearing) {
          fee.Amount = Math.round((fee.Amount + 1) * 100) / 100;
          clearing.Amount = Math.round((clearing.Amount - 1) * 100) / 100;
        }
      };
      const x = fx.stripe.control.createCharge({ amount: 10_000 }).event;
      await jobs.drain(async () => {
        const [i] = await dbh.db
          .select()
          .from(incidents)
          .where(and(eq(incidents.integrationId, integ.id), eq(incidents.kind, 'destination_mismatch')));
        return !!(i?.evidence as { maintenance?: { escalated?: string } } | undefined)?.maintenance
          ?.escalated;
      });
      const [del] = await dbh.db.select().from(deliveries).where(eq(deliveries.sourceId, x.id));
      expect(del!.validation).toMatchObject({
        destinationMismatch: { journalEntryIds: [expect.any(String)] },
      });
      const [ev] = await dbh.db
        .select()
        .from(incidents)
        .where(and(eq(incidents.integrationId, integ.id), eq(incidents.kind, 'destination_mismatch')));
      expect(ev).toMatchObject({ boundary: 'target', status: 'requires_action' });
      const story = await c.call<{
        state: string;
        claim: { zeroLoss: boolean };
        customerAction: { text: string };
      }>('maintenance.events.get', { eventId: ev!.id });
      expect(story).toMatchObject({
        state: 'needs_you',
        claim: { zeroLoss: false },
        customerAction: { text: 'Review the listed entries in QuickBooks.' },
      });
      expect(entriesFor(x.id)).toHaveLength(1); // nothing deleted or duplicated
      // independent reconciliation agrees: the entry exists but is not what Stripe implies
      const s = await startLedgerlyReconciliation(dbh.db, {
        integrationId: integ.id,
        trigger: 'manual',
        window: { from: days(1), to: new Date(Date.now() + 1000) },
      });
      await scanLedgerlyReconciliation({
        db: dbh.db,
        cipher: testCipher,
        endpoints: config.endpoints,
        runId: s.runId,
        workerId: 'w',
      });
      const [item] = await dbh.db
        .select()
        .from(reconciliationItems)
        .where(and(eq(reconciliationItems.runId, s.runId), eq(reconciliationItems.sourceOrderId, x.id)));
      expect(item).toMatchObject({ classification: 'ambiguous' });
      expect(item!.reason).toMatch(/accounts or amounts differ/);
    });

    it('incomplete source population: when Stripe cannot be read completely, the check is partial and nothing is claimed', async () => {
      await setup();
      const { integ } = await onboard();
      fx.stripe.state.faults.add({ target: 'api', type: 'http503', count: 20 });
      const s = await startLedgerlyReconciliation(dbh.db, {
        integrationId: integ.id,
        trigger: 'manual',
        window: { from: days(5), to: new Date() },
      });
      await scanLedgerlyReconciliation({
        db: dbh.db,
        cipher: testCipher,
        endpoints: config.endpoints,
        runId: s.runId,
        workerId: 'w',
      });
      const [run] = await dbh.db.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, s.runId));
      expect(run).toMatchObject({ status: 'completed', outcome: 'partial' });
      const acc = accountTransactions({
        window: { from: run!.windowFrom, to: run!.windowTo },
        sourceRunId: run!.id,
        readCompletely: false,
        items: [],
        affectedSourceIds: [],
        detectedAt: new Date(),
      });
      expect(acc).toMatchObject({ zeroLoss: false, populationComplete: false });
    });
  },
);
