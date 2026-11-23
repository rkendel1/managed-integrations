import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { ProviderError } from '@mi/contracts';
import { errorFromResponse, httpRequest, type HttpResponse } from './http.ts';
import type { NetSuiteSalesOrderPayload } from './implementation-api.ts';

export interface NetSuiteM2MCredentials {
  /** Client ID of the NetSuite integration record. */
  clientId: string;
  /** Certificate ID shown in NetSuite's OAuth 2.0 Client Credentials (M2M) setup. */
  certificateId: string;
  /** PEM private key matching the uploaded certificate. Never leaves this process unencrypted. */
  privateKeyPem: string;
  algorithm: 'PS256' | 'RS256' | 'ES256';
}

export interface NetSuiteAuth {
  getAccessToken(): Promise<string>;
  invalidate(): void;
}

/** Builds the signed JWT client assertion for the client credentials grant. */
export function buildClientAssertion(
  creds: NetSuiteM2MCredentials,
  audience: string,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  const header = { alg: creds.algorithm, typ: 'JWT', kid: creds.certificateId };
  const payload = {
    iss: creds.clientId,
    scope: ['rest_webservices'],
    aud: audience,
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const key = createPrivateKey(creds.privateKeyPem);
  let sig: Buffer;
  if (creds.algorithm === 'PS256') {
    sig = cryptoSign('sha256', Buffer.from(signingInput), { key, padding: 6, saltLength: 32 });
  } else if (creds.algorithm === 'ES256') {
    sig = cryptoSign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  } else {
    sig = cryptoSign('sha256', Buffer.from(signingInput), key);
  }
  return `${signingInput}.${sig.toString('base64url')}`;
}

/** M2M token provider: tokens are cached in memory only and re-minted before expiry. */
export class NetSuiteM2MAuth implements NetSuiteAuth {
  private cached?: { token: string; expiresAt: number };
  constructor(
    private readonly baseUrl: string,
    private readonly creds: NetSuiteM2MCredentials,
    private readonly timeoutMs = 30_000,
  ) {}

  get tokenUrl(): string {
    return `${this.baseUrl.replace(/\/$/, '')}/services/rest/auth/oauth2/v1/token`;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > Date.now()) return this.cached.token;
    const assertion = buildClientAssertion(this.creds, this.tokenUrl);
    const res = await httpRequest('netsuite', this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
      }).toString(),
      timeoutMs: this.timeoutMs,
    });
    if (res.status === 400 || res.status === 401) {
      const body = safeJson(res) as { error?: string };
      throw new ProviderError(
        `NetSuite token request rejected: ${body?.error ?? res.status}`,
        'authentication',
        {
          provider: 'netsuite',
          status: res.status,
          code: body?.error ?? 'TOKEN_REJECTED',
        },
      );
    }
    if (res.status !== 200)
      throw errorFromResponse('netsuite', res, `NetSuite token endpoint HTTP ${res.status}`);
    const body = res.json() as { access_token?: string; expires_in?: number };
    if (!body.access_token) {
      throw new ProviderError('NetSuite token response missing access_token', 'unknown', {
        provider: 'netsuite',
      });
    }
    this.cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }
}

function safeJson(res: HttpResponse): unknown {
  try {
    return JSON.parse(res.text);
  } catch {
    return undefined;
  }
}

export function netsuiteErrorCode(res: HttpResponse): { code?: string; detail?: string } {
  const body = safeJson(res) as
    { 'o:errorDetails'?: { detail?: string; 'o:errorCode'?: string }[] } | undefined;
  const d = body?.['o:errorDetails']?.[0];
  return {
    ...(d?.['o:errorCode'] ? { code: d['o:errorCode'] } : {}),
    ...(d?.detail ? { detail: d.detail } : {}),
  };
}

/** Simple counting semaphore to stay under NetSuite account concurrency governance. */
class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export interface SuiteqlPage<T> {
  items: T[];
  hasMore: boolean;
  totalResults: number;
}

export class NetSuiteClient {
  private readonly sem: Semaphore;
  constructor(
    private readonly opts: {
      baseUrl: string;
      auth: NetSuiteAuth;
      timeoutMs?: number;
      maxConcurrency?: number;
    },
  ) {
    this.sem = new Semaphore(opts.maxConcurrency ?? 2);
  }

  private url(path: string): string {
    return `${this.opts.baseUrl.replace(/\/$/, '')}/services/rest${path}`;
  }

