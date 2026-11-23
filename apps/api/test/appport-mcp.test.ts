/**
 * Native MCP proof: a real MCP client (`@modelcontextprotocol/sdk` Streamable HTTP) talks to the
 * Fastify `/mcp` route that AppPort's MCP adapter serves.
 *
 * The adapter translates each `tools/call` into an AppPort request and dispatches it through the
 * same `handleRequest` pipeline the UI uses, so authorization, validation and the handler are not
 * reimplemented for MCP. Identity comes from the durable application session cookie only.
 */
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTRACT_V1, FLOW_TYPE } from '@mi/contracts';
import { integrations, tenants, users, type DbHandle } from '@mi/database';
import { createApiAppPortRuntime } from '../src/appport-runtime.ts';
import { registerAppPortRoutes } from '../src/appport-routes.ts';
import { createSession, hashPassword } from '../src/auth.ts';
import { freshDb } from '../../../test/support/harness.ts';

let dbh: DbHandle;
let app: FastifyInstance;
let baseUrl: string;
let tenantAId: string;
let tenantBId: string;
let integrationAId: string;
let integrationBId: string;
let tokenA: string;
let tokenB: string;
let tokenOperator: string;

interface ToolResultLike {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
  _meta?: Record<string, unknown>;
}

async function sessionToken(input: {
  email: string;
  role: 'customer' | 'operator';
  tenantId: string | null;
}): Promise<string> {
  const [user] = await dbh.db
    .insert(users)
    .values({
      email: input.email,
      passwordHash: await hashPassword('not-used-in-this-test'),
      role: input.role,
      tenantId: input.tenantId,
    })
    .returning();
  const { token } = await createSession(dbh.db, user!.id);
  return token;
}

/** Opens a fresh MCP client over Streamable HTTP; `cookie` is the only identity carrier. */
async function mcpClient(cookie?: string): Promise<{ client: Client; close(): Promise<void> }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    ...(cookie ? { requestInit: { headers: { cookie } } } : {}),
  });
  const client = new Client({ name: 'managed-integrations-test', version: '1.0.0' });
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close();
    },
  };
}

