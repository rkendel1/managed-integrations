/**
 * ADOPTION BOUNDARY TESTS (new): the adopted executor operated through AppPort, over the real API.
 *
 * webhook (HTTP) → durable receipt → pg-boss job → upstream shopify-erp-order-sync → evidence →
 * AppPort capabilities consumed by the UI's client (HTTP binding) AND an MCP client.
 */
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createClient } from '@appport/client';
import { createHttpTransport } from '@appport/transport-http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeDelivery } from '@mi/adopted-order-sync';
import { APPPORT_INVOCATION_ACTION, auditLogTelemetrySink } from '@mi/capabilities';
import { QUEUES } from '@mi/contracts';
import { auditLog, deliveries, tenants, users } from '@mi/database';
import { loadServiceConfig } from '@mi/integration-shopify-netsuite';
import { buildApp } from '../src/app.ts';
import { hashPassword } from '../src/auth.ts';
import { ensureQueues } from '../src/queues.ts';
import { createHarness, TEST_DB_URL, testCipher, type Harness } from '../../../test/support/harness.ts';
import { attachAdoptedTenant, shopifyOrderPayload, signedWebhook } from '../../../test/support/adopted.ts';

let h: Harness;
let adopted: Awaited<ReturnType<typeof attachAdoptedTenant>>;
let app: FastifyInstance;
let boss: PgBoss;
let base: string;
const telemetry = { sink: undefined as ReturnType<typeof auditLogTelemetrySink> | undefined };
const SECRET = 'fixture-shopify-client-secret';

beforeAll(async () => {
  h = await createHarness();
  adopted = await attachAdoptedTenant(h);
  const keys = `k1:${randomBytes(32).toString('base64')}`;
  const config = loadServiceConfig('api', {
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB_URL,
    CREDENTIAL_ENCRYPTION_KEYS: keys,
    SHOPIFY_CLIENT_ID: h.shopify.clientId,
    SHOPIFY_CLIENT_SECRET: SECRET,
    SHOPIFY_BASE_URL_OVERRIDE: h.shopifyUrl,
    NETSUITE_BASE_URL_OVERRIDE: h.netsuiteUrl,
  });
  // The harness encrypted the NetSuite connection with testCipher; use the same cipher here.
  (config as { cipher: unknown }).cipher = testCipher;
  boss = new PgBoss({ connectionString: TEST_DB_URL, schema: 'pgboss_adopted' });
  await boss.start();
  await ensureQueues(boss);
  telemetry.sink = auditLogTelemetrySink(h.dbh.db);
  app = await buildApp({
    db: h.dbh.db,
    boss,
    config,
    logLevel: 'silent',
    invocationEvidence: telemetry.sink,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const pw = await hashPassword('correct horse battery');
  await h.dbh.db.insert(users).values([
    { email: 'ops@bluewave.test', passwordHash: pw, role: 'customer', tenantId: adopted.tenantId },
    { email: 'customer@acme.test', passwordHash: pw, role: 'customer', tenantId: h.tenantId },
    { email: 'operator@mi.test', passwordHash: pw, role: 'operator' },
  ]);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await h?.close();
});

async function cookieFor(email: string) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery' }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0]!;
}
/** The UI's client: @appport/client over the HTTP binding. */
async function ui(cookie?: string) {
  const c = createClient({
    transport: createHttpTransport({ url: `${base}/appport`, headers: cookie ? { cookie } : {} }),
  });
  await c.connect();
  await c.load();
  return c;
}
async function mcp(cookie?: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: cookie ? { cookie } : {} },
  });
  const client = new Client({ name: 'adoption-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}
type ToolResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
};
const toolJson = (r: ToolResult) =>
  (r.structuredContent ?? JSON.parse(r.content?.find((c) => c.type === 'text')?.text ?? 'null')) as Record<
    string,
    unknown
  >;
const errorCode = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};

