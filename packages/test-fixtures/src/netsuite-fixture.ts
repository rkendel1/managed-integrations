/**
 * DETERMINISTIC TEST FIXTURE — NOT NETSUITE.
 *
 * Models the subset of NetSuite SuiteTalk REST used by the integration, per official docs:
 *  - OAuth 2.0 client credentials (M2M) token endpoint with a signed JWT client assertion
 *  - PUT /record/v1/salesOrder/eid:{externalId} upsert (204 + Location on create)
 *  - GET /record/v1/salesOrder/eid:{externalId}
 *  - POST /query/v1/suiteql (requires `Prefer: transient`; offset must be divisible by limit)
 *  - Error body shape { type, title, status, "o:errorDetails": [{ detail, "o:errorCode" }] }
 *  - Concurrency governance: 429 with CONCURRENCY_LIMIT_EXCEEDED
 *
 * Required-field rules (entity, subsidiary in OneWorld, mandatory custom fields) are
 * configurable because they depend on the customer's NetSuite account configuration.
 */
import { createPublicKey, randomBytes, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { FaultQueue, sleep } from './faults.ts';

export interface SalesOrderRecord {
  id: string;
  externalId: string | null;
  entity: { id: string };
  subsidiary?: { id: string } | null;
  tranDate: string;
  otherRefNum: string | null;
  memo: string | null;
  item: { items: { item: { id: string }; quantity: number; rate: number }[] };
  createdAt: string;
  lastModified: string;
  [custom: string]: unknown;
}

export interface NetSuiteFixtureOptions {
  accountId?: string;
  clientId?: string;
  certificateId?: string;
  oneWorld?: boolean;
  concurrencyLimit?: number;
  accessTokenTtlSeconds?: number;
}

function nsError(reply: FastifyReply, status: number, errorCode: string, detail: string, title?: string) {
  return reply
    .code(status)
    .type('application/vnd.oracle.resource+json; type=error')
    .send({
      type: 'https://www.rfc-editor.org/rfc/rfc9110.html#section-15',
      title:
        title ?? (status === 429 ? 'Too Many Requests' : status === 401 ? 'Unauthorized' : 'Bad Request'),
      status,
      'o:errorDetails': [{ detail, 'o:errorCode': errorCode }],
    });
}

function b64urlJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

export function createNetSuiteFixture(opts: NetSuiteFixtureOptions = {}) {
  const accountId = opts.accountId ?? '1234567_SB1';
  const clientId = opts.clientId ?? 'fixture-netsuite-client-id';
  const certificateId = opts.certificateId ?? 'fixture-cert-id';
  const tokenTtl = opts.accessTokenTtlSeconds ?? 3600;

  const state = {
    salesOrders: new Map<string, SalesOrderRecord>(), // internal id -> record
    items: new Set<string>(['101', '102', '103']),
    customers: new Set<string>(['501']),
    /** Business keys used by lookups: customer.entityid and item.itemid (internal id -> code). */
    customerCodes: new Map<string, string>([['501', 'WEB']]),
    itemCodes: new Map<string, string>([
      ['101', 'SKU-RED'],
      ['102', 'SKU-BLUE'],
      ['103', 'SKU-GREEN'],
    ]),
    subsidiaries: new Set<string>(['1']),
    oneWorld: opts.oneWorld ?? true,
    mandatoryBodyFields: [] as string[],
    concurrencyLimit: opts.concurrencyLimit ?? 5,
    inflight: 0,
    maxObservedInflight: 0,
    faults: new FaultQueue(),
    publicKey: undefined as KeyObject | undefined,
    tokens: new Map<string, number>(), // token -> expiry
    revoked: false,
    nextId: 9001,
    requestLog: [] as { at: string; kind: string; detail?: string }[],
    artificialLatencyMs: 0,
  };

  function findByExternalId(eid: string): SalesOrderRecord | undefined {
    for (const r of state.salesOrders.values()) if (r.externalId === eid) return r;
    return undefined;
  }

  const control = {
    registerPublicKey(pem: string) {
      state.publicKey = createPublicKey(pem);
    },
    setMandatoryBodyFields(fields: string[]) {
      state.mandatoryBodyFields = fields;
    },
    insertForeignSalesOrder(rec: Partial<SalesOrderRecord>): SalesOrderRecord {
      const id = String(state.nextId++);
      const now = new Date().toISOString();
      const r: SalesOrderRecord = {
        id,
        externalId: rec.externalId ?? null,
        entity: rec.entity ?? { id: '501' },
        subsidiary: rec.subsidiary ?? { id: '1' },
        tranDate: rec.tranDate ?? now.slice(0, 10),
        otherRefNum: rec.otherRefNum ?? null,
        memo: rec.memo ?? null,
        item: rec.item ?? { items: [{ item: { id: '101' }, quantity: 1, rate: 1 }] },
        createdAt: now,
        lastModified: now,
      };
      state.salesOrders.set(id, r);
      return r;
    },
    deleteByExternalId(eid: string) {
      const r = findByExternalId(eid);
      if (r) state.salesOrders.delete(r.id);
      return !!r;
    },
    revoke() {
      state.revoked = true;
      state.tokens.clear();
    },
    expireTokens() {
      for (const k of state.tokens.keys()) state.tokens.set(k, 0);
    },
    reset() {
      state.salesOrders.clear();
      state.mandatoryBodyFields = [];
      state.faults.clear();
      state.revoked = false;
      state.tokens.clear();
      state.nextId = 9001;
      state.inflight = 0;
      state.maxObservedInflight = 0;
      state.requestLog.length = 0;
    },
    findByExternalId,
  };

  const app: FastifyInstance = Fastify({ logger: false, forceCloseConnections: true });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );

  /* ------------------------------ OAuth 2.0 client credentials (M2M) ------------------------------ */
  app.post('/services/rest/auth/oauth2/v1/token', async (req, reply) => {
    const f = state.faults.take('token');
    if (f) {
      if (f.type === 'http500') return nsError(reply, 500, 'UNEXPECTED_ERROR', 'fixture fault');
      if (f.type === 'unauthorized') return reply.code(400).send({ error: 'invalid_grant' });
    }
    const b = (req.body ?? {}) as Record<string, string>;
    if (b.grant_type !== 'client_credentials')
      return reply.code(400).send({ error: 'unsupported_grant_type' });
    if (b.client_assertion_type !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
      return reply.code(400).send({ error: 'invalid_request' });
    if (state.revoked || !state.publicKey) return reply.code(400).send({ error: 'invalid_grant' });
    const parts = (b.client_assertion ?? '').split('.');
    if (parts.length !== 3) return reply.code(400).send({ error: 'invalid_request' });
    const [h, p, s] = parts as [string, string, string];
    let header: Record<string, unknown>, payload: Record<string, unknown>;
    try {
      header = b64urlJson(h);
      payload = b64urlJson(p);
    } catch {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    if (header.kid !== certificateId) return reply.code(400).send({ error: 'invalid_grant', reason: 'kid' });
    const alg = String(header.alg);
    const data = Buffer.from(`${h}.${p}`);
    const sig = Buffer.from(s, 'base64url');
    let ok = false;
    if (alg === 'PS256') {
      ok = cryptoVerify('sha256', data, { key: state.publicKey, padding: 6, saltLength: 32 }, sig);
    } else if (alg === 'RS256') {
      ok = cryptoVerify('sha256', data, state.publicKey, sig);
    } else if (alg === 'ES256') {
      ok = cryptoVerify('sha256', data, { key: state.publicKey, dsaEncoding: 'ieee-p1363' }, sig);
    }
    const now = Math.floor(Date.now() / 1000);
    if (
      !ok ||
      payload.iss !== clientId ||
      typeof payload.exp !== 'number' ||
      payload.exp < now ||
      typeof payload.iat !== 'number' ||
      payload.exp - payload.iat > 3600
    ) {
      return reply.code(400).send({ error: 'invalid_grant' });
    }
    const token = `ns_fixture_${randomBytes(16).toString('hex')}`;
    state.tokens.set(token, Date.now() + tokenTtl * 1000);
    state.requestLog.push({ at: new Date().toISOString(), kind: 'token' });
    return { access_token: token, expires_in: tokenTtl, token_type: 'bearer' };
  });

  /* ------------------------------ auth + governance middleware ------------------------------ */
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/services/rest/record') && !req.url.startsWith('/services/rest/query')) return;
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const exp = state.tokens.get(token);
    if (state.revoked || !exp || exp < Date.now()) {
      return nsError(reply, 401, 'INVALID_LOGIN', 'Invalid login attempt.', 'Unauthorized');
    }
    if (state.inflight >= state.concurrencyLimit) {
      return nsError(
        reply,
        429,
        'CONCURRENCY_LIMIT_EXCEEDED',
        'Concurrent request limit exceeded. Request blocked.',
      );
    }
  });

  async function governed<T>(fn: () => Promise<T>): Promise<T> {
    state.inflight++;
    state.maxObservedInflight = Math.max(state.maxObservedInflight, state.inflight);
    try {
      if (state.artificialLatencyMs) await sleep(state.artificialLatencyMs);
      return await fn();
    } finally {
      state.inflight--;
    }
  }

  function applyFault(target: string, reply: FastifyReply): FastifyReply | undefined | 'reject' {
    const f = state.faults.take(target);
    if (!f) return undefined;
    switch (f.type) {
      case 'http500':
        return nsError(
          reply,
          500,
          'UNEXPECTED_ERROR',
          'An unexpected error occurred.',
          'Internal Server Error',
        );
      case 'http503':
        return nsError(reply, 503, 'UNEXPECTED_ERROR', 'Service unavailable.', 'Service Unavailable');
      case 'http429':
        if (f.retryAfterSeconds != null) reply.header('Retry-After', String(f.retryAfterSeconds));
        return nsError(reply, 429, 'CONCURRENCY_LIMIT_EXCEEDED', 'Concurrent request limit exceeded.');
      case 'unauthorized':
        return nsError(reply, 401, 'INVALID_LOGIN', 'Invalid login attempt.', 'Unauthorized');
      case 'reject_record':
        return 'reject';
      default:
        return nsError(reply, 500, 'UNEXPECTED_ERROR', `fixture fault ${f.type}`);
    }
  }

  /* ------------------------------ salesOrder upsert by external id ------------------------------ */
  app.put('/services/rest/record/v1/salesOrder/:ref', async (req, reply) =>
    governed(async () => {
      const ref = (req.params as { ref: string }).ref;
      if (!ref.startsWith('eid:'))
        return nsError(reply, 400, 'INVALID_REQUEST', 'PUT is supported only for upsert by external ID.');
      const fault = applyFault('record.put', reply);
      if (fault && fault !== 'reject') return fault;
      const externalId = decodeURIComponent(ref.slice(4));
      const body = (req.body ?? {}) as Partial<SalesOrderRecord>;
      if (fault === 'reject')
        return nsError(reply, 400, 'USER_ERROR', 'Error while accessing a resource. Fixture rejection.');

      // Validation mirrors account-configured rules.
      const entityId = body.entity?.id;
      if (!entityId) return nsError(reply, 400, 'USER_ERROR', 'Please enter value(s) for: Customer');
      if (!state.customers.has(entityId))
        return nsError(reply, 400, 'USER_ERROR', `Invalid entity reference key ${entityId}.`);
      if (state.oneWorld && !body.subsidiary?.id)
        return nsError(reply, 400, 'USER_ERROR', 'Please enter value(s) for: Subsidiary');
      if (body.subsidiary?.id && !state.subsidiaries.has(body.subsidiary.id))
        return nsError(reply, 400, 'USER_ERROR', `Invalid subsidiary reference key ${body.subsidiary.id}.`);
      const lines = body.item?.items ?? [];
      if (!lines.length)
        return nsError(
          reply,
          400,
          'USER_ERROR',
          'You must enter at least one line item for this transaction.',
        );
      for (const l of lines) {
        if (!state.items.has(l.item?.id))
          return nsError(reply, 400, 'USER_ERROR', `Invalid item reference key ${l.item?.id}.`);
        if (!(l.quantity > 0)) return nsError(reply, 400, 'USER_ERROR', 'Invalid quantity.');
        if (typeof l.rate !== 'number' || Number.isNaN(l.rate))
          return nsError(reply, 400, 'USER_ERROR', 'Invalid rate.');
      }
      for (const m of state.mandatoryBodyFields) {
        if (body[m] == null || body[m] === '')
          return nsError(reply, 400, 'USER_ERROR', `Please enter value(s) for: ${m}`);
      }

      const now = new Date().toISOString();
      const existing = findByExternalId(externalId);
      const rec: SalesOrderRecord = {
        ...(existing ?? {}),
        ...body,
        id: existing?.id ?? String(state.nextId++),
        externalId,
        entity: { id: entityId },
        subsidiary: body.subsidiary ?? null,
        tranDate: body.tranDate ?? now.slice(0, 10),
        otherRefNum: body.otherRefNum ?? null,
        memo: body.memo ?? null,
        item: { items: lines.map((l) => ({ item: { id: l.item.id }, quantity: l.quantity, rate: l.rate })) },
        createdAt: existing?.createdAt ?? now,
        lastModified: now,
      };
      state.salesOrders.set(rec.id, rec);
      state.requestLog.push({ at: now, kind: existing ? 'update' : 'create', detail: externalId });
      const host = req.headers.host ?? 'localhost';
      reply.header('Location', `http://${host}/services/rest/record/v1/salesOrder/${rec.id}`);
      return reply.code(204).send();
    }),
  );

  app.get('/services/rest/record/v1/salesOrder/:ref', async (req, reply) =>
    governed(async () => {
      const fault = applyFault('record.get', reply);
      if (fault && fault !== 'reject') return fault;
      const ref = (req.params as { ref: string }).ref;
      const rec = ref.startsWith('eid:')
        ? findByExternalId(decodeURIComponent(ref.slice(4)))
        : state.salesOrders.get(ref);
      if (!rec)
        return nsError(
          reply,
          404,
          'NONEXISTENT_ID',
          'The record instance does not exist.',
          'Record Not Found',
        );
      return rec;
    }),
  );

  /* ------------------------------ SuiteQL (narrow, fixed statement) ------------------------------ */
  /**
   * The fixture recognises only the statements the integration issues. Anything else is a 400,
   * which keeps the client honest about the queries it depends on.
   */
  const SUITEQL_RECON =
    /^SELECT t\.id, t\.externalid, t\.otherrefnum, t\.trandate FROM transaction t WHERE t\.type = 'SalesOrd' AND \(t\.externalid IN \(([?, ]+)\) OR t\.otherrefnum IN \(([?, ]+)\)\) ORDER BY t\.id$/;
  const SUITEQL_LINES =
    /^SELECT tl\.transaction, tl\.item, tl\.quantity, tl\.rate FROM transactionline tl WHERE tl\.mainline = 'F' AND tl\.transaction IN \(([?, ]+)\) ORDER BY tl\.transaction, tl\.linesequencenumber$/;
  /** Lookups by business key with inline, quote-escaped literals. */
  const SUITEQL_CUSTOMER_BY_CODE = /^SELECT id, entityid FROM customer WHERE entityid IN \((.+)\)$/;
  const SUITEQL_ITEM_BY_CODE = /^SELECT id, itemid FROM item WHERE itemid IN \((.+)\)$/;
  const parseLiterals = (list: string): string[] =>
    [...list.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'"));
  const SUITEQL_PREFIX =
    /^SELECT t\.id, t\.externalid, t\.otherrefnum, t\.trandate FROM transaction t WHERE t\.type = 'SalesOrd' AND t\.externalid LIKE \? ORDER BY t\.id$/;

  app.post('/services/rest/query/v1/suiteql', async (req, reply) =>
    governed(async () => {
      const fault = applyFault('suiteql', reply);
      if (fault && fault !== 'reject') return fault;
      if (String(req.headers.prefer ?? '').toLowerCase() !== 'transient')
        return nsError(reply, 400, 'INVALID_HEADER', 'The Prefer: transient header is required.');
      const q = req.query as { limit?: string; offset?: string };
      const limit = Number(q.limit ?? 1000);
      const offset = Number(q.offset ?? 0);
      if (limit < 1 || limit > 1000 || offset % limit !== 0)
        return nsError(reply, 400, 'INVALID_PARAMETER', 'Offset must be divisible by limit.');
      const { q: stmt, params = [] } = (req.body ?? {}) as { q?: string; params?: unknown[] };
      const s = (stmt ?? '').replace(/\s+/g, ' ').trim();
      let rows: Record<string, unknown>[];
      let m: RegExpMatchArray | null;
      if ((m = s.match(SUITEQL_RECON))) {
        const nExt = m[1]!.split('?').length - 1;
        const ext = new Set(params.slice(0, nExt).map(String));
        const refs = new Set(params.slice(nExt).map(String));
        rows = [...state.salesOrders.values()]
          .filter(
            (r) => (r.externalId && ext.has(r.externalId)) || (r.otherRefNum && refs.has(r.otherRefNum)),
          )
          .sort((a, b) => Number(a.id) - Number(b.id))
          .map((r) => ({
            id: r.id,
            externalid: r.externalId,
            otherrefnum: r.otherRefNum,
            trandate: r.tranDate,
          }));
      } else if (SUITEQL_LINES.test(s)) {
        const ids = new Set(params.map(String));
        rows = [...state.salesOrders.values()]
          .filter((r) => ids.has(r.id))
          .sort((a, b) => Number(a.id) - Number(b.id))
          .flatMap((r) =>
            r.item.items.map((l) => ({
              transaction: r.id,
              item: l.item.id,
              quantity: String(l.quantity),
              rate: String(l.rate),
            })),
          );
      } else if ((m = s.match(SUITEQL_CUSTOMER_BY_CODE))) {
        const codes = new Set(parseLiterals(m[1]!));
        rows = [...state.customerCodes].filter(([, code]) => codes.has(code)).map(([id, entityid]) => ({ id, entityid }));
      } else if ((m = s.match(SUITEQL_ITEM_BY_CODE))) {
        const codes = new Set(parseLiterals(m[1]!));
        rows = [...state.itemCodes].filter(([, code]) => codes.has(code)).map(([id, itemid]) => ({ id, itemid }));
      } else if (s.match(SUITEQL_PREFIX)) {
        const like = String(params[0] ?? '');
        const prefix = like.endsWith('%') ? like.slice(0, -1) : like;
        rows = [...state.salesOrders.values()]
          .filter((r) => r.externalId?.startsWith(prefix))
          .sort((a, b) => Number(a.id) - Number(b.id))
          .map((r) => ({
            id: r.id,
            externalid: r.externalId,
            otherrefnum: r.otherRefNum,
            trandate: r.tranDate,
          }));
      } else {
        return nsError(reply, 400, 'INVALID_SEARCH', `Invalid search query: fixture does not support: ${s}`);
      }
      const page = rows.slice(offset, offset + limit);
      return {
        links: [],
        count: page.length,
        hasMore: offset + limit < rows.length,
        offset,
        totalResults: rows.length,
        items: page.map((r) => ({ links: [], ...r })),
      };
    }),
  );

  /* fixture control endpoints */
  app.post('/__fixture/faults', async (req) => {
    state.faults.add(req.body as never);
    return state.faults.list();
  });
  app.post('/__fixture/public-key', async (req) => {
    control.registerPublicKey((req.body as { pem: string }).pem);
    return { ok: true };
  });
  app.post('/__fixture/items', async (req) => {
    const b = (req.body ?? {}) as { id: string; code: string };
    if (!/^\d+$/.test(String(b.id)) || !b.code) return { error: 'id (digits) and code required' };
    state.items.add(String(b.id));
    state.itemCodes.set(String(b.id), String(b.code));
    return { ok: true };
  });
  app.post('/__fixture/config', async (req) => {
    const b = (req.body ?? {}) as { oneWorld?: boolean };
    if (typeof b.oneWorld === 'boolean') state.oneWorld = b.oneWorld;
    return { oneWorld: state.oneWorld };
  });
  app.post('/__fixture/mandatory-fields', async (req) => {
    control.setMandatoryBodyFields((req.body as { fields: string[] }).fields);
    return { ok: true };
  });
  app.post('/__fixture/foreign-sales-order', async (req) =>
    control.insertForeignSalesOrder(req.body as Partial<SalesOrderRecord>),
  );
  app.post('/__fixture/delete', async (req) => ({
    deleted: control.deleteByExternalId((req.body as { externalId: string }).externalId),
  }));
  app.post('/__fixture/latency', async (req) => {
    state.artificialLatencyMs = Math.max(0, Math.min(10_000, Number((req.body as { ms: number }).ms) || 0));
    return { latencyMs: state.artificialLatencyMs };
  });
  app.post('/__fixture/revoke', async () => {
    control.revoke();
    return { ok: true };
  });
  app.post('/__fixture/reset', async () => {
    control.reset();
    return { ok: true };
  });
  app.get('/__fixture/state', async () => ({
    salesOrders: [...state.salesOrders.values()],
    faults: state.faults.list(),
    fired: state.faults.fired,
    maxObservedInflight: state.maxObservedInflight,
  }));

  return { app, state, control, accountId, clientId, certificateId };
}

export type NetSuiteFixture = ReturnType<typeof createNetSuiteFixture>;
