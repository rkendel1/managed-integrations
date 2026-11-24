/**
 * Provider connections (shared since slice 7; extracted from the Stripe → QuickBooks integration). One
 * connection per tenant and provider, used by every managed integration or application that depends on that
 * provider — a pipeline's source or target, or an application's only dependency. Credentials live in `connections`
 * (one row per tenant and provider, shared by every integration that uses the provider), encrypted with the
 * service key ring and bound to their row (AAD), never returned by any API.
 *
 *  - Stripe: a restricted (read-only is enough for discovery; webhook endpoint creation needs write on
 *    Webhook Endpoints) API key. Calls use the official stripe-node SDK pinned to API version 2024-06-20,
 *    the version the adopted ledgerly code is written against.
 *  - QuickBooks Online: OAuth 2.0 authorization code grant; access tokens last an hour and are refreshed
 *    under a row lock (refresh tokens ROTATE: two concurrent refreshes would spend the same token);
 *    `invalid_grant` means the authorization is gone — the connection is marked revoked and work is held
 *    until the customer reconnects (`AuthorizationLost`).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { connections, type Db } from '@mi/database';
import type { CredentialCipher, ProviderEndpointConfig } from '@mi/integration-shopify-netsuite';

export const STRIPE_API_VERSION = '2024-06-20';
export const STRIPE_DEFAULT_BASE = 'https://api.stripe.com';
export const QBO_DEFAULT_API = 'https://quickbooks.api.intuit.com';
export const QBO_DEFAULT_AUTHORIZE = 'https://appcenter.intuit.com/connect/oauth2';
export const QBO_DEFAULT_TOKEN = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const QBO_SCOPE = 'com.intuit.quickbooks.accounting';

export class AuthorizationLost extends Error {
  constructor(
    readonly provider: 'stripe' | 'quickbooks',
    message: string,
  ) {
    super(message);
  }
}

export type ConnectionRow = typeof connections.$inferSelect;
const aad = (row: Pick<ConnectionRow, 'id'>) => `connection:${row.id}`;

export async function loadConnection(db: Db, tenantId: string, providerId: 'stripe' | 'quickbooks') {
  const [row] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.tenantId, tenantId), eq(connections.providerId, providerId)));
  return row;
}

/* ------------------------------------------------------------------ Stripe */

export function stripeBase(endpoints: ProviderEndpointConfig): string {
  return endpoints.stripeBaseUrlOverride ?? STRIPE_DEFAULT_BASE;
}

