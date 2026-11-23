import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connections, maintenanceRuns, repairCandidates, tenants, users } from '@mi/database';
import { loadServiceConfig } from '@mi/integration-shopify-netsuite';
import { buildApp } from '../src/app.ts';
import { hashPassword } from '../src/auth.ts';
import { ensureQueues } from '../src/queues.ts';
import { createHarness, TEST_DB_URL, type Harness } from '../../../test/support/harness.ts';

let h: Harness;
let app: FastifyInstance;
let boss: PgBoss;
let otherTenantId: string;

beforeAll(async () => {
  h = await createHarness();
  const config = loadServiceConfig('api', {
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB_URL,
    CREDENTIAL_ENCRYPTION_KEYS: `k1:${randomBytes(32).toString('base64')}`,
    SHOPIFY_CLIENT_ID: h.shopify.clientId,
    SHOPIFY_CLIENT_SECRET: h.shopify.clientSecret,
    SHOPIFY_BASE_URL_OVERRIDE: h.shopifyUrl,
    NETSUITE_BASE_URL_OVERRIDE: h.netsuiteUrl,
    PUBLIC_BASE_URL: 'http://localhost:3000',
  });
  boss = new PgBoss({ connectionString: TEST_DB_URL, schema: 'pgboss_test' });
  await boss.start();
  await ensureQueues(boss);
  app = await buildApp({ db: h.dbh.db, boss, config, logLevel: 'silent' });
  const pw = await hashPassword('correct horse battery');
  const [other] = await h.dbh.db.insert(tenants).values({ name: 'Other Co', slug: 'other-co' }).returning();
  otherTenantId = other!.id;
  await h.dbh.db.insert(users).values([
    { email: 'customer@acme.test', passwordHash: pw, role: 'customer', tenantId: h.tenantId },
    { email: 'other@other.test', passwordHash: pw, role: 'customer', tenantId: otherTenantId },
    { email: 'operator@mi.test', passwordHash: pw, role: 'operator' },
  ]);
});
afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await h?.close();
});

async function login(email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'correct horse battery' } });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === 'mi_session')!;
  expect(cookie.httpOnly).toBe(true);
  return { cookie: `mi_session=${cookie.value}`, csrf: res.json().csrfToken as string };
}