async function call(
  cookie: string | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResultLike> {
  const { client, close } = await mcpClient(cookie);
  try {
    return (await client.callTool({ name, arguments: args })) as ToolResultLike;
  } finally {
    await close();
  }
}

function outputOf<T>(result: ToolResultLike): T {
  expect(result.isError ?? false).toBe(false);
  const text = result.content?.find((part) => part.type === 'text')?.text;
  expect(text).toBeTruthy();
  return JSON.parse(text!) as T;
}

function errorCodeOf(result: ToolResultLike): string {
  const meta = result._meta?.['dev.appport/error'] as { code?: string } | undefined;
  return meta?.code ?? '';
}

interface IntegrationsList {
  tenant: { id: string; name: string };
  integrations: Array<{
    id: string;
    tenantId: string;
    displayName: string;
    flowId: string;
    lifecycle: string;
    configVersion: number;
  }>;
}

beforeAll(async () => {
  dbh = await freshDb();

  const [a] = await dbh.db
    .insert(tenants)
    .values({ name: 'Acme Outdoor', slug: 'acme-mcp', lifecycle: 'active' })
    .returning();
  const [b] = await dbh.db
    .insert(tenants)
    .values({ name: 'Other Co', slug: 'other-mcp', lifecycle: 'active' })
    .returning();
  tenantAId = a!.id;
  tenantBId = b!.id;

  const [ia] = await dbh.db
    .insert(integrations)
    .values({
      tenantId: tenantAId,
      flowType: FLOW_TYPE,
      displayName: 'Shopify orders → NetSuite sales orders',
      configVersion: 2,
      config: { secretSentinel: 'DO-NOT-LEAK', netsuiteCustomerId: '501' },
      enabled: true,
      lifecycle: 'active',
      contractVersion: CONTRACT_V1.version,
    })
    .returning();
  const [ib] = await dbh.db
    .insert(integrations)
    .values({
      tenantId: tenantBId,
      flowType: FLOW_TYPE,
      displayName: 'Other tenant flow',
      configVersion: 1,
      config: {},
      enabled: false,
      lifecycle: 'setup',
      contractVersion: CONTRACT_V1.version,
    })
    .returning();
  integrationAId = ia!.id;
  integrationBId = ib!.id;

  tokenA = await sessionToken({ email: 'a@acme.test', role: 'customer', tenantId: tenantAId });
  tokenB = await sessionToken({ email: 'b@other.test', role: 'customer', tenantId: tenantBId });
  tokenOperator = await sessionToken({
    email: 'ops@managed-integrations.test',
    role: 'operator',
    tenantId: null,
  });

  app = Fastify({ logger: false });
  registerAppPortRoutes(app, createApiAppPortRuntime({ db: dbh.db }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app?.close();
  await dbh?.close();
});

describe('MCP projection of integrations.list@1', () => {
  it('discovers the capability as an MCP tool with the AppPort input schema', async () => {
    const { client, close } = await mcpClient(`mi_session=${tokenA}`);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((entry) => entry.name === 'integrations_list');
      expect(tool).toBeDefined();
      expect(tool!.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
        properties: { tenantId: { type: 'string' } },
      });
      expect(tools.some((entry) => entry.name === 'integrations_list')).toBe(true);
    } finally {
      await close();
    }
  });

  it('returns the real persisted rows for the authenticated tenant', async () => {
    const result = await call(`mi_session=${tokenA}`, 'integrations_list', {});
    const output = outputOf<IntegrationsList>(result);
    expect(output.tenant.id).toBe(tenantAId);
    expect(output.integrations).toHaveLength(1);
    expect(output.integrations[0]).toMatchObject({
      id: integrationAId,
      tenantId: tenantAId,
      displayName: 'Shopify orders → NetSuite sales orders',
      flowId: FLOW_TYPE,
      lifecycle: 'active',
      configVersion: 2,
    });
    // MCP structuredContent carries the same business object, not a transport-specific copy.
    expect(result.structuredContent).toEqual(output);
    expect(JSON.stringify(result)).not.toContain('DO-NOT-LEAK');
  });

  it('enforces tenant isolation through MCP', async () => {
    const result = await call(`mi_session=${tokenB}`, 'integrations_list', {});
    const output = outputOf<IntegrationsList>(result);
    expect(output.tenant.id).toBe(tenantBId);
    expect(output.integrations.map((i) => i.id)).toEqual([integrationBId]);
  });

  it('refuses anonymous MCP callers without bypassing AppPort authorization', async () => {
    const result = await call(undefined, 'integrations_list', {});
    expect(result.isError).toBe(true);
    expect(errorCodeOf(result)).toBe('UNAUTHORIZED');
  });

  it('refuses a cross-tenant tenantId supplied by a customer', async () => {
    const result = await call(`mi_session=${tokenA}`, 'integrations_list', { tenantId: tenantBId });
    expect(result.isError).toBe(true);
    expect(errorCodeOf(result)).toBe('FORBIDDEN');
  });

  it('lets an operator with integrations.read:any scope a call to another tenant', async () => {
    const result = await call(`mi_session=${tokenOperator}`, 'integrations_list', {
      tenantId: tenantBId,
    });
    const output = outputOf<IntegrationsList>(result);
    expect(output.tenant.id).toBe(tenantBId);
    expect(output.integrations.map((i) => i.id)).toEqual([integrationBId]);
  });

  it('rejects invalid input at the AppPort schema boundary', async () => {
    const result = await call(`mi_session=${tokenA}`, 'integrations_list', {
      tenantId: 'not-a-uuid',
    });
    expect(result.isError).toBe(true);
    expect(errorCodeOf(result)).toBe('INVALID_INPUT');
  });
});

describe('AppPort HTTP binding (the UI transport)', () => {
  it('publishes discovery and the manifest', async () => {
    const wellKnown = await fetch(`${baseUrl}/.well-known/appport`);
    expect(wellKnown.ok).toBe(true);
    const manifest = await fetch(`${baseUrl}/appport/manifest`);
    expect(manifest.ok).toBe(true);
    const body = (await manifest.json()) as {
      application: { id: string };
      capabilities: Array<{ name: string }>;
    };
    expect(body.application.id).toBe('io.managedintegrations.app');
    expect(body.capabilities.map((c) => c.name)).toContain('integrations.list');
  });

  it('declines non-POST MCP requests as the stateless adapter specifies', async () => {
    const response = await fetch(`${baseUrl}/mcp`);
    expect(response.status).toBe(405);
  });
});
