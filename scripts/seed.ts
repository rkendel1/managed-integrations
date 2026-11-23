/**
 * Idempotent bootstrap: migrations, reference data, baseline implementation version, and the
 * pilot tenant/users/integration. With DEMO_FIXTURES=true it also connects the tenant to the
 * DETERMINISTIC provider fixtures (not Shopify/NetSuite) and seeds fixture orders.
 */
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { CONTRACT_V1, FLOW_TYPE } from '@mi/contracts';
import { connections, createDb, integrations, migrate, tenants, users } from '@mi/database';
import {
  bootstrapReferenceData,
  generateNetSuiteKeyPair,
  loadServiceConfig,
} from '@mi/integration-shopify-netsuite';
import { registerVersion } from '@mi/maintenance';
import { hashPassword } from '../apps/api/src/auth.ts';

const config = loadServiceConfig('api');
await migrate(config.env.DATABASE_URL);
const { db, close } = createDb(config.env.DATABASE_URL, { max: 2 });
await bootstrapReferenceData(db);

/* baseline implementation version (artifact baked into the image) */
let baselineVersion: string | null = null;
const baselineDir = resolve(process.env.BASELINE_ARTIFACT_DIR ?? 'baseline-artifact');
try {
  const manifest = JSON.parse(await readFile(join(baselineDir, 'manifest.json'), 'utf8')) as {
    sourceCommit: string;
    file: string;
    sha256: string;
  };
  const artifactDir = resolve(config.env.ARTIFACT_DIR);
  await mkdir(artifactDir, { recursive: true });
  const target = join(artifactDir, manifest.file);
  await copyFile(join(baselineDir, manifest.file), target);
  baselineVersion = await registerVersion(db, {
    sourceCommit: manifest.sourceCommit,
    artifactPath: target,
    artifactSha256: manifest.sha256,
    releaseState: 'released',
  });
  console.log(`baseline implementation version ${baselineVersion}`);
} catch (err) {
  console.warn(
    `no baseline artifact registered (${(err as Error).message}); run scripts/build-baseline-artifact.ts`,
  );
}

/* pilot tenant and users */
const prod = config.production;
const customerPw = process.env.SEED_CUSTOMER_PASSWORD || (prod ? '' : 'customer-demo-password');
const operatorPw = process.env.SEED_OPERATOR_PASSWORD || (prod ? '' : 'operator-demo-password');
if (!customerPw || !operatorPw || customerPw.length < 12 || operatorPw.length < 12) {
  throw new Error('SEED_CUSTOMER_PASSWORD and SEED_OPERATOR_PASSWORD (>=12 chars) are required');
}
const slug = process.env.SEED_TENANT_SLUG ?? 'acme-outdoor';
let [tenant] = await db.select().from(tenants).where(eq(tenants.slug, slug));
if (!tenant)
  [tenant] = await db
    .insert(tenants)
    .values({ name: process.env.SEED_TENANT_NAME ?? 'Acme Outdoor', slug, lifecycle: 'active' })
    .returning();
const customerEmail = (process.env.SEED_CUSTOMER_EMAIL ?? 'customer@acme.test').toLowerCase();
const operatorEmail = (process.env.SEED_OPERATOR_EMAIL ?? 'operator@managed-integrations.test').toLowerCase();
await db
  .insert(users)
  .values({
    email: customerEmail,
    passwordHash: await hashPassword(customerPw),
    role: 'customer',
    tenantId: tenant!.id,
  })
  .onConflictDoNothing();
await db
  .insert(users)
  .values({ email: operatorEmail, passwordHash: await hashPassword(operatorPw), role: 'operator' })
  .onConflictDoNothing();

let [integ] = await db
  .select()
  .from(integrations)
  .where(and(eq(integrations.tenantId, tenant!.id), eq(integrations.flowType, FLOW_TYPE)));
