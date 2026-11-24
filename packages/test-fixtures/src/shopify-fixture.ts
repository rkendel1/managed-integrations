/**
 * DETERMINISTIC TEST FIXTURE — NOT SHOPIFY.
 *
 * A local server that models the subset of the Shopify Admin GraphQL API and OAuth endpoints
 * used by the Shopify → NetSuite integration, based on official documentation (see
 * docs/architecture/PROVIDER-RESEARCH.md). Queries are validated and executed with graphql-js
 * against a schema subset, so a query that references a field missing from the schema fails
 * exactly as a GraphQL server would.
 *
 * "Schema drift" in this fixture is a controlled, fictional change used to exercise the
 * reliability and maintenance pipeline. It is not a claim about any real Shopify API change.
 */
import { createHmac, randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildSchema, graphql, type GraphQLSchema } from 'graphql';
import { FaultQueue, sleep } from './faults.ts';

const BASE_SDL = /* GraphQL */ `
  scalar DateTime
  enum OrderSortKeys {
    UPDATED_AT
    CREATED_AT
    PROCESSED_AT
    ID
  }
  type Query {
    shop: Shop!
    orders(
      first: Int
      after: String
      query: String
      sortKey: OrderSortKeys
      reverse: Boolean
    ): OrderConnection!
    order(id: ID!): Order
    webhookSubscriptions(first: Int): WebhookSubscriptionConnection!
  }
  # App webhook subscriptions (shape of the Admin API; FIXTURE delivers orders/create to them).
  type Mutation {
    webhookSubscriptionCreate(
      topic: WebhookSubscriptionTopic!
      webhookSubscription: WebhookSubscriptionInput!
    ): WebhookSubscriptionCreatePayload
  }
  enum WebhookSubscriptionTopic {
    ORDERS_CREATE
  }
  enum WebhookSubscriptionFormat {
    JSON
  }
  input WebhookSubscriptionInput {
    callbackUrl: String!
    format: WebhookSubscriptionFormat
  }
  type WebhookSubscription {
    id: ID!
    topic: WebhookSubscriptionTopic!
    callbackUrl: String!
  }
  type WebhookSubscriptionConnection {
    nodes: [WebhookSubscription!]!
  }
  type UserError {
    field: [String!]
    message: String!
  }
  type WebhookSubscriptionCreatePayload {
    webhookSubscription: WebhookSubscription
    userErrors: [UserError!]!
  }
  type Shop {
    name: String!
    myshopifyDomain: String!
    currencyCode: String!
  }
  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    endCursor: String
    startCursor: String
  }
  type OrderConnection {
    edges: [OrderEdge!]!
    nodes: [Order!]!
    pageInfo: PageInfo!
  }
  type OrderEdge {
    cursor: String!
    node: Order!
  }
  type MoneyV2 {
    amount: String!
    currencyCode: String!
  }
  type MoneyBag {
    shopMoney: MoneyV2!
    presentmentMoney: MoneyV2!
  }
  type Customer {
    id: ID!
    email: String
  }
  type LineItemConnection {
    nodes: [LineItem!]!
    pageInfo: PageInfo!
  }
  type Order {
    id: ID!
    legacyResourceId: String!
    name: String!
    createdAt: DateTime!
    updatedAt: DateTime!
    processedAt: DateTime!
    cancelledAt: DateTime
    currencyCode: String!
    totalPriceSet: MoneyBag!
    email: String
    note: String
    customer: Customer
    lineItems(first: Int, after: String): LineItemConnection!
  }
`;

/** Baseline line item shape (matches the documented LineItem.originalUnitPriceSet). */
const LINE_ITEM_BASELINE = `type LineItem { id: ID! sku: String title: String! quantity: Int! originalUnitPriceSet: MoneyBag! }`;
/**
 * FICTIONAL drift: `originalUnitPriceSet` removed, `preDiscountUnitPriceSet` introduced.
 * Used only to exercise detection → maintenance → release.
 */
