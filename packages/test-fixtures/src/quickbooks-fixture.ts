/**
 * DETERMINISTIC TEST FIXTURE — NOT QUICKBOOKS ONLINE.
 *
 * Models the subset of Intuit's QuickBooks Online Accounting API and OAuth 2.0 used by the Stripe →
 * QuickBooks integration, from Intuit's public documentation:
 *  - OAuth 2.0 authorization code grant (authorize redirect with code + realmId; token endpoint with
 *    HTTP Basic client authentication; refresh tokens rotate on use; an expired/revoked refresh token
 *    answers 400 {"error":"invalid_grant"}); access tokens last 3600 s;
 *  - POST /v3/company/{realm}/journalentry?minorversion=&requestid= — `requestid` makes a retried create
 *    idempotent (same request id → the same entity, no duplicate); unbalanced entries and unknown accounts
 *    are rejected with 400 ValidationFault;
 *  - GET /v3/company/{realm}/query?query=… for JournalEntry (by DocNumber), Account (by Name) and CompanyInfo;
 *  - minor versions: since 2025-08-01 Intuit ignores minorversion values below 75 and answers as 75; the
 *    fixture records the requested and the served minor version for every request.
 */
import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { FaultQueue } from './faults.ts';

export const QBO_DEFAULT_ACCOUNTS: Record<string, string> = {
  'Operating Bank': '35',
  'Stripe Clearing': '91',
  'Accounts Receivable': '84',
  'Disputes Receivable': '92',
  'Sales Tax Payable': '89',
  'Deferred Revenue': '93',
  'Customer Credit Balance': '94',
  'Subscription Revenue': '79',
  'Application Fee Revenue': '95',
  'Refunds Issued': '96',
  'Stripe Processing Fees': '97',
  'Payment Disputes': '98',
  'Bad Debt Expense': '99',
  'FX Gain/Loss': '100',
};

export interface QboLine {
  Id?: string;
  DetailType: 'JournalEntryLineDetail';
  Amount: number;
  Description?: string;
  JournalEntryLineDetail: { PostingType: 'Debit' | 'Credit'; AccountRef: { value: string; name?: string } };
}
export interface QboJournalEntryRecord {
  Id: string;
  SyncToken: string;
  DocNumber?: string;
  TxnDate: string;
  PrivateNote?: string;
  CurrencyRef?: { value: string };
  Line: QboLine[];
  MetaData: { CreateTime: string };
}

export interface QuickBooksFixtureOptions {
  realmId?: string;
  clientId?: string;
  clientSecret?: string;
  companyName?: string;
}
export type QuickBooksFixture = ReturnType<typeof createQuickBooksFixture>;

