/**
 * Shared integration-test harness: real PostgreSQL (test database), real migrations, and the
 * deterministic provider fixtures listening on ephemeral ports. No provider is mocked at the
 * HTTP-client level — the production clients talk HTTP to the fixtures.
 */
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { CONTRACT_V1, FLOW_TYPE, type IntegrationConfig } from '@mi/contracts';
import { connections, createDb, integrations, migrate, tenants, type DbHandle } from '@mi/database';
import { registerLedgerlyReferenceData } from '@mi/adopted-ledgerly';
import {
  bootstrapReferenceData,
  ConnectionCredentials,
  CredentialCipher,
  generateNetSuiteKeyPair,
  NetSuiteClient,
  parseKeyRing,
  ShopifyClient,
  sourceImplementation,
  SyncEngine,
  type IntegrationImplementation,
  type ProviderEndpointConfig,
  type RetryPolicy,
} from '@mi/integration-shopify-netsuite';
import {
  createNetSuiteFixture,
  createShopifyFixture,
  type NetSuiteFixture,
  type ShopifyFixture,
} from '@mi/test-fixtures';

export const TEST_DB_URL =
  process.env.DATABASE_URL_TEST ?? 'postgres://mi:mi_dev_password@localhost:5432/managed_integrations_test';

let migrated = false;