const LINE_ITEM_DRIFT = `type LineItem { id: ID! sku: String title: String! quantity: Int! preDiscountUnitPriceSet: MoneyBag! }`;

export type SchemaVariant = 'baseline' | 'drift';

export type WebhookVersion = '2026-10' | '2027-01';

export interface FixtureLineItem {
  sku: string | null;
  title: string;
  quantity: number;
  unitPrice: string;
}
export interface FixtureOrder {
  legacyId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  currencyCode: string;
  email: string | null;
  note?: string | null;
  lineItems: FixtureLineItem[];
}

export interface ShopifyFixtureOptions {
  shopDomain?: string;
  clientId?: string;
  clientSecret?: string;
  /** Bucket size and restore rate for the simulated calculated-cost throttle. */
  bucketSize?: number;
  restoreRate?: number;
  accessTokenTtlSeconds?: number;
  /** First order id. Shopify order ids are globally unique, so separate fixture shops use separate ranges. */
  firstOrderId?: bigint;
}

interface TokenRecord {
  accessToken: string;
  expiresAt: number;
  scope: string;
}

function money(amount: string, currencyCode: string) {
  const m = { amount, currencyCode };
  return { shopMoney: m, presentmentMoney: m };
}

function lineTotal(o: FixtureOrder): string {
  const cents = o.lineItems.reduce((s, li) => s + Math.round(Number(li.unitPrice) * 100) * li.quantity, 0);
  return (cents / 100).toFixed(2);
}

function encodeCursor(o: FixtureOrder): string {
  return Buffer.from(JSON.stringify({ u: o.updatedAt, id: o.legacyId })).toString('base64url');
}
function decodeCursor(c: string): { u: string; id: string } {
  try {
    return JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid cursor');
  }
}

function compareOrders(a: FixtureOrder, b: FixtureOrder): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1;
  return BigInt(a.legacyId) < BigInt(b.legacyId) ? -1 : BigInt(a.legacyId) > BigInt(b.legacyId) ? 1 : 0;
}

/** Parses the documented search syntax subset we rely on: updated_at:>='ISO' / updated_at:<'ISO'. */
function applySearch(orders: FixtureOrder[], query: string | undefined): FixtureOrder[] {
  if (!query) return orders;
  const terms = query.match(/(\w+):(>=|<=|>|<)?'?([^'\s]+)'?/g) ?? [];
  let out = orders;
  for (const term of terms) {
    const m = term.match(/(\w+):(>=|<=|>|<)?'?([^'\s]+)'?/)!;
    const [, field, op = '=', raw] = m;
    if (field === 'updated_at' || field === 'created_at') {
      const key = field === 'updated_at' ? 'updatedAt' : 'createdAt';
      const v = new Date(raw!).getTime();
      if (Number.isNaN(v)) throw new Error(`Invalid date in search query: ${raw}`);
      out = out.filter((o) => {
        const t = new Date(o[key]).getTime();
        return op === '>='
          ? t >= v
          : op === '>'
            ? t > v
            : op === '<='
              ? t <= v
              : op === '<'
                ? t < v
                : t === v;
      });
    } else if (field === 'id') {
      out = out.filter((o) => o.legacyId === raw);
    }
  }
  return out;
}