export function createQuickBooksFixture(opts: QuickBooksFixtureOptions = {}) {
  const realmId = opts.realmId ?? '9341450000000001';
  const clientId = opts.clientId ?? 'qbo-fixture-client';
  const clientSecret = opts.clientSecret ?? 'qbo-fixture-secret';
  const state = {
    companyName: opts.companyName ?? 'Fixture Books Inc.',
    accounts: { ...QBO_DEFAULT_ACCOUNTS },
    journalEntries: new Map<string, QboJournalEntryRecord>(),
    byRequestId: new Map<string, string>(),
    codes: new Map<string, { redirectUri: string; used: boolean }>(),
    accessTokens: new Map<string, number>(),
    refreshTokens: new Map<string, { expiresAt: number; revoked: boolean }>(),
    /** The next authorization request is denied by the user. */
    denyNext: false,
    requestLog: [] as {
      at: string;
      method: string;
      path: string;
      minorRequested: number | null;
      minorServed: number | null;
      requestId: string | null;
    }[],
    faults: new FaultQueue(),
  };
  let seq = 1000;

  const issue = () => {
    const access = `qbo-at-${randomBytes(12).toString('hex')}`;
    const refresh = `qbo-rt-${randomBytes(12).toString('hex')}`;
    state.accessTokens.set(access, Date.now() + 3600_000);
    state.refreshTokens.set(refresh, { expiresAt: Date.now() + 100 * 86400_000, revoked: false });
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'bearer',
      expires_in: 3600,
      x_refresh_token_expires_in: 8640000,
    };
  };

  const control = {
    /** Every refresh token stops working (the customer disconnected the app, or the token expired). */
    revokeRefreshTokens() {
      for (const t of state.refreshTokens.values()) t.revoked = true;
    },
    /** Every access token is expired now (forces a refresh). */
    expireAccessTokens() {
      for (const k of state.accessTokens.keys()) state.accessTokens.set(k, 0);
    },
    /** A journal entry written by some other integration. */
    insertForeignJournalEntry(e: { DocNumber?: string; PrivateNote: string; amount: number; date?: string }) {
      const Id = String(++seq);
      state.journalEntries.set(Id, {
        Id,
        SyncToken: '0',
        ...(e.DocNumber ? { DocNumber: e.DocNumber } : {}),
        TxnDate: e.date ?? new Date().toISOString().slice(0, 10),
        PrivateNote: e.PrivateNote,
        CurrencyRef: { value: 'USD' },
        Line: [
          {
            Id: '0',
            DetailType: 'JournalEntryLineDetail',
            Amount: e.amount,
            JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: '35' } },
          },
          {
            Id: '1',
            DetailType: 'JournalEntryLineDetail',
            Amount: e.amount,
            JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '79' } },
          },
        ],
        MetaData: { CreateTime: new Date().toISOString() },
      });
      return Id;
    },
  };

  const app: FastifyInstance = Fastify({ logger: false });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, new URLSearchParams(String(body)));
  });
  const fault = (reply: FastifyReply, error: string, detail: string, status = 400) =>
    reply.code(status).send({
      Fault: {
        Error: [{ Message: error, Detail: detail, code: String(status === 400 ? 6000 : status) }],
        type: status === 401 ? 'AUTHENTICATION' : 'ValidationFault',
      },
      time: new Date().toISOString(),
    });

  /* ----------------------------------------------------------------- OAuth 2.0 */

  app.get('/connect/oauth2', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const redirect = new URL(q['redirect_uri']!);
    redirect.searchParams.set('state', q['state'] ?? '');
    if (q['client_id'] !== clientId) return reply.code(400).send('invalid client');
    if (state.denyNext) {
      state.denyNext = false;
      redirect.searchParams.set('error', 'access_denied');
      return reply.redirect(redirect.toString());
    }
    const code = `qbo-code-${randomBytes(8).toString('hex')}`;
    state.codes.set(code, { redirectUri: q['redirect_uri']!, used: false });
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('realmId', realmId);
    return reply.redirect(redirect.toString());
  });

  app.post('/oauth2/v1/tokens/bearer', async (req, reply) => {
    const basic = String(req.headers.authorization ?? '');
    const [id, secret] = Buffer.from(basic.replace(/^Basic /, ''), 'base64')
      .toString()
      .split(':');
    if (id !== clientId || secret !== clientSecret) return reply.code(401).send({ error: 'invalid_client' });
    const b = req.body as URLSearchParams;
    if (b.get('grant_type') === 'authorization_code') {
      const c = state.codes.get(b.get('code') ?? '');
      if (!c || c.used || c.redirectUri !== b.get('redirect_uri'))
        return reply.code(400).send({ error: 'invalid_grant' });
      c.used = true;
      return issue();
    }
    if (b.get('grant_type') === 'refresh_token') {
      const t = state.refreshTokens.get(b.get('refresh_token') ?? '');
      if (!t || t.revoked || t.expiresAt < Date.now())
        return reply.code(400).send({ error: 'invalid_grant' });
      t.revoked = true; // rotation: the previous refresh token is spent
      return issue();
    }
    return reply.code(400).send({ error: 'unsupported_grant_type' });
  });

  /* ----------------------------------------------------------------- Accounting API */

  const authorized = (req: FastifyRequest) => {
    const tok = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    return (state.accessTokens.get(tok) ?? 0) > Date.now();
  };
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v3/')) return;
    const q = new URL(req.url, 'http://x').searchParams;
    const requested = q.has('minorversion') ? Number(q.get('minorversion')) : null;
    state.requestLog.push({
      at: new Date().toISOString(),
      method: req.method,
      path: req.url.split('?')[0]!,
      minorRequested: requested,
      // Intuit (2025-08-01): minor versions below 75 are ignored; requests are served as 75.
      minorServed: requested === null || requested < 75 ? 75 : requested,
      requestId: q.get('requestid'),
    });
    const f = state.faults.take('api');
    if (f?.type === 'http503' || f?.type === 'http500')
      return fault(reply, 'Service unavailable', 'Fixture outage', 503);
    if (f?.type === 'http429') return fault(reply, 'ThrottleExceeded', 'Too many requests', 429);
    if (!authorized(req)) return fault(reply, 'AuthenticationFailed', 'Token expired or invalid', 401);
  });

  app.post('/v3/company/:realm/journalentry', async (req, reply) => {
    if ((req.params as { realm: string }).realm !== realmId)
      return fault(reply, 'Invalid company', 'realm', 403);
    const q = new URL(req.url, 'http://x').searchParams;
    const requestId = q.get('requestid');
    if (requestId && state.byRequestId.has(requestId)) {
      return {
        JournalEntry: state.journalEntries.get(state.byRequestId.get(requestId)!),
        time: new Date().toISOString(),
      };
    }
    const body = req.body as Omit<QboJournalEntryRecord, 'Id' | 'SyncToken' | 'MetaData'>;
    const lines = body.Line ?? [];
    const sum = (side: string) =>
      Math.round(
        lines.filter((l) => l.JournalEntryLineDetail.PostingType === side).reduce((a, l) => a + l.Amount, 0) *
          100,
      );
    if (!lines.length || sum('Debit') !== sum('Credit'))
      return fault(reply, 'Transaction must be balanced', 'Debits and credits must be equal');
    const known = new Set(Object.values(state.accounts));
    const unknown = lines.find((l) => !known.has(l.JournalEntryLineDetail.AccountRef.value));
    if (unknown)
      return fault(
        reply,
        'Invalid Reference Id',
        `Account ${unknown.JournalEntryLineDetail.AccountRef.value} not found`,
      );
    const Id = String(++seq);
    const rec: QboJournalEntryRecord = {
      ...body,
      Id,
      SyncToken: '0',
      Line: lines.map((l, i) => ({ ...l, Id: String(i) })),
      MetaData: { CreateTime: new Date().toISOString() },
    };
    state.journalEntries.set(Id, rec);
    if (requestId) state.byRequestId.set(requestId, Id);
    return { JournalEntry: rec, time: new Date().toISOString() };
  });

  const IN =
    /^select \* from (JournalEntry|Account) where (DocNumber|Name) in \((.*)\)(?: maxresults (\d+))?$/i;
  app.get('/v3/company/:realm/query', async (req, reply) => {
    if ((req.params as { realm: string }).realm !== realmId)
      return fault(reply, 'Invalid company', 'realm', 403);
    const query = String((req.query as Record<string, string>)['query'] ?? '').trim();
    if (/^select \* from CompanyInfo$/i.test(query))
      return {
        QueryResponse: { CompanyInfo: [{ CompanyName: state.companyName, Id: '1' }] },
        time: new Date().toISOString(),
      };
    const m = IN.exec(query);
    if (!m) return fault(reply, 'QueryParserError', `Unsupported query in fixture: ${query}`);
    const values = [...m[3]!.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1]!.replace(/\\'/g, "'"));
    if (m[1]!.toLowerCase() === 'journalentry') {
      const rows = [...state.journalEntries.values()].filter(
        (e) => e.DocNumber && values.includes(e.DocNumber),
      );
      return {
        QueryResponse: rows.length ? { JournalEntry: rows, startPosition: 1, maxResults: rows.length } : {},
        time: new Date().toISOString(),
      };
    }
    const rows = Object.entries(state.accounts)
      .filter(([name]) => values.includes(name))
      .map(([Name, Id]) => ({ Id, Name, Active: true }));
    return { QueryResponse: rows.length ? { Account: rows } : {}, time: new Date().toISOString() };
  });
  app.get('/v3/company/:realm/companyinfo/:id', async (req, reply) => {
    if ((req.params as { realm: string }).realm !== realmId)
      return fault(reply, 'Invalid company', 'realm', 403);
    return { CompanyInfo: { CompanyName: state.companyName, Id: '1' }, time: new Date().toISOString() };
  });

  /* ----------------------------------------------------------------- fixture control over HTTP (demos) */
  app.post('/__fixture/revoke', async () => {
    control.revokeRefreshTokens();
    control.expireAccessTokens();
    return { ok: true };
  });
  app.get('/__fixture/state', async () => ({
    realmId,
    journalEntries: [...state.journalEntries.values()],
    requestLog: state.requestLog.slice(-50),
  }));

  return { app, state, control, realmId, clientId, clientSecret };
}