  private async send(path: string, init: RequestInit): Promise<HttpResponse> {
    return this.sem.run(async () => {
      for (let authAttempt = 0; authAttempt < 2; authAttempt++) {
        const token = await this.opts.auth.getAccessToken();
        const res = await httpRequest('netsuite', this.url(path), {
          ...init,
          headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
          timeoutMs: this.opts.timeoutMs ?? 60_000,
        });
        if (res.status === 401 && authAttempt === 0) {
          this.opts.auth.invalidate();
          continue;
        }
        return res;
      }
      throw new ProviderError('unreachable', 'unknown', { provider: 'netsuite' });
    });
  }

  private toError(res: HttpResponse, op: string): ProviderError {
    const { code, detail } = netsuiteErrorCode(res);
    const msg = `NetSuite ${op} HTTP ${res.status}${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''}`;
    if (res.status === 429 || code === 'CONCURRENCY_LIMIT_EXCEEDED') {
      return errorFromResponse('netsuite', res, msg, {
        errorClass: 'rate_limited',
        code: code ?? 'RATE_LIMIT',
      });
    }
    if (res.status === 401)
      return errorFromResponse('netsuite', res, msg, {
        errorClass: 'authentication',
        ...(code ? { code } : {}),
      });
    if (res.status === 403)
      return errorFromResponse('netsuite', res, msg, {
        errorClass: 'authorization',
        ...(code ? { code } : {}),
      });
    if (res.status === 400 && (code === 'USER_ERROR' || code === 'INVALID_KEY_OR_REF')) {
      return errorFromResponse('netsuite', res, msg, { errorClass: 'invalid_data', code });
    }
    if (res.status === 400)
      return errorFromResponse('netsuite', res, msg, { errorClass: 'permanent', ...(code ? { code } : {}) });
    return errorFromResponse('netsuite', res, msg, code ? { code } : undefined);
  }

  /**
   * Upsert by external id (PUT salesOrder/eid:<externalId>). Retrying is safe: an existing
   * record with the external id is updated, never duplicated.
   * Returns the internal id when NetSuite reports it via the Location header.
   */
  async upsertSalesOrder(
    payload: NetSuiteSalesOrderPayload,
  ): Promise<{ destinationId: string | null; status: number }> {
    const { externalId, ...body } = payload;
    const res = await this.send(`/record/v1/salesOrder/eid:${encodeURIComponent(externalId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status !== 204 && res.status !== 200) throw this.toError(res, 'salesOrder upsert');
    const location = res.headers.get('location');
    const destinationId = location?.match(/\/salesOrder\/(\d+)$/i)?.[1] ?? null;
    return { destinationId, status: res.status };
  }

  async getSalesOrderByExternalId(externalId: string): Promise<Record<string, unknown> | null> {
    const res = await this.send(`/record/v1/salesOrder/eid:${encodeURIComponent(externalId)}`, {
      method: 'GET',
    });
    if (res.status === 404) return null;
    if (res.status !== 200) throw this.toError(res, 'salesOrder get');
    return res.json() as Record<string, unknown>;
  }

  async suiteqlPage<T>(q: string, params: unknown[], limit: number, offset: number): Promise<SuiteqlPage<T>> {
    if (offset % limit !== 0) throw new Error('SuiteQL offset must be divisible by limit');
    const res = await this.send(`/query/v1/suiteql?limit=${limit}&offset=${offset}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', prefer: 'transient' },
      body: JSON.stringify({ q, params }),
    });
    if (res.status !== 200) throw this.toError(res, 'SuiteQL');
    const body = res.json() as { items?: T[]; hasMore?: boolean; totalResults?: number };
    return { items: body.items ?? [], hasMore: body.hasMore === true, totalResults: body.totalResults ?? 0 };
  }

  /** Reads all pages; bounded by maxRows to guarantee termination. */
  async suiteqlAll<T>(
    q: string,
    params: unknown[],
    opts: { limit?: number; maxRows?: number } = {},
  ): Promise<T[]> {
    const limit = opts.limit ?? 1000;
    const maxRows = opts.maxRows ?? 100_000;
    const out: T[] = [];
    for (let offset = 0; ; offset += limit) {
      const page = await this.suiteqlPage<T>(q, params, limit, offset);
      out.push(...page.items);
      if (!page.hasMore || page.items.length === 0) return out;
      if (out.length >= maxRows)
        throw new ProviderError('SuiteQL result exceeded maxRows', 'permanent', { provider: 'netsuite' });
    }
  }
}
