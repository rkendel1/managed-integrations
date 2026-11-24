/**
 * DETERMINISTIC TEST FIXTURE — NOT STRIPE.
 *
 * A local server modelling the subset of the Stripe API the Stripe → QuickBooks integration uses, from
 * Stripe's public documentation:
 *  - bearer secret / restricted keys; GET /v1/account;
 *  - Events API (GET /v1/events, newest first, `created` filters, `starting_after` pagination; 30-day
 *    retention is documented by Stripe and not enforced here);
 *  - retrieve with `expand[]` (charges, invoices, invoice lines, refunds, payouts);
 *  - versioned rendering: objects are rendered for the request's `Stripe-Version` (or the account default),
 *    and webhook bodies for the ENDPOINT's API version. Invoices from 2025-03-31 ("basil") have no `charge`,
 *    `paid` or `payment_intent` (they have `payments`, `parent`, `total_taxes`), as Stripe's changelog states;
 *  - webhook endpoints (POST/GET /v1/webhook_endpoints) and signed deliveries
 *    (Stripe-Signature: t=<unix>,v1=<HMAC-SHA256(secret, "<t>.<body>")>).
 * Webhook bodies are NOT expanded (nested objects are ids), as in real Stripe webhooks.
 */
import { createHmac } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { FaultQueue } from './faults.ts';

export const STRIPE_BASIL = '2025-03-31.basil';
const isBasil = (v: string) => v >= '2025-03-31';

type Unix = number;
interface Bt {
  id: string;
  amount: number;
  fee: number;
  net: number;
  currency: string;
  type: string;
  created: Unix;
  reporting_category: string;
}
interface Charge {
  id: string;
  amount: number;
  currency: string;
  customer: string | null;
  invoice: string | null;
  balance_transaction: string;
  refunds: string[];
  created: Unix;
}
interface Refund {
  id: string;
  amount: number;
  charge: string;
  created: Unix;
  balance_transaction: string;
  currency: string;
}
interface Invoice {
  id: string;
  customer: string;
  currency: string;
  amount_paid: number;
  charges: string[];
  created: Unix;
  subscription: string;
  periodDays: number;
}
interface Payout {
  id: string;
  amount: number;
  currency: string;
  arrival_date: Unix;
  created: Unix;
  destination: string;
  destinationCurrency: string;
}
interface StoredEvent {
  id: string;
  type: string;
  created: Unix;
  /** The account's API version when the event was created. */
  api_version: string;
  object: { kind: 'charge' | 'invoice' | 'payout'; id: string };
}
interface Endpoint {
  id: string;
  url: string;
  secret: string;
  api_version: string;
  enabled_events: string[];
  status: 'enabled';
}

export interface StripeFixtureOptions {
  accountId?: string;
  apiKey?: string;
  /** Account default API version (events are created at it). */
  accountApiVersion?: string;
  prefix?: string;
}

export type StripeFixture = ReturnType<typeof createStripeFixture>;