if (!integ) {
  [integ] = await db
    .insert(integrations)
    .values({
      tenantId: tenant!.id,
      flowType: FLOW_TYPE,
      contractVersion: CONTRACT_V1.version,
      implementationVersionId: baselineVersion,
      enabled: false,
      lifecycle: 'setup',
      config: {
        backfillFrom:
          process.env.SEED_BACKFILL_FROM ?? new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
        netsuiteCustomerId: '501',
        netsuiteSubsidiaryId: '1',
        currencyCode: 'USD',
        skuMap: { 'SKU-RED': '101', 'SKU-BLUE': '102' },
        pageSize: 25,
      },
    })
    .returning();
}
if (baselineVersion)
  await db
    .update(integrations)
    .set({ implementationVersionId: baselineVersion })
    .where(and(eq(integrations.id, integ!.id), isNull(integrations.implementationVersionId)));

/* demo: connect to the deterministic fixtures */
if (process.env.DEMO_FIXTURES === 'true') {
  if (prod) throw new Error('DEMO_FIXTURES is not permitted in production');
  const shopUrl = config.endpoints.shopifyBaseUrlOverride;
  const nsUrl = config.endpoints.netsuiteBaseUrlOverride;
  if (!shopUrl || !nsUrl)
    throw new Error('DEMO_FIXTURES requires SHOPIFY_BASE_URL_OVERRIDE and NETSUITE_BASE_URL_OVERRIDE');
  const existing = await db.select().from(connections).where(eq(connections.tenantId, tenant!.id));
  if (!existing.some((c) => c.status === 'verified')) {
    const post = async (url: string, body: unknown) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`fixture ${url} → ${r.status}`);
      return r.json();
    };
    const tok = (await post(`${shopUrl}/__fixture/token`, {})) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      refresh_token_expires_in: number;
      scope: string;
    };
    const kp = generateNetSuiteKeyPair();
    await post(`${nsUrl}/__fixture/public-key`, { pem: kp.publicKeyPem });
    await post(`${shopUrl}/__fixture/seed`, {
      count: 30,
      start: new Date(Date.now() - 6 * 3600_000).toISOString(),
      stepMs: 10 * 60_000,
    });
    const now = Date.now();
    for (const [providerId, account, baseUrl, scopes] of [
      ['shopify', 'fixture-shop.myshopify.com', shopUrl, ['read_orders']],
      ['netsuite', '1234567_SB1', nsUrl, ['rest_webservices']],
    ] as const) {
      const [c] = await db
        .insert(connections)
        .values({
          tenantId: tenant!.id,
          providerId,
          status: 'verified',
          externalAccount: account,
          baseUrl,
          grantedScopes: [...scopes],
          lastVerifiedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [connections.tenantId, connections.providerId],
          set: { status: 'verified', baseUrl, lastVerifiedAt: new Date() },
        })
        .returning();
      const secret =
        providerId === 'shopify'
          ? {
              accessToken: tok.access_token,
              refreshToken: tok.refresh_token,
              accessTokenExpiresAt: new Date(now + tok.expires_in * 1000).toISOString(),
              refreshTokenExpiresAt: new Date(now + tok.refresh_token_expires_in * 1000).toISOString(),
              scope: tok.scope,
            }
          : {
              clientId: 'fixture-netsuite-client-id',
              certificateId: 'fixture-cert-id',
              privateKeyPem: kp.privateKeyPem,
              algorithm: 'PS256',
            };
      await db
        .update(connections)
        .set({
          credentialsCiphertext: config.cipher!.encrypt(secret, `connection:${c!.id}`),
          credentialsKeyId: config.cipher!.keyId,
          ...(providerId === 'shopify'
            ? {
                accessTokenExpiresAt: new Date(now + tok.expires_in * 1000),
                refreshTokenExpiresAt: new Date(now + tok.refresh_token_expires_in * 1000),
              }
            : {}),
        })
        .where(eq(connections.id, c!.id));
    }
    await db
      .update(integrations)
      .set({ enabled: true, lifecycle: 'active' })
      .where(eq(integrations.id, integ!.id));
    console.log('demo: connected to deterministic fixtures and seeded 30 fixture orders');
  }
}
console.log(`seed complete: tenant ${tenant!.slug}, customer ${customerEmail}, operator ${operatorEmail}`);
await close();