export function createShopifyFixture(opts: ShopifyFixtureOptions = {}) {
  const shopDomain = opts.shopDomain ?? 'fixture-shop.myshopify.com';
  const clientId = opts.clientId ?? 'fixture-shopify-client-id';
  const clientSecret = opts.clientSecret ?? 'fixture-shopify-client-secret';
  const firstOrderId = opts.firstOrderId ?? 5000000001n;
  const bucketSize = opts.bucketSize ?? 2000;
  const restoreRate = opts.restoreRate ?? 100;
  const tokenTtl = opts.accessTokenTtlSeconds ?? 3600;

  const state = {
    orders: new Map<string, FixtureOrder>(),
    variant: 'baseline' as SchemaVariant,
    faults: new FaultQueue(),
    authCodes: new Map<string, string>(), // code -> scope
    accessTokens: new Map<string, TokenRecord>(),
    refreshTokens: new Map<string, { scope: string; expiresAt: number }>(),
    revoked: false,
    bucket: { available: bucketSize, at: Date.now() },
    requestLog: [] as { at: string; kind: string; detail?: string }[],
    nextLegacyId: firstOrderId,
    /**
     * Webhook payload contract version (sent as X-Shopify-API-Version). FIXTURE-ONLY, fictional:
     * '2026-10' sends line_items[].price and price_set; '2027-01' no longer sends line_items[].price
     * (see docs/provider-docs/shopify/FIXTURE-webhook-changelog.md).
     */
    webhookVersion: '2026-10' as WebhookVersion,
    /** App webhook subscriptions and every delivery attempt made to them (fixture evidence). */
    subscriptions: [] as { id: string; topic: 'ORDERS_CREATE'; callbackUrl: string }[],
    webhookDeliveries: [] as {
      at: string;
      orderId: string;
      callbackUrl: string;
      status: number | null;
      error?: string;
      dropped?: boolean;
    }[],
    /** FIXTURE-ONLY: how many upcoming orders lose their orders/create webhook (to every subscriber). */
    dropWebhooks: 0,
  };

  const schemas: Record<SchemaVariant, GraphQLSchema> = {
    baseline: buildSchema(BASE_SDL + LINE_ITEM_BASELINE),
    drift: buildSchema(BASE_SDL + LINE_ITEM_DRIFT),
  };

  function resolveOrder(o: FixtureOrder) {
    return {
      id: `gid://shopify/Order/${o.legacyId}`,
      legacyResourceId: o.legacyId,
      name: o.name,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      processedAt: o.createdAt,
      cancelledAt: o.cancelledAt,
      currencyCode: o.currencyCode,
      totalPriceSet: money(lineTotal(o), o.currencyCode),
      email: o.email,
      note: o.note ?? null,
      customer: o.email ? { id: `gid://shopify/Customer/${o.legacyId}`, email: o.email } : null,
      lineItems: ({ first }: { first?: number }) => {
        const items = o.lineItems.slice(0, first ?? 50).map((li, i) => ({
          id: `gid://shopify/LineItem/${o.legacyId}${i}`,
          sku: li.sku,
          title: li.title,
          quantity: li.quantity,
          originalUnitPriceSet: money(li.unitPrice, o.currencyCode),
          preDiscountUnitPriceSet: money(li.unitPrice, o.currencyCode),
        }));
        return {
          nodes: items,
          pageInfo: { hasNextPage: o.lineItems.length > items.length, hasPreviousPage: false },
        };
      },
    };
  }

  let lastPage: { request: string; response: unknown } | undefined;
  let pendingFault: string | undefined;

  /** Shopify sends orders/create to every app subscription, signed with the app's client secret. */
  function deliverOrderCreated(o: FixtureOrder) {
    const lost = state.dropWebhooks > 0;
    if (lost) state.dropWebhooks--;
    for (const sub of state.subscriptions) {
      const raw = Buffer.from(JSON.stringify(control.webhookPayload(o)));
      const rec: (typeof state.webhookDeliveries)[number] = {
        at: new Date().toISOString(),
        orderId: o.legacyId,
        callbackUrl: sub.callbackUrl,
        status: null,
      };
      state.webhookDeliveries.push(rec);
      if (lost) {
        rec.dropped = true;
        continue;
      }
      void fetch(sub.callbackUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-shopify-hmac-sha256': createHmac('sha256', clientSecret).update(raw).digest('base64'),
          'x-shopify-shop-domain': shopDomain,
          'x-shopify-topic': 'orders/create',
          'x-shopify-webhook-id': `fx-${o.legacyId}-${sub.id.split('/').pop()}`,
          'x-shopify-api-version': state.webhookVersion,
        },
        body: raw,
      })
        .then((r) => {
          rec.status = r.status;
        })
        .catch((err: unknown) => {
          rec.error = String(err);
        });
    }
  }

  const rootValue = {
    webhookSubscriptions: () => ({ nodes: state.subscriptions }),
    webhookSubscriptionCreate: (args: {
      topic: 'ORDERS_CREATE';
      webhookSubscription: { callbackUrl: string };
    }) => {
      if (
        state.subscriptions.some(
          (x) => x.topic === args.topic && x.callbackUrl === args.webhookSubscription.callbackUrl,
        )
      )
        return {
          webhookSubscription: null,
          userErrors: [
            {
              field: ['webhookSubscription', 'callbackUrl'],
              message: 'Address for this topic has already been taken',
            },
          ],
        };
      const sub = {
        id: `gid://shopify/WebhookSubscription/${state.subscriptions.length + 1}`,
        topic: args.topic,
        callbackUrl: args.webhookSubscription.callbackUrl,
      };
      state.subscriptions.push(sub);
      return { webhookSubscription: sub, userErrors: [] };
    },
    shop: () => ({ name: 'Fixture Shop', myshopifyDomain: shopDomain, currencyCode: 'USD' }),
    order: ({ id }: { id: string }) => {
      const legacy = id.split('/').pop()!;
      const o = state.orders.get(legacy);
      return o ? resolveOrder(o) : null;
    },
    orders: (args: {
      first?: number;
      after?: string;
      query?: string;
      sortKey?: string;
      reverse?: boolean;
    }) => {
      const first = Math.min(args.first ?? 50, 250);
      let list = applySearch([...state.orders.values()], args.query).sort(compareOrders);
      if (args.reverse) list = list.reverse();
      if (args.after) {
        const c = decodeCursor(args.after);
        const pivot = { updatedAt: c.u, legacyId: c.id } as FixtureOrder;
        list = list.filter((o) => compareOrders(o, pivot) > 0);
      }
      const page = list.slice(0, first);
      const hasNextPage = list.length > first;
      const endCursor = page.length ? encodeCursor(page[page.length - 1]!) : null;
      if (pendingFault === 'missing_cursor') {
        return {
          edges: [],
          nodes: page.map(resolveOrder),
          pageInfo: { hasNextPage: true, hasPreviousPage: false, endCursor: null, startCursor: null },
        };
      }
      return {
        edges: page.map((o) => ({ cursor: encodeCursor(o), node: resolveOrder(o) })),
        nodes: page.map(resolveOrder),
        pageInfo: {
          hasNextPage,
          hasPreviousPage: !!args.after,
          endCursor,
          startCursor: page.length ? encodeCursor(page[0]!) : null,
        },
      };
    },
  };

  function refillBucket() {
    const now = Date.now();
    const restored = ((now - state.bucket.at) / 1000) * restoreRate;
    state.bucket.available = Math.min(bucketSize, state.bucket.available + restored);
    state.bucket.at = now;
  }

  function authenticate(token: string | undefined): TokenRecord | undefined {
    if (!token || state.revoked) return undefined;
    const rec = state.accessTokens.get(token);
    if (!rec || rec.expiresAt < Date.now()) return undefined;
    return rec;
  }

  function issueTokens(scope: string) {
    const accessToken = `shpat_fixture_${randomBytes(12).toString('hex')}`;
    const refreshToken = `shprt_fixture_${randomBytes(12).toString('hex')}`;
    state.accessTokens.set(accessToken, { accessToken, scope, expiresAt: Date.now() + tokenTtl * 1000 });
    state.refreshTokens.set(refreshToken, { scope, expiresAt: Date.now() + 90 * 24 * 3600 * 1000 });
    return {
      access_token: accessToken,
      scope,
      expires_in: tokenTtl,
      refresh_token: refreshToken,
      refresh_token_expires_in: 7776000,
    };
  }

  /* ------------------------------ control API (fixture only) ------------------------------ */
  const control = {
    upsertOrder(o: Partial<FixtureOrder> & { lineItems: FixtureLineItem[] }): FixtureOrder {
      const legacyId = o.legacyId ?? String(state.nextLegacyId++);
      const now = new Date().toISOString();
      const existing = state.orders.get(legacyId);
      const order: FixtureOrder = {
        legacyId,
        name: o.name ?? existing?.name ?? `#${1000 + state.orders.size + 1}`,
        createdAt: o.createdAt ?? existing?.createdAt ?? now,
        updatedAt: o.updatedAt ?? now,
        cancelledAt: o.cancelledAt ?? existing?.cancelledAt ?? null,
        currencyCode: o.currencyCode ?? existing?.currencyCode ?? 'USD',
        email: o.email ?? existing?.email ?? null,
        note: o.note ?? existing?.note ?? null,
        lineItems: o.lineItems,
      };
      state.orders.set(legacyId, order);
      if (!existing) deliverOrderCreated(order);
      return order;
    },
    seedOrders(count: number, opts: { start?: Date; stepMs?: number; skus?: string[] } = {}) {
      const start = opts.start ?? new Date(Date.now() - 24 * 3600 * 1000);
      const step = opts.stepMs ?? 60_000;
      const skus = opts.skus ?? ['SKU-RED', 'SKU-BLUE'];
      const created: FixtureOrder[] = [];
      for (let i = 0; i < count; i++) {
        const t = new Date(start.getTime() + i * step).toISOString();
        created.push(
          control.upsertOrder({
            createdAt: t,
            updatedAt: t,
            email: `buyer${i}@example.test`,
            lineItems: [
              { sku: skus[i % skus.length]!, title: 'Widget', quantity: 1 + (i % 3), unitPrice: '19.99' },
            ],
          }),
        );
      }
      return created;
    },
    setVariant(v: SchemaVariant) {
      state.variant = v;
    },
    revoke() {
      state.revoked = true;
    },
    expireAccessTokens() {
      for (const t of state.accessTokens.values()) t.expiresAt = 0;
    },
    reset() {
      state.orders.clear();
      state.variant = 'baseline';
      state.faults.clear();
      state.revoked = false;
      state.bucket = { available: bucketSize, at: Date.now() };
      state.requestLog.length = 0;
      state.nextLegacyId = firstOrderId;
      state.webhookVersion = '2026-10';
      state.dropWebhooks = 0;
      state.subscriptions.length = 0;
      state.webhookDeliveries.length = 0;
    },
    setWebhookVersion(v: WebhookVersion) {
      state.webhookVersion = v;
    },
    webhookPayload(o: FixtureOrder) {
      return {
        id: Number(o.legacyId),
        name: o.name,
        created_at: o.createdAt,
        updated_at: o.updatedAt,
        cancelled_at: o.cancelledAt,
        email: o.email,
        customer: o.email ? { id: Number(o.legacyId), email: o.email } : null,
        currency: o.currencyCode,
        note: o.note ?? null,
        line_items: o.lineItems.map((li, i) => {
          const money = { amount: li.unitPrice, currency_code: o.currencyCode };
          return {
            id: Number(`${o.legacyId}${i}`),
            sku: li.sku,
            title: li.title,
            quantity: li.quantity,
            ...(state.webhookVersion === '2026-10' ? { price: li.unitPrice } : {}),
            price_set: { shop_money: money, presentment_money: money },
          };
        }),
      };
    },
    /** Issue a token directly (fixture convenience for tests that do not exercise OAuth). */
    issueToken(scope = 'read_orders') {
      return issueTokens(scope);
    },
  };

  const app: FastifyInstance = Fastify({ logger: false, forceCloseConnections: true });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );

  /* OAuth authorize — the real endpoint shows a merchant consent screen; the fixture auto-approves. */
  app.get('/admin/oauth/authorize', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q.client_id !== clientId) return reply.code(400).send({ error: 'invalid client_id' });
    const code = randomBytes(10).toString('hex');
    state.authCodes.set(code, q.scope ?? '');
    const params: Record<string, string> = {
      code,
      shop: shopDomain,
      state: q.state ?? '',
      timestamp: String(Math.floor(Date.now() / 1000)),
    };
    const message = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    const hmac = createHmac('sha256', clientSecret).update(message).digest('hex');
    const url = new URL(q.redirect_uri!);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('hmac', hmac);
    return reply.redirect(url.toString());
  });

  app.post('/admin/oauth/access_token', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const f = state.faults.take('token');
    if (f) return sendFault(reply, f.type, f.retryAfterSeconds);
    if (b.client_id !== clientId || b.client_secret !== clientSecret)
      return reply.code(401).send({ error: 'invalid_client' });
    if (b.grant_type === 'refresh_token') {
      const rec = state.refreshTokens.get(b.refresh_token ?? '');
      if (!rec || rec.expiresAt < Date.now() || state.revoked)
        return reply.code(401).send({ error: 'invalid_request', error_description: 'refresh token invalid' });
      state.refreshTokens.delete(b.refresh_token!); // rotation
      state.requestLog.push({ at: new Date().toISOString(), kind: 'token_refresh' });
      return issueTokens(rec.scope);
    }
    const scope = state.authCodes.get(b.code ?? '');
    if (scope === undefined) return reply.code(400).send({ error: 'invalid_request' });
    state.authCodes.delete(b.code!);
    if (b.expiring !== '1') {
      // The fixture only issues expiring offline tokens (required for apps created on/after 2026-12-01).
      return reply.code(400).send({ error: 'invalid_request', error_description: 'expiring=1 required' });
    }
    return issueTokens(scope);
  });

  function sendFault(reply: import('fastify').FastifyReply, type: string, retryAfter?: number) {
    switch (type) {
      case 'http500':
        return reply.code(500).send({ errors: 'Internal Server Error' });
      case 'http503':
        return reply.code(503).send({ errors: 'Service Unavailable' });
      case 'http429':
        if (retryAfter != null) reply.header('Retry-After', String(retryAfter));
        return reply.code(429).send({ errors: 'Exceeded API rate limit' });
      case 'unauthorized':
        return reply.code(401).send({ errors: '[API] Invalid API key or access token' });
      default:
        return reply.code(500).send({ errors: `unknown fault ${type}` });
    }
  }

  app.post('/admin/api/:version/graphql.json', async (req, reply) => {
    const token = req.headers['x-shopify-access-token'] as string | undefined;
    const auth = authenticate(token);
    if (!auth) return reply.code(401).send({ errors: '[API] Invalid API key or access token' });
    const body = req.body as { query?: string; variables?: Record<string, unknown> };
    state.requestLog.push({ at: new Date().toISOString(), kind: 'graphql' });

    const f = state.faults.take('graphql');
    pendingFault = undefined;
    if (f) {
      if (f.delayMs) await sleep(f.delayMs);
      if (f.type === 'timeout') {
        await sleep(f.delayMs ?? 30_000);
        return reply.code(504).send({ errors: 'Gateway Timeout' });
      }
      if (f.type === 'throttled') {
        return {
          errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
          extensions: {
            cost: {
              requestedQueryCost: 100,
              actualQueryCost: null,
              throttleStatus: { maximumAvailable: bucketSize, currentlyAvailable: 0, restoreRate },
            },
          },
        };
      }
      if (f.type === 'repeat_page' && lastPage) return lastPage.response;
      if (f.type === 'missing_cursor') pendingFault = 'missing_cursor';
      else if (f.type !== 'repeat_page') return sendFault(reply, f.type, f.retryAfterSeconds);
    }

    refillBucket();
    const first = Number((body.variables as { first?: number } | undefined)?.first ?? 50);
    const requestedCost = 2 + first * 3;
    if (requestedCost > 1000) {
      return {
        errors: [{ message: 'Query cost exceeds max', extensions: { code: 'MAX_COST_EXCEEDED' } }],
      };
    }
    if (state.bucket.available < requestedCost) {
      return {
        errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
        extensions: {
          cost: {
            requestedQueryCost: requestedCost,
            actualQueryCost: null,
            throttleStatus: {
              maximumAvailable: bucketSize,
              currentlyAvailable: Math.floor(state.bucket.available),
              restoreRate,
            },
          },
        },
      };
    }

    const result = await graphql({
      schema: schemas[state.variant],
      source: body.query ?? '',
      rootValue,
      variableValues: body.variables ?? {},
    });
    const nodes =
      (result.data as { orders?: { nodes?: unknown[] } } | null | undefined)?.orders?.nodes?.length ?? 0;
    const actualCost = result.errors ? 1 : 2 + nodes * 3;
    state.bucket.available -= actualCost;
    const response = {
      ...(result.data ? { data: result.data } : {}),
      ...(result.errors
        ? {
            errors: result.errors.map((e) => ({
              message: e.message,
              locations: e.locations,
              path: e.path,
              extensions: { code: e.message.startsWith('Cannot query field') ? 'undefinedField' : 'GRAPHQL' },
            })),
          }
        : {}),
      extensions: {
        cost: {
          requestedQueryCost: requestedCost,
          actualQueryCost: actualCost,
          throttleStatus: {
            maximumAvailable: bucketSize,
            currentlyAvailable: Math.floor(state.bucket.available),
            restoreRate,
          },
        },
      },
    };
    lastPage = { request: JSON.stringify(body), response };
    return response;
  });

  /* fixture control endpoints, used by the demo CLI */
  app.post('/__fixture/orders', async (req) => control.upsertOrder(req.body as FixtureOrder));
  /**
   * The fixture's model of Shopify's REST `orders/create` webhook body for an order (the subset of the
   * REST Order resource used by consumers: id, name, created_at, updated_at, email, customer, currency,
   * note, line_items[].{sku,title,quantity,price}). Independent of any client code, so tests can compare
   * a client's reconstruction against it.
   */
  app.get('/__fixture/orders/:legacyId/webhook-payload', async (req, reply) => {
    const o = state.orders.get((req.params as { legacyId: string }).legacyId);
    if (!o) return reply.code(404).send({ error: 'unknown order' });
    reply.header('x-shopify-api-version', state.webhookVersion);
    return control.webhookPayload(o);
  });
  /** FIXTURE-ONLY: switch the webhook payload contract version (a controlled provider change). */
  app.post('/__fixture/webhook-version', async (req) => {
    control.setWebhookVersion((req.body as { version: WebhookVersion }).version);
    return { version: state.webhookVersion };
  });
  /** FIXTURE-ONLY: the next `n` orders' orders/create webhooks are never sent (to any subscriber). */
  app.post('/__fixture/drop-webhooks', async (req) => {
    state.dropWebhooks = Number((req.body as { n?: number } | undefined)?.n ?? 1);
    return { dropWebhooks: state.dropWebhooks };
  });
  app.post('/__fixture/seed', async (req) => {
    const b = req.body as { count: number; start?: string; stepMs?: number };
    return control.seedOrders(b.count, {
      ...(b.start ? { start: new Date(b.start) } : {}),
      ...(b.stepMs ? { stepMs: b.stepMs } : {}),
    }).length;
  });
  app.post('/__fixture/faults', async (req) => {
    state.faults.add(req.body as never);
    return state.faults.list();
  });
  app.post('/__fixture/variant', async (req) => {
    control.setVariant((req.body as { variant: SchemaVariant }).variant);
    return { variant: state.variant };
  });
  /** Fixture convenience for demo seeding: issue a token without the browser OAuth step. */
  app.post('/__fixture/token', async () => control.issueToken('read_orders'));
  app.post('/__fixture/revoke', async () => {
    control.revoke();
    return { revoked: true };
  });
  app.post('/__fixture/reset', async () => {
    control.reset();
    return { ok: true };
  });
  app.get('/__fixture/state', async () => ({
    variant: state.variant,
    orderCount: state.orders.size,
    faults: state.faults.list(),
    fired: state.faults.fired,
    revoked: state.revoked,
    webhookVersion: state.webhookVersion,
    subscriptions: state.subscriptions,
    webhookDeliveries: state.webhookDeliveries.slice(-50),
  }));

  return { app, state, control, shopDomain, clientId, clientSecret };
}

export type ShopifyFixture = ReturnType<typeof createShopifyFixture>;
