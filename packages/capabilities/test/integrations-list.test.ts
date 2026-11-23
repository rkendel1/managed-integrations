/**
 * Independent capability tests: the AppPort application is exercised directly through
 * `AppPortApplication.handleRequest`, with no HTTP, MCP, React or Fastify in the path.
 *
 * The database is the real PostgreSQL test database with real migrations.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequest, type AppResponse } from '@appport/protocol';
import { CONTRACT_V1, FLOW_TYPE } from '@mi/contracts';
import { integrations, tenants, type DbHandle } from '@mi/database';
import { freshDb } from '../../../test/support/harness.ts';
import {
  APPPORT_APPLICATION,
  createIntegrationsApplication,
  toAppPortIdentity,
  type AppPortIdentity,
  type IntegrationsListOutput,
} from '../src/index.ts';

let dbh: DbHandle;
let tenantA: { id: string; name: string };
let tenantB: { id: string; name: string };
let integrationA: { id: string };
let integrationB: { id: string };
let callerA: AppPortIdentity;
let callerB: AppPortIdentity;
let operator: AppPortIdentity;

const NOW = new Date('2026-01-01T00:00:00.000Z');

function identity(input: {
  userId: string;
  email: string;
  role: 'customer' | 'operator';
  tenantId: string | null;
  sessionId?: string;
  permissions?: string[];
}): AppPortIdentity {
  const identity = toAppPortIdentity(
    {
      userId: input.userId,
      email: input.email,
      role: input.role,
      tenantId: input.tenantId,
      sessionId: input.sessionId ?? `session-${randomBytes(4).toString('hex')}`,
      sessionCreatedAt: NOW,
      sessionExpiresAt: new Date('2027-01-01T00:00:00.000Z'),
    },
    APPPORT_APPLICATION.id,
  );
  if (input.permissions) {
    return {
      principal: identity.principal,
      session: { ...identity.session, permissions: input.permissions },
    };
  }
  return identity;
}

function request(input: unknown): ReturnType<typeof createRequest> {
  return createRequest({
    requestId: `req_${randomBytes(6).toString('hex')}`,
    capability: { name: 'integrations.list', version: 1 },
    input,
  });
}

async function invoke(
  application: ReturnType<typeof createIntegrationsApplication>,
  caller: AppPortIdentity | undefined,
  input: unknown = {},
): Promise<AppResponse<IntegrationsListOutput>> {
  return application.handleRequest(request(input), {
    transport: 'test',
    ...(caller ? { session: caller.session, principal: caller.principal } : {}),
  }) as Promise<AppResponse<IntegrationsListOutput>>;
}

beforeAll(async () => {
  dbh = await freshDb();
  const [a] = await dbh.db
    .insert(tenants)
    .values({ name: 'Acme Outdoor', slug: 'acme-capabilities', lifecycle: 'active' })
    .returning();
  const [b] = await dbh.db
    .insert(tenants)
    .values({ name: 'Other Co', slug: 'other-capabilities', lifecycle: 'active' })
    .returning();
  tenantA = { id: a!.id, name: a!.name };
  tenantB = { id: b!.id, name: b!.name };

  const [ia] = await dbh.db
    .insert(integrations)
    .values({
      tenantId: tenantA.id,
      flowType: FLOW_TYPE,
      displayName: 'Shopify orders → NetSuite sales orders',
      configVersion: 3,
      config: {
        backfillFrom: '2026-01-01T00:00:00Z',
        netsuiteCustomerId: '501',
        currencyCode: 'USD',
        skuMap: {},
        pageSize: 25,
        encryptedSecretSentinel: 'DO-NOT-LEAK',
      },
      enabled: true,
      lifecycle: 'active',
      contractVersion: CONTRACT_V1.version,
    })
    .returning();
  const [ib] = await dbh.db
    .insert(integrations)
    .values({
      tenantId: tenantB.id,
      flowType: FLOW_TYPE,
      displayName: 'Other tenant integration',
      configVersion: 1,
      config: {},
      enabled: false,
      lifecycle: 'setup',
      contractVersion: CONTRACT_V1.version,
    })
    .returning();
  integrationA = { id: ia!.id };
  integrationB = { id: ib!.id };

  callerA = identity({
    userId: randomBytes(16).toString('hex'),
    email: 'customer@acme.test',
    role: 'customer',
    tenantId: tenantA.id,
  });
  callerB = identity({
    userId: randomBytes(16).toString('hex'),
    email: 'other@other.test',
    role: 'customer',
    tenantId: tenantB.id,
  });
  operator = identity({
    userId: randomBytes(16).toString('hex'),
    email: 'operator@managed-integrations.test',
    role: 'operator',
    tenantId: null,
  });
});

afterAll(async () => {
  await dbh?.close();
});

describe('integrations.list contract', () => {
  it('is registered in the manifest with an explicit schema and authorization requirement', () => {
    const application = createIntegrationsApplication({ db: dbh.db });
    const manifest = application.manifest();
    const capability = manifest.capabilities.find((entry) => entry.name === 'integrations.list');
    expect(capability).toBeDefined();
    expect(capability!.latestVersion).toBe(1);
    expect(capability!.versions).toEqual([1]);
    expect(capability!.kind).toBe('request');
    expect(capability!.authorization).toEqual(['integrations.read']);
    expect(capability!.authorizationContract).toEqual({
      required: true,
      scopes: ['integrations.read'],
    });
    expect(capability!.inputSchema).toMatchObject({
      type: 'object',
      properties: { tenantId: { type: 'string' } },
      additionalProperties: false,
    });
    expect(manifest.application.id).toBe(APPPORT_APPLICATION.id);
  });

  it('returns only the caller tenant, from durable state', async () => {
    const application = createIntegrationsApplication({ db: dbh.db });
    const response = await invoke(application, callerA);
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.output.tenant).toEqual(tenantA);
    expect(response.output.integrations).toHaveLength(1);
    expect(response.output.integrations[0]).toMatchObject({
      id: integrationA.id,
      tenantId: tenantA.id,
      flowId: FLOW_TYPE,
      displayName: 'Shopify orders → NetSuite sales orders',
      lifecycle: 'active',
      configVersion: 3,
    });
    expect(Number.isNaN(Date.parse(response.output.integrations[0]!.createdAt))).toBe(false);
  });

  it('does not return another tenant through a supplied tenantId', async () => {
    const application = createIntegrationsApplication({ db: dbh.db });
    const response = await invoke(application, callerA, { tenantId: tenantB.id });
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('expected denial');
    expect(response.error.code).toBe('FORBIDDEN');
  });

  it('accepts the caller own tenantId', async () => {
    const application = createIntegrationsApplication({ db: dbh.db });
    const response = await invoke(application, callerB, { tenantId: tenantB.id });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.output.integrations.map((i) => i.id)).toEqual([integrationB.id]);
  });

  it('lets an operator with integrations.read:any reach an explicit tenant', async () => {
    const application = createIntegrationsApplication({ db: dbh.db });
    const withoutTenant = await invoke(application, operator);
    expect(withoutTenant.ok).toBe(false);
    if (withoutTenant.ok) throw new Error('expected denial');
    expect(withoutTenant.error.code).toBe('FORBIDDEN');

    const withTenant = await invoke(application, operator, { tenantId: tenantA.id });
    expect(withTenant.ok).toBe(true);
    if (!withTenant.ok) throw new Error(withTenant.error.message);
    expect(withTenant.output.integrations.map((i) => i.id)).toEqual([integrationA.id]);
  });

  it('refuses anonymous callers with UNAUTHORIZED', async () => {
    const application = createIntegrationsApplication({ db: dbh.db });
    const response = await invoke(application, undefined);
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('expected denial');
    expect(response.error.code).toBe('UNAUTHORIZED');
  });

  it('refuses an authenticated principal without the required permission', async () => {
    const application = createIntegrationsApplication({ db: dbh.db });
    const noPermission = identity({
      userId: randomBytes(16).toString('hex'),
      email: 'customer@acme.test',
      role: 'customer',
      tenantId: tenantA.id,
      permissions: [],
    });
    const response = await invoke(application, noPermission);
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('expected denial');
    expect(response.error.code).toBe('FORBIDDEN');
  });

  it('rejects invalid input through the declared schema', async () => {
    const application = createIntegrationsApplication({ db: dbh.db });
    const invalidUuid = await invoke(application, callerA, { tenantId: 'not-a-uuid' });
    expect(invalidUuid.ok).toBe(false);
    if (invalidUuid.ok) throw new Error('expected rejection');
    expect(invalidUuid.error.code).toBe('INVALID_INPUT');

    const unknownProperty = await invoke(application, callerA, { crossTenant: tenantB.id });
    expect(unknownProperty.ok).toBe(false);
    if (unknownProperty.ok) throw new Error('expected rejection');
    expect(unknownProperty.error.code).toBe('INVALID_INPUT');
  });

  it('never returns stored configuration or secret material', async () => {
    const application = createIntegrationsApplication({ db: dbh.db });
    const response = await invoke(application, callerA);
    const serialized = JSON.stringify(response);
    expect(serialized).not.toMatch(/DO-NOT-LEAK|encryptedSecretSentinel|skuMap|ciphertext/i);
  });

  it('reads the same durable rows from a fresh application instance', async () => {
    const first = createIntegrationsApplication({ db: dbh.db });
    const before = await invoke(first, callerA);
    const second = createIntegrationsApplication({ db: dbh.db });
    const after = await invoke(second, callerA);
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    if (!before.ok || !after.ok) throw new Error('expected success');
    expect(after.output).toEqual(before.output);
    const [row] = await dbh.db
      .select({ displayName: integrations.displayName })
      .from(integrations)
      .where(eq(integrations.id, integrationA.id));
    expect(row?.displayName).toBe('Shopify orders → NetSuite sales orders');
  });
});