/** A stripe-node client for a key, pointed at the configured base (fixture in dev/test). */
export function stripeSdk(apiKey: string, baseUrl: string): Stripe {
  const u = new URL(baseUrl);
  return new Stripe(apiKey, {
    apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion,
    host: u.hostname,
    port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
    protocol: u.protocol.replace(':', '') as 'http' | 'https',
    maxNetworkRetries: 1,
    telemetry: false,
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export async function stripeFor(
  db: Db,
  cipher: CredentialCipher,
  endpoints: ProviderEndpointConfig,
  tenantId: string,
) {
  const row = await loadConnection(db, tenantId, 'stripe');
  if (!row?.credentialsCiphertext || row.status === 'revoked')
    throw new AuthorizationLost(
      'stripe',
      row?.status === 'revoked' ? 'Stripe access was revoked' : 'Stripe is not connected',
    );
  const { apiKey } = cipher.decrypt<{ apiKey: string }>(row.credentialsCiphertext, aad(row));
  return {
    sdk: stripeSdk(apiKey, row.baseUrl ?? stripeBase(endpoints)),
    accountId: row.externalAccount ?? '',
  };
}

/**
 * Stripe webhook authenticity, per Stripe's documentation: Stripe-Signature `t=<unix>,v1=<hex HMAC-SHA256(
 * endpoint secret, "<t>.<raw body>")>`, checked on the raw bytes with a 5-minute tolerance.
 */
const TOLERANCE_S = 300;

export function verifyStripeSignature(
  raw: Buffer,
  header: string | undefined,
  secret: string,
  now = Date.now(),
): boolean {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!Number.isFinite(t) || !sigs.length || Math.abs(now / 1000 - t) > TOLERANCE_S) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex'));
  return sigs.some((s) => {
    const b = Buffer.from(s);
    return b.length === expected.length && timingSafeEqual(b, expected);
  });
}


/** Signs a body as Stripe does (used when the host hands an already-verified event to a hosted application). */
export function signStripePayload(raw: Buffer | string, secret: string, t = Math.floor(Date.now() / 1000)) {
  const sig = createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex');
  return `t=${t},v1=${sig}`;
}

/** The customer's Stripe key and base, for a hosted application that constructs its own Stripe client. */
export async function stripeKeyFor(db: Db, cipher: CredentialCipher, endpoints: ProviderEndpointConfig, tenantId: string) {
  const row = await loadConnection(db, tenantId, 'stripe');
  if (!row?.credentialsCiphertext || row.status === 'revoked')
    throw new AuthorizationLost('stripe', row?.status === 'revoked' ? 'Stripe access was revoked' : 'Stripe is not connected');
  const { apiKey } = cipher.decrypt<{ apiKey: string }>(row.credentialsCiphertext, aad(row));
  return { apiKey, baseUrl: row.baseUrl ?? stripeBase(endpoints) };
}

/** Stores a Stripe key after proving it works (GET /v1/account). */
export async function connectStripe(
  db: Db,
  cipher: CredentialCipher,
  endpoints: ProviderEndpointConfig,
  tenantId: string,
  apiKey: string,
) {
  const base = stripeBase(endpoints);
  const account = await stripeSdk(apiKey, base).accounts.retrieve();
  await db
    .insert(connections)
    .values({ tenantId, providerId: 'stripe', status: 'pending' })
    .onConflictDoNothing();
  const row = (await loadConnection(db, tenantId, 'stripe'))!;
  const [updated] = await db
    .update(connections)
    .set({
      status: 'verified',
      externalAccount: account.id,
      baseUrl: base,
      grantedScopes: [
        'events:read',
        'charges:read',
        'invoices:read',
        'payouts:read',
        'webhook_endpoints:write',
      ],
      credentialsCiphertext: cipher.encrypt({ apiKey }, aad(row)),
      credentialsKeyId: cipher.keyId,
      lastVerifiedAt: new Date(),
      verificationError: null,
      revokedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(connections.id, row.id))
    .returning();
  return updated!;
}

/* ------------------------------------------------------------------ QuickBooks Online */

export interface QboCredentials {
  accessToken: string;
  refreshToken: string;
  realmId: string;
}

export function qboUrls(endpoints: ProviderEndpointConfig) {
  const o = endpoints.quickbooks?.baseUrlOverride?.replace(/\/$/, '');
  return {
    api: o ?? QBO_DEFAULT_API,
    authorize: o ? `${o}/connect/oauth2` : QBO_DEFAULT_AUTHORIZE,
    token: o ? `${o}/oauth2/v1/tokens/bearer` : QBO_DEFAULT_TOKEN,
  };
}

async function tokenRequest(endpoints: ProviderEndpointConfig, body: Record<string, string>) {
  const q = endpoints.quickbooks;
  if (!q?.clientId || !q.clientSecret) throw new Error('QuickBooks app credentials are not configured');
  const res = await fetch(qboUrls(endpoints).token, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${q.clientId}:${q.clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    x_refresh_token_expires_in?: number;
    error?: string;
  };
  if (!res.ok || !json.access_token) {
    if (json.error === 'invalid_grant')
      throw new AuthorizationLost(
        'quickbooks',
        'QuickBooks authorization expired or was revoked (invalid_grant)',
      );
    throw new Error(
      `QuickBooks token endpoint answered ${res.status}${json.error ? ` (${json.error})` : ''}`,
    );
  }
  return json as Required<
    Pick<typeof json, 'access_token' | 'refresh_token' | 'expires_in' | 'x_refresh_token_expires_in'>
  >;
}

export function qboAuthorizeUrl(endpoints: ProviderEndpointConfig, redirectUri: string, state: string) {
  const u = new URL(qboUrls(endpoints).authorize);
  u.searchParams.set('client_id', endpoints.quickbooks?.clientId ?? '');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', QBO_SCOPE);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  return u.toString();
}

/** Exchanges an authorization code and stores the tokens (the customer's authorization). */
export async function completeQboAuthorization(
  db: Db,
  cipher: CredentialCipher,
  endpoints: ProviderEndpointConfig,
  p: { tenantId: string; code: string; realmId: string; redirectUri: string },
) {
  const t = await tokenRequest(endpoints, {
    grant_type: 'authorization_code',
    code: p.code,
    redirect_uri: p.redirectUri,
  });
  await db
    .insert(connections)
    .values({ tenantId: p.tenantId, providerId: 'quickbooks', status: 'pending' })
    .onConflictDoNothing();
  const row = (await loadConnection(db, p.tenantId, 'quickbooks'))!;
  const creds: QboCredentials = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    realmId: p.realmId,
  };
  const [updated] = await db
    .update(connections)
    .set({
      status: 'authorized',
      externalAccount: p.realmId,
      baseUrl: qboUrls(endpoints).api,
      grantedScopes: [QBO_SCOPE],
      credentialsCiphertext: cipher.encrypt(creds, aad(row)),
      credentialsKeyId: cipher.keyId,
      accessTokenExpiresAt: new Date(Date.now() + t.expires_in * 1000),
      refreshTokenExpiresAt: new Date(Date.now() + t.x_refresh_token_expires_in * 1000),
      lastVerifiedAt: new Date(),
      verificationError: null,
      revokedAt: null,
      oauthStateHash: null,
      oauthStateExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(eq(connections.id, row.id))
    .returning();
  return updated!;
}

/** QuickBooks access for a tenant: a valid access token (refreshed under a row lock when due). */
export class QuickBooksAccess {
  constructor(
    private readonly db: Db,
    private readonly cipher: CredentialCipher,
    private readonly endpoints: ProviderEndpointConfig,
    readonly tenantId: string,
  ) {}

  async current(): Promise<{ creds: QboCredentials; apiBase: string; connectionId: string }> {
    const row = await loadConnection(this.db, this.tenantId, 'quickbooks');
    if (!row?.credentialsCiphertext) throw new AuthorizationLost('quickbooks', 'QuickBooks is not connected');
    if (row.status === 'revoked')
      throw new AuthorizationLost(
        'quickbooks',
        row.verificationError ?? 'QuickBooks authorization was revoked',
      );
    const creds = this.cipher.decrypt<QboCredentials>(row.credentialsCiphertext, aad(row));
    if ((row.accessTokenExpiresAt?.getTime() ?? 0) > Date.now() + 60_000)
      return { creds, apiBase: row.baseUrl ?? qboUrls(this.endpoints).api, connectionId: row.id };
    return this.refresh(row.id);
  }

  /** Refreshes under a row lock; another process's fresh tokens are reused instead of spending a rotated token. */
  async refresh(connectionId: string, force = false) {
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(connections)
          .where(eq(connections.id, connectionId))
          .for('update');
        if (!row?.credentialsCiphertext)
          throw new AuthorizationLost('quickbooks', 'QuickBooks is not connected');
        if (row.status === 'revoked')
          throw new AuthorizationLost(
            'quickbooks',
            row.verificationError ?? 'QuickBooks authorization was revoked',
          );
        const creds = this.cipher.decrypt<QboCredentials>(row.credentialsCiphertext, aad(row));
        const apiBase = row.baseUrl ?? qboUrls(this.endpoints).api;
        if (!force && (row.accessTokenExpiresAt?.getTime() ?? 0) > Date.now() + 60_000)
          return { creds, apiBase, connectionId };
        const t = await tokenRequest(this.endpoints, {
          grant_type: 'refresh_token',
          refresh_token: creds.refreshToken,
        });
        const next: QboCredentials = { ...creds, accessToken: t.access_token, refreshToken: t.refresh_token };
        await tx
          .update(connections)
          .set({
            credentialsCiphertext: this.cipher.encrypt(next, aad(row)),
            credentialsKeyId: this.cipher.keyId,
            accessTokenExpiresAt: new Date(Date.now() + t.expires_in * 1000),
            refreshTokenExpiresAt: new Date(Date.now() + t.x_refresh_token_expires_in * 1000),
            updatedAt: new Date(),
          })
          .where(eq(connections.id, row.id));
        return { creds: next, apiBase, connectionId };
      });
    } catch (err) {
      // Recorded outside the (rolled back) refresh transaction: the authorization is gone until the customer acts.
      if (err instanceof AuthorizationLost && /invalid_grant/.test(err.message))
        await this.db
          .update(connections)
          .set({
            status: 'revoked',
            revokedAt: new Date(),
            verificationError: err.message,
            updatedAt: new Date(),
          })
          .where(eq(connections.id, connectionId));
      throw err;
    }
  }

  /** An authenticated fetch for the Accounting API: refreshes once on 401. */
  async fetch(input: string, init: RequestInit = {}): Promise<Response> {
    const cur = await this.current();
    let creds = cur.creds;
    const connectionId = cur.connectionId;
    const send = (token: string) => {
      // One Authorization header: the caller's (e.g. upstream's dispatcher) is replaced, never merged.
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${token}`);
      if (!headers.has('accept')) headers.set('accept', 'application/json');
      return fetch(input, { ...init, headers });
    };
    let res = await send(creds.accessToken);
    if (res.status === 401) {
      ({ creds } = await this.refresh(connectionId, true));
      res = await send(creds.accessToken);
    }
    return res;
  }

  async query<T = Record<string, unknown>>(q: string): Promise<T> {
    const { creds, apiBase } = await this.current();
    const res = await this.fetch(
      `${apiBase}/v3/company/${encodeURIComponent(creds.realmId)}/query?query=${encodeURIComponent(q)}&minorversion=75`,
    );
    if (!res.ok)
      throw new Error(`QuickBooks query answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return ((await res.json()) as { QueryResponse: T }).QueryResponse;
  }
}

/** QuickBooks DocNumber is limited to 21 characters; upstream keeps the last 21 of the event id. */
export const docNumberOf = (eventId: string) => (eventId.length <= 21 ? eventId : eventId.slice(-21));
const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export interface QboEntryRecord {
  Id: string;
  DocNumber?: string;
  TxnDate: string;
  PrivateNote?: string;
  CurrencyRef?: { value: string };
  Line: {
    Amount: number;
    Description?: string;
    JournalEntryLineDetail: { PostingType: 'Debit' | 'Credit'; AccountRef: { value: string; name?: string } };
  }[];
}

/** Journal entries by DocNumber (batched). */
export async function journalEntriesByDocNumber(
  qbo: QuickBooksAccess,
  docNumbers: string[],
): Promise<QboEntryRecord[]> {
  const out: QboEntryRecord[] = [];
  for (let i = 0; i < docNumbers.length; i += 50) {
    const batch = docNumbers.slice(i, i + 50);
    const r = await qbo.query<{ JournalEntry?: QboEntryRecord[] }>(
      `select * from JournalEntry where DocNumber in (${batch.map(q).join(', ')}) maxresults 1000`,
    );
    out.push(...(r.JournalEntry ?? []));
  }
  return out;
}

export async function accountsByName(qbo: QuickBooksAccess, names: string[]) {
  const r = await qbo.query<{ Account?: { Id: string; Name: string }[] }>(
    `select * from Account where Name in (${names.map(q).join(', ')})`,
  );
  return r.Account ?? [];
}