describe('authentication', () => {
  it('rejects bad credentials and unauthenticated access', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'customer@acme.test', password: 'nope' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/customer/overview' })).statusCode).toBe(401);
  });

  it('enforces roles and CSRF on mutations', async () => {
    const c = await login('customer@acme.test');
    expect((await app.inject({ method: 'GET', url: '/api/operator/inbox', headers: { cookie: c.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/customer/integration/sync', headers: { cookie: c.cookie } })).statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/api/customer/integration/sync', headers: { cookie: c.cookie, 'x-csrf-token': c.csrf } });
    expect(ok.statusCode).toBe(200);
  });
});

describe('customer views', () => {
  it('returns overview and connections without any secret material', async () => {
    const c = await login('customer@acme.test');
    const overview = await app.inject({ method: 'GET', url: '/api/customer/overview', headers: { cookie: c.cookie } });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().connections).toHaveLength(2);
    const conns = await app.inject({ method: 'GET', url: '/api/customer/connections', headers: { cookie: c.cookie } });
    const text = conns.body;
    expect(text).not.toMatch(/ciphertext|shpat_|shprt_|PRIVATE KEY|v1\.test\./);
    expect(conns.json().find((x: { provider: string }) => x.provider === 'shopify').scopes).toEqual(['read_orders']);
  });

  it('isolates tenants', async () => {
    const other = await login('other@other.test');
    const res = await app.inject({ method: 'GET', url: '/api/customer/integration', headers: { cookie: other.cookie } });
    expect(res.statusCode).toBe(404);
    const conns = await app.inject({ method: 'GET', url: '/api/customer/connections', headers: { cookie: other.cookie } });
    expect(conns.json()).toEqual([]);
  });

  it('validates configuration updates with the contract schema', async () => {
    const c = await login('customer@acme.test');
    const bad = await app.inject({ method: 'PATCH', url: '/api/customer/integration', headers: { cookie: c.cookie, 'x-csrf-token': c.csrf }, payload: { config: { skuMap: { 'SKU-X': 'not-a-number' } } } });
    expect(bad.statusCode).toBe(400);
    const good = await app.inject({ method: 'PATCH', url: '/api/customer/integration', headers: { cookie: c.cookie, 'x-csrf-token': c.csrf }, payload: { config: { skuMap: { 'SKU-RED': '101', 'SKU-BLUE': '102', 'SKU-X': '103' } } } });
    expect(good.statusCode).toBe(200);
    expect(good.json().config.skuMap['SKU-X']).toBe('103');
  });
});

describe('Shopify OAuth (authorization code grant, expiring offline tokens)', () => {
  it('completes the flow against the fixture, verifying HMAC + state and encrypting tokens', async () => {
    await h.dbh.db.delete(connections).where(eq(connections.providerId, 'shopify'));
    const c = await login('customer@acme.test');
    const start = await app.inject({ method: 'POST', url: '/api/customer/connections/shopify/authorize', headers: { cookie: c.cookie, 'x-csrf-token': c.csrf }, payload: { shop: h.shopify.shopDomain } });
    expect(start.statusCode).toBe(200);
    const authorizeUrl = new URL(start.json().url);
    expect(authorizeUrl.searchParams.get('scope')).toBe('read_orders');
    // The fixture auto-approves (a real merchant sees a consent screen) and redirects with code + hmac.
    const redirect = await fetch(authorizeUrl, { redirect: 'manual' });
    const callback = new URL(redirect.headers.get('location')!);

    // Tampered callback is refused.
    const tampered = new URLSearchParams(callback.search);
    tampered.set('shop', 'evil.myshopify.com');
    const bad = await app.inject({ method: 'GET', url: `/api/oauth/shopify/callback?${tampered}` });
    expect(bad.headers.location).toContain('error=');

    const res = await app.inject({ method: 'GET', url: `${callback.pathname}${callback.search}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/app/connections?connected=shopify');
    const [conn] = await h.dbh.db.select().from(connections).where(eq(connections.providerId, 'shopify'));
    expect(conn!.status).toBe('authorized');
    expect(conn!.credentialsCiphertext).toMatch(/^v1\.k1\./);
    expect(conn!.refreshTokenExpiresAt).not.toBeNull();

    // State is single-use.
    const replay = await app.inject({ method: 'GET', url: `${callback.pathname}${callback.search}` });
    expect(replay.headers.location).toContain('error=');

    const verify = await app.inject({ method: 'POST', url: '/api/customer/connections/shopify/verify', headers: { cookie: c.cookie, 'x-csrf-token': c.csrf } });
    expect(verify.json().status).toBe('verified');
  });

  it('rejects shop domains outside myshopify.com (SSRF guard)', async () => {
    const c = await login('customer@acme.test');
    const res = await app.inject({ method: 'POST', url: '/api/customer/connections/shopify/authorize', headers: { cookie: c.cookie, 'x-csrf-token': c.csrf }, payload: { shop: 'http://169.254.169.254/latest' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('operator decisions', () => {
  it('refuses to approve a candidate that has not passed independent validation', async () => {
    const op = await login('operator@mi.test');
    const [mr] = await h.dbh.db.insert(maintenanceRuns).values({ integrationId: h.integrationId, trigger: 'operator', status: 'candidate_submitted' }).returning();
    const [cand] = await h.dbh.db
      .insert(repairCandidates)
      .values({ maintenanceRunId: mr!.id, baseVersionId: 'impl-x', baseCommit: 'abc', branch: 'repair/x', commitSha: 'def', diff: '', changedFiles: [], hypothesis: 'h', status: 'submitted' })
      .returning();
    const res = await app.inject({ method: 'POST', url: `/api/operator/candidates/${cand!.id}/approve`, headers: { cookie: op.cookie, 'x-csrf-token': op.csrf }, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/validated/);
    const inbox = await app.inject({ method: 'GET', url: '/api/operator/inbox', headers: { cookie: op.cookie } });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.json().some((i: { kind: string }) => i.kind === 'candidate')).toBe(true);
    const metrics = await app.inject({ method: 'GET', url: '/api/operator/metrics', headers: { cookie: op.cookie } });
    expect(metrics.json().maintenance.runs).toBe(1);
  });

  it('hides internal errors behind a request id', async () => {
    const op = await login('operator@mi.test');
    const res = await app.inject({ method: 'GET', url: '/api/operator/incidents/not-a-uuid', headers: { cookie: op.cookie } });
    expect(res.statusCode).toBe(404);
  });
});