export function createStripeFixture(opts: StripeFixtureOptions = {}) {
  const accountId = opts.accountId ?? 'acct_1FixtureStripe';
  const prefix = opts.prefix ?? 'Fx';
  const state = {
    apiKey: opts.apiKey ?? `rk_test_${prefix}fixturekey000000000000`,
    keyRevoked: false,
    accountApiVersion: opts.accountApiVersion ?? '2024-06-20',
    bts: new Map<string, Bt>(),
    charges: new Map<string, Charge>(),
    refunds: new Map<string, Refund>(),
    invoices: new Map<string, Invoice>(),
    payouts: new Map<string, Payout>(),
    events: [] as StoredEvent[],
    endpoints: [] as Endpoint[],
    dropWebhooks: 0,
    deliveries: [] as {
      at: string;
      eventId: string;
      url: string;
      apiVersion: string;
      status: number | null;
      dropped?: boolean;
    }[],
    requestLog: [] as { at: string; method: string; path: string; version: string | null }[],
    faults: new FaultQueue(),
  };
  let seq = 0;
  const id = (p: string) => `${p}_${prefix}${String(++seq).padStart(18, '0')}`;
  const now = (): Unix => Math.floor(Date.now() / 1000);

  /* ------------------------------------------------------------------ rendering */

  const renderBt = (b: Bt) => ({
    id: b.id,
    object: 'balance_transaction',
    amount: b.amount,
    available_on: b.created + 2 * 86400,
    created: b.created,
    currency: b.currency,
    exchange_rate: null,
    fee: b.fee,
    fee_details: b.fee
      ? [
          {
            amount: b.fee,
            application: null,
            currency: b.currency,
            description: 'Stripe processing fees',
            type: 'stripe_fee',
          },
        ]
      : [],
    net: b.net,
    reporting_category: b.reporting_category,
    status: 'available',
    type: b.type,
  });
  // Stripe: expanding a nested path (charge.balance_transaction) also expands every parent on it (charge).
  const has = (expand: string[], path: string) => expand.some((e) => e === path || e.startsWith(`${path}.`));
  const sub = (expand: string[], key: string) =>
    expand.filter((e) => e.startsWith(`${key}.`)).map((e) => e.slice(key.length + 1));

  function renderRefund(r: Refund, expand: string[]) {
    return {
      id: r.id,
      object: 'refund',
      amount: r.amount,
      balance_transaction: has(expand, 'balance_transaction')
        ? renderBt(state.bts.get(r.balance_transaction)!)
        : r.balance_transaction,
      charge: r.charge,
      created: r.created,
      currency: r.currency,
      status: 'succeeded',
    };
  }
  function renderCharge(c: Charge, expand: string[], version: string): Record<string, unknown> {
    const refunds = c.refunds.map((x) => state.refunds.get(x)!);
    return {
      id: c.id,
      object: 'charge',
      amount: c.amount,
      amount_captured: c.amount,
      amount_refunded: refunds.reduce((a, r) => a + r.amount, 0),
      application_fee_amount: null,
      balance_transaction: c.balance_transaction
        ? has(expand, 'balance_transaction')
          ? renderBt(state.bts.get(c.balance_transaction)!)
          : c.balance_transaction
        : null,
      captured: true,
      created: c.created,
      currency: c.currency,
      customer: c.customer,
      invoice: c.invoice
        ? has(expand, 'invoice')
          ? renderInvoice(state.invoices.get(c.invoice)!, sub(expand, 'invoice'), version)
          : c.invoice
        : null,
      metadata: {},
      paid: true,
      refunded: refunds.reduce((a, r) => a + r.amount, 0) >= c.amount,
      refunds: {
        object: 'list',
        data: refunds
          .slice()
          .reverse()
          .map((r) => renderRefund(r, sub(expand, 'refunds.data'))),
        has_more: false,
        total_count: refunds.length,
        url: `/v1/charges/${c.id}/refunds`,
      },
      status: 'succeeded',
    };
  }
  function renderInvoice(i: Invoice, expand: string[], version: string): Record<string, unknown> {
    const line = {
      id: `il_${i.id.slice(3)}`,
      object: 'line_item',
      amount: i.amount_paid,
      currency: i.currency,
      period: { start: i.created, end: i.created + i.periodDays * 86400 },
      proration: false,
      subscription: i.subscription,
      type: 'subscription',
    };
    const base: Record<string, unknown> = {
      id: i.id,
      object: 'invoice',
      amount_due: i.amount_paid,
      amount_paid: i.amount_paid,
      amount_remaining: 0,
      billing_reason: 'subscription_cycle',
      created: i.created,
      currency: i.currency,
      customer: i.customer,
      ending_balance: 0,
      lines: {
        object: 'list',
        data: [line],
        has_more: false,
        total_count: 1,
        url: `/v1/invoices/${i.id}/lines`,
      },
      starting_balance: 0,
      status: 'paid',
      subscription: i.subscription,
      total: i.amount_paid,
    };
    if (isBasil(version)) {
      // 2025-03-31.basil: charge / payment_intent / paid removed; payments, parent and total_taxes added.
      base['parent'] = {
        type: 'subscription_details',
        subscription_details: { subscription: i.subscription },
      };
      base['total_taxes'] = [];
      delete base['subscription'];
      if (has(expand, 'payments'))
        base['payments'] = {
          object: 'list',
          data: i.charges.map((c, n) => ({
            id: `inpay_${i.id.slice(3)}${n}`,
            object: 'invoice_payment',
            amount_paid: state.charges.get(c)!.amount,
            payment: { type: 'charge', charge: c },
            status: 'paid',
          })),
          has_more: false,
        };
      return base;
    }
    // Before basil an invoice has one charge. (An invoice with several payments cannot be represented.)
    const ch = i.charges.at(-1) ?? null;
    return {
      ...base,
      charge: ch
        ? has(expand, 'charge')
          ? renderCharge(state.charges.get(ch)!, sub(expand, 'charge'), version)
          : ch
        : null,
      paid: true,
      tax: null,
    };
  }
  function renderPayout(p: Payout, expand: string[]) {
    return {
      id: p.id,
      object: 'payout',
      amount: p.amount,
      arrival_date: p.arrival_date,
      automatic: true,
      created: p.created,
      currency: p.currency,
      destination: has(expand, 'destination')
        ? {
            id: p.destination,
            object: 'bank_account',
            currency: p.destinationCurrency,
            country: 'US',
            last4: '6789',
          }
        : p.destination,
      method: 'standard',
      source_type: 'card',
      status: 'paid',
      type: 'bank_account',
    };
  }
  function renderObject(o: StoredEvent['object'], version: string, expand: string[] = []) {
    if (o.kind === 'charge') return renderCharge(state.charges.get(o.id)!, expand, version);
    if (o.kind === 'invoice') return renderInvoice(state.invoices.get(o.id)!, expand, version);
    return renderPayout(state.payouts.get(o.id)!, expand);
  }
  /** An event as Stripe renders it at an API version (nested objects unexpanded). */
  function renderEvent(e: StoredEvent, version = e.api_version) {
    return {
      id: e.id,
      object: 'event',
      api_version: version,
      created: e.created,
      data: { object: renderObject(e.object, version) },
      livemode: false,
      pending_webhooks: state.endpoints.length,
      request: { id: null, idempotency_key: null },
      type: e.type,
    };
  }

  /* ------------------------------------------------------------------ webhooks */

  function deliver(e: StoredEvent) {
    for (const ep of state.endpoints) {
      if (!ep.enabled_events.includes(e.type) && !ep.enabled_events.includes('*')) continue;
      const body = JSON.stringify(renderEvent(e, ep.api_version));
      const rec: (typeof state.deliveries)[number] = {
        at: new Date().toISOString(),
        eventId: e.id,
        url: ep.url,
        apiVersion: ep.api_version,
        status: null,
      };
      state.deliveries.push(rec);
      if (state.dropWebhooks > 0) {
        state.dropWebhooks--;
        rec.dropped = true;
        continue;
      }
      const t = now();
      const sig = createHmac('sha256', ep.secret).update(`${t}.${body}`).digest('hex');
      void fetch(ep.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'stripe-signature': `t=${t},v1=${sig}`,
        },
        body,
      })
        .then((r) => {
          rec.status = r.status;
        })
        .catch(() => {
          rec.status = 0;
        });
    }
  }
  function emit(type: string, object: StoredEvent['object'], created: Unix) {
    const e: StoredEvent = { id: id('evt'), type, created, api_version: state.accountApiVersion, object };
    state.events.push(e);
    deliver(e);
    return e;
  }

  /* ------------------------------------------------------------------ control */

  const control = {
    /** A one-off card charge (charge.succeeded). */
    createCharge(p: { amount: number; fee?: number; currency?: string; customer?: string; at?: Date }) {
      const created = p.at ? Math.floor(p.at.getTime() / 1000) : now();
      const fee = p.fee ?? Math.round(p.amount * 0.029) + 30;
      const currency = p.currency ?? 'usd';
      const bt: Bt = {
        id: id('txn'),
        amount: p.amount,
        fee,
        net: p.amount - fee,
        currency,
        type: 'charge',
        created,
        reporting_category: 'charge',
      };
      state.bts.set(bt.id, bt);
      const ch: Charge = {
        id: id('ch'),
        amount: p.amount,
        currency,
        customer: p.customer ?? id('cus'),
        invoice: null,
        balance_transaction: bt.id,
        refunds: [],
        created,
      };
      state.charges.set(ch.id, ch);
      return { charge: ch, event: emit('charge.succeeded', { kind: 'charge', id: ch.id }, created) };
    },
    /** A paid subscription invoice: charge.succeeded (booked via the invoice) and invoice.payment_succeeded. */
    payInvoice(p: {
      amount: number;
      fee?: number;
      currency?: string;
      customer?: string;
      at?: Date;
      periodDays?: number;
    }) {
      const created = p.at ? Math.floor(p.at.getTime() / 1000) : now();
      const customer = p.customer ?? id('cus');
      const inv: Invoice = {
        id: id('in'),
        customer,
        currency: p.currency ?? 'usd',
        amount_paid: p.amount,
        charges: [],
        created,
        subscription: id('sub'),
        periodDays: p.periodDays ?? 30,
      };
      state.invoices.set(inv.id, inv);
      const fee = p.fee ?? Math.round(p.amount * 0.029) + 30;
      const bt: Bt = {
        id: id('txn'),
        amount: p.amount,
        fee,
        net: p.amount - fee,
        currency: inv.currency,
        type: 'charge',
        created,
        reporting_category: 'charge',
      };
      state.bts.set(bt.id, bt);
      const ch: Charge = {
        id: id('ch'),
        amount: p.amount,
        currency: inv.currency,
        customer,
        invoice: inv.id,
        balance_transaction: bt.id,
        refunds: [],
        created,
      };
      state.charges.set(ch.id, ch);
      inv.charges.push(ch.id);
      const chargeEvent = emit('charge.succeeded', { kind: 'charge', id: ch.id }, created);
      return {
        invoice: inv,
        charge: ch,
        chargeEvent,
        event: emit('invoice.payment_succeeded', { kind: 'invoice', id: inv.id }, created),
      };
    },
    /** A second (partial) payment on an invoice: representable only in basil and later. */
    addInvoicePayment(invoiceId: string, amount: number) {
      const inv = state.invoices.get(invoiceId)!;
      const created = now();
      const fee = Math.round(amount * 0.029) + 30;
      const bt: Bt = {
        id: id('txn'),
        amount,
        fee,
        net: amount - fee,
        currency: inv.currency,
        type: 'charge',
        created,
        reporting_category: 'charge',
      };
      state.bts.set(bt.id, bt);
      const ch: Charge = {
        id: id('ch'),
        amount,
        currency: inv.currency,
        customer: inv.customer,
        invoice: inv.id,
        balance_transaction: bt.id,
        refunds: [],
        created,
      };
      state.charges.set(ch.id, ch);
      inv.charges.push(ch.id);
      inv.amount_paid += amount;
      return {
        charge: ch,
        event: emit('invoice.payment_succeeded', { kind: 'invoice', id: inv.id }, created),
      };
    },
    refundCharge(chargeId: string, amount: number, at?: Date) {
      const ch = state.charges.get(chargeId)!;
      const created = at ? Math.floor(at.getTime() / 1000) : Math.max(now(), ch.created + 1);
      const bt: Bt = {
        id: id('txn'),
        amount: -amount,
        fee: 0,
        net: -amount,
        currency: ch.currency,
        type: 'refund',
        created,
        reporting_category: 'refund',
      };
      state.bts.set(bt.id, bt);
      const r: Refund = {
        id: id('re'),
        amount,
        charge: ch.id,
        created,
        balance_transaction: bt.id,
        currency: ch.currency,
      };
      state.refunds.set(r.id, r);
      ch.refunds.push(r.id);
      return { refund: r, event: emit('charge.refunded', { kind: 'charge', id: ch.id }, created) };
    },
    createPayout(p: { amount: number; at?: Date; destinationCurrency?: string }) {
      const created = p.at ? Math.floor(p.at.getTime() / 1000) : now();
      const po: Payout = {
        id: id('po'),
        amount: p.amount,
        currency: 'usd',
        arrival_date: created + 86400,
        created,
        destination: id('ba'),
        destinationCurrency: p.destinationCurrency ?? 'usd',
      };
      state.payouts.set(po.id, po);
      return { payout: po, event: emit('payout.paid', { kind: 'payout', id: po.id }, created) };
    },
    /** The customer (or Stripe) moves a webhook endpoint to another API version. */
    setEndpointVersion(endpointId: string, version: string) {
      state.endpoints.find((e) => e.id === endpointId)!.api_version = version;
    },
    setAccountApiVersion(version: string) {
      state.accountApiVersion = version;
    },
    dropNextWebhooks(n: number) {
      state.dropWebhooks = n;
    },
    revokeKey() {
      state.keyRevoked = true;
    },
    /** An event body exactly as Stripe would send it to an endpoint on `version` (unexpanded). */
    eventBody(eventId: string, version?: string) {
      const e = state.events.find((x) => x.id === eventId)!;
      return renderEvent(e, version ?? e.api_version);
    },
    sign(secret: string, body: string, t = now()) {
      return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
    },
  };

  /* ------------------------------------------------------------------ HTTP */

  const app: FastifyInstance = Fastify({ logger: false });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, new URLSearchParams(String(body)));
  });

  const versionOf = (req: FastifyRequest) =>
    (req.headers['stripe-version'] as string | undefined) ?? state.accountApiVersion;
  const expandOf = (req: FastifyRequest) => {
    const q = new URL(req.url, 'http://x').searchParams;
    return [...q.entries()].filter(([k]) => /^expand(\[\d*\])?$/.test(k)).map(([, v]) => v);
  };
  const err = (reply: FastifyReply, status: number, type: string, message: string, code?: string) =>
    reply.code(status).send({ error: { type, message, ...(code ? { code } : {}) } });

  app.addHook('onRequest', async (req, reply) => {
    state.requestLog.push({
      at: new Date().toISOString(),
      method: req.method,
      path: req.url.split('?')[0]!,
      version: (req.headers['stripe-version'] as string) ?? null,
    });
    if (req.url.startsWith('/__')) return;
    const auth = String(req.headers.authorization ?? '');
    const key = auth.startsWith('Bearer ')
      ? auth.slice(7)
      : auth.startsWith('Basic ')
        ? Buffer.from(auth.slice(6), 'base64').toString().split(':')[0]
        : '';
    if (key !== state.apiKey)
      return err(reply, 401, 'invalid_request_error', 'Invalid API Key provided', 'api_key_invalid');
    if (state.keyRevoked)
      return err(reply, 401, 'invalid_request_error', 'This API key has been revoked', 'api_key_expired');
    const f = state.faults.take('api');
    if (f?.type === 'http503' || f?.type === 'http500')
      return err(reply, f.type === 'http503' ? 503 : 500, 'api_error', 'Fixture outage');
    if (f?.type === 'http429') return err(reply, 429, 'rate_limit_error', 'Too many requests');
  });

  app.get('/v1/account', async () => ({
    id: accountId,
    object: 'account',
    settings: { dashboard: { display_name: 'Fixture Payments' } },
  }));

  app.get('/v1/events', async (req) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const types = [...q.entries()]
      .filter(([k]) => /^types(\[\d*\])?$/.test(k) || k === 'type')
      .map(([, v]) => v);
    const gte = Number(q.get('created[gte]') ?? 0);
    const lte = Number(q.get('created[lte]') ?? Number.MAX_SAFE_INTEGER);
    const limit = Math.min(100, Number(q.get('limit') ?? 10));
    let list = state.events
      .filter((e) => (!types.length || types.includes(e.type)) && e.created >= gte && e.created <= lte)
      .slice()
      .reverse();
    const after = q.get('starting_after');
    if (after) list = list.slice(list.findIndex((e) => e.id === after) + 1);
    return {
      object: 'list',
      data: list.slice(0, limit).map((e) => renderEvent(e)),
      has_more: list.length > limit,
      url: '/v1/events',
    };
  });
  app.get('/v1/events/:id', async (req, reply) => {
    const e = state.events.find((x) => x.id === (req.params as { id: string }).id);
    return e ? renderEvent(e) : err(reply, 404, 'invalid_request_error', 'No such event', 'resource_missing');
  });
  app.get('/v1/charges/:id', async (req, reply) => {
    const c = state.charges.get((req.params as { id: string }).id);
    return c
      ? renderCharge(c, expandOf(req), versionOf(req))
      : err(reply, 404, 'invalid_request_error', 'No such charge', 'resource_missing');
  });
  app.get('/v1/invoices/:id', async (req, reply) => {
    const i = state.invoices.get((req.params as { id: string }).id);
    return i
      ? renderInvoice(i, expandOf(req), versionOf(req))
      : err(reply, 404, 'invalid_request_error', 'No such invoice', 'resource_missing');
  });
  app.get('/v1/invoices/:id/lines', async (req, reply) => {
    const i = state.invoices.get((req.params as { id: string }).id);
    if (!i) return err(reply, 404, 'invalid_request_error', 'No such invoice', 'resource_missing');
    return (renderInvoice(i, [], versionOf(req)) as { lines: unknown }).lines;
  });
  app.get('/v1/refunds', async (req) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const c = state.charges.get(q.get('charge') ?? '');
    const data = (c?.refunds ?? []).map((r) =>
      renderRefund(
        state.refunds.get(r)!,
        expandOf(req).map((e) => e.replace(/^data\./, '')),
      ),
    );
    return { object: 'list', data: data.reverse(), has_more: false };
  });
  app.get('/v1/payouts/:id', async (req, reply) => {
    const p = state.payouts.get((req.params as { id: string }).id);
    return p
      ? renderPayout(p, expandOf(req))
      : err(reply, 404, 'invalid_request_error', 'No such payout', 'resource_missing');
  });
  app.post('/v1/webhook_endpoints', async (req, reply) => {
    const b = req.body as URLSearchParams;
    const url = b.get('url');
    if (!url)
      return err(reply, 400, 'invalid_request_error', 'Missing required param: url.', 'parameter_missing');
    const events = [...b.entries()].filter(([k]) => /^enabled_events(\[\d*\])?$/.test(k)).map(([, v]) => v);
    const ep: Endpoint = {
      id: id('we'),
      url,
      secret: `whsec_${prefix}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`,
      api_version: b.get('api_version') ?? state.accountApiVersion,
      enabled_events: events,
      status: 'enabled',
    };
    state.endpoints.push(ep);
    return { ...ep, object: 'webhook_endpoint' };
  });
  app.get('/v1/webhook_endpoints', async () => ({
    object: 'list',
    data: state.endpoints.map(({ secret: _s, ...e }) => ({ ...e, object: 'webhook_endpoint' })),
    has_more: false,
  }));

  return { app, state, control, accountId, apiKey: () => state.apiKey };
}
