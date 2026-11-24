/**
 * Test support for the Stripe → QuickBooks integration (slice 6): fixtures on ephemeral ports, the customer's
 * EXISTING ledgerly deployment (the pinned upstream code with their own QuickBooks authorization, writing real
 * history before they come to us), and a queue drainer that runs jobs through the REAL worker handlers.
 * Fixture-only: no live Stripe account or QuickBooks company is involved.
 */
import type { AddressInfo } from 'node:net';
import { loadLedgerly, stripeSdk, type QboAccountMap } from '@mi/adopted-ledgerly';
import { QUEUES } from '@mi/contracts';
import {
  createQuickBooksFixture,
  createStripeFixture,
  QBO_DEFAULT_ACCOUNTS,
  type QuickBooksFixture,
  type StripeFixture,
} from '@mi/test-fixtures';

export async function startStripeQuickbooks(prefix = 'Fx') {
  const stripe = createStripeFixture({ prefix });
  const qbo = createQuickBooksFixture();
  await stripe.app.listen({ port: 0, host: '127.0.0.1' });
  await qbo.app.listen({ port: 0, host: '127.0.0.1' });
  const stripeUrl = `http://127.0.0.1:${(stripe.app.server.address() as AddressInfo).port}`;
  const qboUrl = `http://127.0.0.1:${(qbo.app.server.address() as AddressInfo).port}`;
  return {
    stripe,
    qbo,
    stripeUrl,
    qboUrl,
    env: {
      STRIPE_BASE_URL_OVERRIDE: stripeUrl,
      QBO_BASE_URL_OVERRIDE: qboUrl,
      QBO_CLIENT_ID: qbo.clientId,
      QBO_CLIENT_SECRET: qbo.clientSecret,
    },
    async close() {
      await stripe.app.close();
      await qbo.app.close();
    },
  };
}

const silent = { info() {}, warn() {}, error() {}, debug() {} };

export interface TheirDeploymentConfig {
  stripeUrl: string;
  stripeKey: string;
  qboUrl: string;
  qboClientId: string;
  qboClientSecret: string;
  realmId: string;
}
type Fixtures = { stripe: StripeFixture; qbo: QuickBooksFixture; stripeUrl: string; qboUrl: string };

/** The customer's own deployment of ledgerly, posting with their own QuickBooks authorization. */
export async function theirLedgerly(f0: TheirDeploymentConfig | Fixtures) {
  const c: TheirDeploymentConfig =
    'stripeKey' in f0
      ? f0
      : {
          stripeUrl: f0.stripeUrl,
          stripeKey: f0.stripe.apiKey(),
          qboUrl: f0.qboUrl,
          qboClientId: f0.qbo.clientId,
          qboClientSecret: f0.qbo.clientSecret,
          realmId: f0.qbo.realmId,
        };
  const f = {
    stripeUrl: c.stripeUrl,
    qboUrl: c.qboUrl,
    qbo: { clientId: c.qboClientId, clientSecret: c.qboClientSecret, realmId: c.realmId },
  };
  const redirect = 'http://their-ledgerly.example/oauth/qbo/callback';
  const auth = await fetch(
    `${f.qboUrl}/connect/oauth2?client_id=${f.qbo.clientId}&response_type=code&scope=com.intuit.quickbooks.accounting&redirect_uri=${encodeURIComponent(redirect)}&state=s`,
    { redirect: 'manual' },
  );
  const code = new URL(auth.headers.get('location')!).searchParams.get('code')!;
  const tok = (await (
    await fetch(`${f.qboUrl}/oauth2/v1/tokens/bearer`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${f.qbo.clientId}:${f.qbo.clientSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirect,
      }).toString(),
    })
  ).json()) as { access_token: string };
  const { modules } = await loadLedgerly();
  const sdk = stripeSdk(c.stripeKey, f.stripeUrl);
  const accountMap: QboAccountMap = Object.fromEntries(
    Object.values(modules.ACCOUNTS).map((a) => [
      a.code,
      { qboId: QBO_DEFAULT_ACCOUNTS[a.name]!, name: a.name },
    ]),
  );
  return {
    accountMap,
    /** Processes one Stripe event exactly as their ledgerly receiver would. */
    async process(eventId: string) {
      const ev = await sdk.events.retrieve(eventId);
      const r = modules.mapEvent(await modules.expandEvent(sdk, ev));
      const send = modules.qboDispatcher({
        accessToken: tok.access_token,
        realmId: f.qbo.realmId,
        accountMap,
        apiBase: f.qboUrl,
        log: silent,
      });
      for (const entry of r.entries) await send({ id: 1, entry, subscriptionId: null });
      return r.entries.length;
    },
  };
}

type Handlers = Record<string, (data: unknown) => Promise<unknown>>;
const QUEUE_HANDLERS: [string, string][] = [
  [QUEUES.adoptedExecute, 'adoptedExecute'],
  [QUEUES.adoptedReconcile, 'adoptedReconcile'],
  [QUEUES.adoptedRecover, 'adoptedRecover'],
  [QUEUES.adoptedMaintenance, 'adoptedMaintenance'],
  [QUEUES.adoptedAdaptationValidate, 'adoptedAdaptationValidate'],
  [QUEUES.onboardingActivate, 'onboardingActivate'],
];

/** Plays the worker: fetches queued jobs and runs them through the worker's own handlers. */
/** The subset of pg-boss the drainer uses. */
interface Boss {
  fetch(name: string, opts: { batchSize: number }): Promise<unknown>;
  complete(name: string, id: string): Promise<unknown>;
  fail(name: string, id: string, data?: object): Promise<unknown>;
}
export function drainer(boss: Boss, handlers: Handlers) {
  const log: string[] = [];
  async function round() {
    let n = 0;
    for (const [q, h] of QUEUE_HANDLERS) {
      const jobs = ((await boss.fetch(q, { batchSize: 20 })) ?? []) as { id: string; data: unknown }[];
      for (const j of jobs) {
        n++;
        try {
          await handlers[h]!(j.data);
          await boss.complete(q, j.id);
          log.push(h);
        } catch (err) {
          log.push(`${h}:error:${String(err)}`);
          await boss.fail(q, j.id, { message: String(err) });
        }
      }
    }
    return n;
  }
  return {
    log,
    /** Runs queued work until `until` holds (or, without it, until the queues stay empty). */
    async drain(until?: () => Promise<boolean>, maxMs = 30_000) {
      const end = Date.now() + maxMs;
      let idle = 0;
      while (Date.now() < end) {
        const n = await round();
        if (until && (await until())) return;
        if (!n) {
          idle++;
          if (!until && idle >= 4) return;
          await new Promise((r) => setTimeout(r, 250));
        } else idle = 0;
      }
      if (until) throw new Error(`drain: condition not met (last jobs: ${log.slice(-12).join(', ')})`);
    },
  };
}