async function postWebhook(body: object, webhookId?: string) {
  const w = signedWebhook(body, SECRET, adopted.shop, webhookId);
  return fetch(`${base}/webhooks/shopify/${adopted.integrationId}`, {
    method: 'POST',
    headers: w.headers,
    body: w.raw,
  });
}
/** Runs the queued job exactly as the worker does (fetch from pg-boss → executeDelivery). */
async function runQueuedJobs() {
  const results = [];
  for (;;) {
    const [job] = await boss.fetch<{ deliveryId: string; trigger: { kind: 'webhook' } }>(
      QUEUES.adoptedExecute,
    );
    if (!job) return results;
    results.push(
      await executeDelivery({
        db: h.dbh.db,
        cipher: testCipher,
        endpoints: h.endpoints,
        deliveryId: job.data.deliveryId,
        trigger: job.data.trigger,
      }),
    );
    await boss.complete(QUEUES.adoptedExecute, job.id);
  }
}

describe('adopted executor through the managed boundary', () => {
  let deliveredId: string;
  let failedId: string;

  it('a signed Shopify webhook is received over HTTP, queued durably and executed by the upstream code', async () => {
    const order = shopifyOrderPayload({ name: '#8001' });
    const res = await postWebhook(order);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, disposition: 'accepted' });
    const ran = await runQueuedJobs();
    expect(ran).toEqual([
      expect.objectContaining({
        executed: true,
        outcome: 'delivered',
        upstream: expect.objectContaining({ status: 'created' }),
      }),
    ]);
    const [d] = await h.dbh.db.select().from(deliveries).where(eq(deliveries.sourceName, '#8001'));
    deliveredId = d!.id;
    expect(h.netsuite.control.findByExternalId(`shopify-${order.id}`)).toBeTruthy();
  });

  it('an unsigned webhook is refused', async () => {
    const res = await fetch(`${base}/webhooks/shopify/${adopted.integrationId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('MCP discovers the delivery capabilities and the customer sees exactly what the UI client sees', async () => {
    const cookie = await cookieFor('ops@bluewave.test');
    const client = await mcp(cookie);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(
      expect.arrayContaining(['integrations_list', 'deliveries_list', 'deliveries_get', 'deliveries_retry']),
    );
    const viaMcp = toolJson(
      (await client.callTool({
        name: 'deliveries_list',
        arguments: { integrationId: adopted.integrationId },
      })) as ToolResult,
    );
    await client.close();
    const viaUi = (await (
      await ui(cookie)
    ).call('deliveries.list', { integrationId: adopted.integrationId })) as Record<string, unknown>;
    expect(viaMcp).toEqual(viaUi);
    expect(viaUi).toMatchObject({
      integration: {
        executor: {
          kind: 'adopted',
          repository: 'https://github.com/Milo-ai-HQ/shopify-erp-order-sync',
          license: 'MIT',
        },
      },
      deliveries: [
        expect.objectContaining({ id: deliveredId, outcome: 'delivered', order: '#8001', retryable: false }),
      ],
    });
  });

  it('a failure is represented accurately and investigable through deliveries.get', async () => {
    h.netsuite.state.faults.add({ target: 'record.put', type: 'http503', count: 4 });
    await postWebhook(shopifyOrderPayload({ name: '#8002' }));
    const ran = await runQueuedJobs();
    expect(ran[0]).toMatchObject({ outcome: 'failed' });
    const [d] = await h.dbh.db.select().from(deliveries).where(eq(deliveries.sourceName, '#8002'));
    failedId = d!.id;
    const detail = (await (
      await ui(await cookieFor('ops@bluewave.test'))
    ).call('deliveries.get', { deliveryId: failedId })) as {
      delivery: { outcome: string; retryable: boolean; reason: string };
      attempts: { outcome: string; executor: string; upstreamResult: { status: string; message: string } }[];
    };
    expect(detail.delivery).toMatchObject({
      outcome: 'failed',
      retryable: true,
      reason: 'Service unavailable.',
    });
    expect(detail.attempts[0]).toMatchObject({
      outcome: 'failed',
      executor: 'adopted:d01b51d95993',
      upstreamResult: { status: 'failed', message: 'Service unavailable.' },
    });
  });

  it('authorization cannot be bypassed: anonymous, other tenant, and cross-tenant operate are refused on both projections', async () => {
    // Anonymous: AppPort refuses before any capability is reachable (manifest load).
    expect(await errorCode(ui())).toBe('UNAUTHORIZED');
    const anonMcp = await mcp();
    const anonCall = (await anonMcp.callTool({
      name: 'deliveries_list',
      arguments: { integrationId: adopted.integrationId },
    })) as ToolResult;
    await anonMcp.close();
    expect(anonCall.isError).toBe(true);
    expect(JSON.stringify(anonCall)).toMatch(/UNAUTHORIZED/);
    const acme = await cookieFor('customer@acme.test');
    expect(
      await errorCode((await ui(acme)).call('deliveries.list', { integrationId: adopted.integrationId })),
    ).toBe('FORBIDDEN');
    expect(await errorCode((await ui(acme)).call('deliveries.get', { deliveryId: failedId }))).toBe(
      'FORBIDDEN',
    );
    expect(
      await errorCode(
        (await ui(acme)).call('deliveries.retry', { deliveryId: failedId, reason: 'not mine' }),
      ),
    ).toBe('FORBIDDEN');
    const client = await mcp(acme);
    const viaMcp = (await client.callTool({
      name: 'deliveries_retry',
      arguments: { deliveryId: failedId, reason: 'not mine' },
    })) as ToolResult;
    await client.close();
    expect(viaMcp.isError).toBe(true);
    expect(JSON.stringify(viaMcp)).toMatch(/FORBIDDEN/);
    const [d] = await h.dbh.db.select().from(deliveries).where(eq(deliveries.id, failedId));
    expect(d!.outcome).toBe('failed'); // untouched
  });

  it('retry is a consequential, audited operation; duplicate invocations queue the work once', async () => {
    const cookie = await cookieFor('ops@bluewave.test');
    const c = await ui(cookie);
    const [a, b] = await Promise.allSettled([
      c.call('deliveries.retry', { deliveryId: failedId, reason: 'NetSuite outage over' }),
      c.call('deliveries.retry', { deliveryId: failedId, reason: 'NetSuite outage over' }),
    ]);
    const outcomes = [a.status, b.status].sort();
    expect(outcomes).toEqual(['fulfilled', 'rejected']);
    const rejected = (a.status === 'rejected' ? a : b) as PromiseRejectedResult;
    expect((rejected.reason as { code: string }).code).toBe('CONFLICT');
    expect(
      await errorCode(c.call('deliveries.retry', { deliveryId: deliveredId, reason: 'try again' })),
    ).toBe('CONFLICT');

    const ran = await runQueuedJobs();
    expect(ran).toEqual([expect.objectContaining({ outcome: 'delivered', attemptNo: 2 })]);
    const detail = (await c.call('deliveries.get', { deliveryId: failedId })) as {
      attempts: { trigger: { kind: string; reason: string } }[];
    };
    expect(detail.attempts.map((x) => x.trigger.kind)).toEqual(['webhook', 'manual_retry']);
    expect(detail.attempts[1]!.trigger.reason).toBe('NetSuite outage over');
    const audits = await h.dbh.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'delivery.retry_requested'), eq(auditLog.targetId, failedId)));
    expect(audits).toHaveLength(1);
  });

  it('an operator may act on any tenant (read:any / operate:any)', async () => {
    const op = await ui(await cookieFor('operator@mi.test'));
    const list = (await op.call('deliveries.list', { integrationId: adopted.integrationId })) as {
      deliveries: unknown[];
    };
    expect(list.deliveries.length).toBe(2);
  });

  it('every capability invocation is persisted as AppPort invocation evidence, including refusals', async () => {
    await telemetry.sink!.flush();
    const rows = await h.dbh.db.select().from(auditLog).where(eq(auditLog.action, APPPORT_INVOCATION_ACTION));
    const byCap = (cap: string) => rows.filter((r) => r.targetId === cap);
    expect(byCap('deliveries.list@1').length).toBeGreaterThanOrEqual(3);
    expect(byCap('deliveries.retry@1').length).toBeGreaterThanOrEqual(4);
    const details = rows.map(
      (r) => r.details as { success: boolean; errorCode: string | null; transport: string },
    );
    expect(details.some((d) => d.success === false && d.errorCode === 'FORBIDDEN')).toBe(true);
    expect(details.some((d) => d.success === false && d.errorCode === 'UNAUTHORIZED')).toBe(true);
    expect(new Set(details.map((d) => d.transport)).size).toBeGreaterThanOrEqual(2); // HTTP binding + MCP
    const [bluewave] = await h.dbh.db.select().from(tenants).where(eq(tenants.id, adopted.tenantId));
    expect(JSON.stringify(rows)).not.toContain(bluewave!.name); // identifiers and outcomes only
  });
});