export async function freshDb(): Promise<DbHandle> {
  if (!migrated) {
    await migrate(TEST_DB_URL);
    migrated = true;
  }
  const handle = createDb(TEST_DB_URL, { max: 5 });
  const { rows } = await handle.pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  if (rows.length) {
    await handle.pool.query(
      `TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
  }
  await bootstrapReferenceData(handle.db);
  await registerLedgerlyReferenceData(handle.db);
  return handle;
}

export const testCipher = new CredentialCipher(parseKeyRing(`test:${randomBytes(32).toString('base64')}`)!);

/** Fast, deterministic retry policy for tests (no real sleeping). */
export const FAST_RETRY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 1,
  maxDelayMs: 2,
  random: () => 0.5,
  sleep: async () => {},
};

export const DEFAULT_CONFIG: IntegrationConfig = {
  backfillFrom: '2026-01-01T00:00:00Z',
  netsuiteCustomerId: '501',
  netsuiteSubsidiaryId: '1',
  currencyCode: 'USD',
  skuMap: { 'SKU-RED': '101', 'SKU-BLUE': '102' },
  pageSize: 10,
};

export interface Harness {
  dbh: DbHandle;
  shopify: ShopifyFixture;
  netsuite: NetSuiteFixture;
  shopifyUrl: string;
  netsuiteUrl: string;
  tenantId: string;
  integrationId: string;
  endpoints: ProviderEndpointConfig;
  creds: ConnectionCredentials;
  engine(opts?: {
    implementation?: IntegrationImplementation;
    workerId?: string;
    retry?: RetryPolicy;
  }): Promise<SyncEngine>;
  clients(apiVersion?: string): Promise<{ shopify: ShopifyClient; netsuite: NetSuiteClient }>;
  close(): Promise<void>;
}

export async function createHarness(
  opts: { config?: Partial<IntegrationConfig>; implementationVersionId?: string | null } = {},
): Promise<Harness> {
  const dbh = await freshDb();
  const shopify = createShopifyFixture();
  const netsuite = createNetSuiteFixture();
  // Provider behaviour profile under test (see docs/architecture/TESTING.md). Validation of a repair
  // runs the same authoritative suite against the profile that reproduces the observed failure.
  const profile = (process.env.SHOPIFY_FIXTURE_PROFILE ?? 'baseline') as 'baseline' | 'drift';
  shopify.control.setVariant(profile);
  await shopify.app.listen({ port: 0, host: '127.0.0.1' });
  await netsuite.app.listen({ port: 0, host: '127.0.0.1' });
  const shopifyUrl = `http://127.0.0.1:${(shopify.app.server.address() as AddressInfo).port}`;
  const netsuiteUrl = `http://127.0.0.1:${(netsuite.app.server.address() as AddressInfo).port}`;
  const endpoints: ProviderEndpointConfig = {
    shopifyClientId: shopify.clientId,
    shopifyClientSecret: shopify.clientSecret,
    shopifyBaseUrlOverride: shopifyUrl,
    netsuiteBaseUrlOverride: netsuiteUrl,
    production: false,
  };

  const [tenant] = await dbh.db
    .insert(tenants)
    .values({ name: 'Acme Outdoor', slug: `acme-${randomBytes(3).toString('hex')}`, lifecycle: 'active' })
    .returning();
  const tenantId = tenant!.id;

  // Shopify connection with fixture-issued expiring tokens (encrypted at rest).
  const tok = shopify.control.issueToken('read_orders');
  const [sc] = await dbh.db
    .insert(connections)
    .values({
      tenantId,
      providerId: 'shopify',
      status: 'verified',
      externalAccount: shopify.shopDomain,
      baseUrl: shopifyUrl,
      grantedScopes: ['read_orders'],
    })
    .returning();
  const now = Date.now();
  await dbh.db
    .update(connections)
    .set({
      credentialsCiphertext: testCipher.encrypt(
        {
          accessToken: tok.access_token,
          refreshToken: tok.refresh_token,
          accessTokenExpiresAt: new Date(now + tok.expires_in * 1000).toISOString(),
          refreshTokenExpiresAt: new Date(now + tok.refresh_token_expires_in * 1000).toISOString(),
          scope: tok.scope,
        },
        `connection:${sc!.id}`,
      ),
      credentialsKeyId: testCipher.keyId,
    })
    .where(sql`id = ${sc!.id}`);

  // NetSuite M2M connection: key pair generated by us, public half registered with the fixture.
  const kp = generateNetSuiteKeyPair();
  netsuite.control.registerPublicKey(kp.publicKeyPem);
  const [nc] = await dbh.db
    .insert(connections)
    .values({
      tenantId,
      providerId: 'netsuite',
      status: 'verified',
      externalAccount: netsuite.accountId,
      baseUrl: netsuiteUrl,
      grantedScopes: ['rest_webservices'],
    })
    .returning();
  await dbh.db
    .update(connections)
    .set({
      credentialsCiphertext: testCipher.encrypt(
        {
          clientId: netsuite.clientId,
          certificateId: netsuite.certificateId,
          privateKeyPem: kp.privateKeyPem,
          algorithm: 'PS256',
        },
        `connection:${nc!.id}`,
      ),
      credentialsKeyId: testCipher.keyId,
    })
    .where(sql`id = ${nc!.id}`);

  const [integration] = await dbh.db
    .insert(integrations)
    .values({
      tenantId,
      flowType: FLOW_TYPE,
      displayName: 'Shopify orders → NetSuite sales orders',
      configVersion: 1,
      config: { ...DEFAULT_CONFIG, ...opts.config },
      enabled: true,
      lifecycle: 'active',
      contractVersion: CONTRACT_V1.version,
      implementationVersionId: opts.implementationVersionId ?? null,
    })
    .returning();

  const creds = new ConnectionCredentials(dbh.db, testCipher, endpoints);

  async function clients(apiVersion = sourceImplementation.shopifyApiVersion) {
    const s = await creds.load(tenantId, 'shopify');
    const n = await creds.load(tenantId, 'netsuite');
    return {
      shopify: new ShopifyClient({
        baseUrl: s!.baseUrl!,
        apiVersion,
        auth: creds.shopifyAuth(s!),
        timeoutMs: 2000,
      }),
      netsuite: new NetSuiteClient({ baseUrl: n!.baseUrl!, auth: creds.netsuiteAuth(n!), timeoutMs: 2000 }),
    };
  }

  return {
    dbh,
    shopify,
    netsuite,
    shopifyUrl,
    netsuiteUrl,
    tenantId,
    integrationId: integration!.id,
    endpoints,
    creds,
    clients,
    async engine(o = {}) {
      const impl = o.implementation ?? sourceImplementation;
      const c = await clients(impl.shopifyApiVersion);
      return new SyncEngine({
        db: dbh.db,
        implementation: impl,
        implementationVersionId: null,
        shopify: c.shopify,
        netsuite: c.netsuite,
        workerId: o.workerId ?? 'test-worker',
        retry: o.retry ?? FAST_RETRY,
        sleep: async () => {},
      });
    },
    async close() {
      await shopify.app.close();
      await netsuite.app.close();
      await dbh.close();
    },
  };
}
