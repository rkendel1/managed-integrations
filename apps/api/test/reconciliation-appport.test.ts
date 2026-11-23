/**
 * SLICE 3 boundary tests: reconciliation and recovery through AppPort (UI client + MCP) over the real API.
 * Jobs are taken from pg-boss and run exactly as the worker does.
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
import { adoptedClients, executeRecovery, scanReconciliation } from '@mi/adopted-order-sync';
import { APPPORT_INVOCATION_ACTION, auditLogTelemetrySink } from '@mi/capabilities';
import { QUEUES } from '@mi/contracts';
import { auditLog, integrations, users } from '@mi/database';
import { loadServiceConfig } from '@mi/integration-shopify-netsuite';
import { buildApp } from '../src/app.ts';
import { hashPassword } from '../src/auth.ts';
import { ensureQueues } from '../src/queues.ts';
import {
  createHarness,
  FAST_RETRY,
  TEST_DB_URL,
  testCipher,
  type Harness,
} from '../../../test/support/harness.ts';
import { attachAdoptedTenant } from '../../../test/support/adopted.ts';

let h: Harness;
let a: Awaited<ReturnType<typeof attachAdoptedTenant>>;
let app: FastifyInstance;
let boss: PgBoss;
let base: string;
let sink: ReturnType<typeof auditLogTelemetrySink>;
const PW = 'correct horse battery';

beforeAll(async () => {
  h = await createHarness();
  a = await attachAdoptedTenant(h);
  const [integ] = await h.dbh.db.select().from(integrations).where(eq(integrations.id, a.integrationId));
  await h.dbh.db
    .update(integrations)
    .set({
      config: {
        ...(integ!.config as object),
        reconcileFrom: '2026-11-01T00:00:00Z',
        reconcileGraceMinutes: 0,
      },
    })
    .where(eq(integrations.id, a.integrationId));
  const config = loadServiceConfig('api', {
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB_URL,
    CREDENTIAL_ENCRYPTION_KEYS: `k1:${randomBytes(32).toString('base64')}`,
    SHOPIFY_CLIENT_ID: h.shopify.clientId,
    SHOPIFY_CLIENT_SECRET: 'fixture-shopify-client-secret',
  });
  (config as { cipher: unknown }).cipher = testCipher;
  boss = new PgBoss({ connectionString: TEST_DB_URL, schema: 'pgboss_recon' });
  await boss.start();
  await ensureQueues(boss);
  sink = auditLogTelemetrySink(h.dbh.db);
  app = await buildApp({ db: h.dbh.db, boss, config, logLevel: 'silent', invocationEvidence: sink });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const pw = await hashPassword(PW);
  await h.dbh.db.insert(users).values([
    { email: 'ops@bluewave.test', passwordHash: pw, role: 'customer', tenantId: a.tenantId },
    { email: 'customer@acme.test', passwordHash: pw, role: 'customer', tenantId: h.tenantId },
    { email: 'operator@mi.test', passwordHash: pw, role: 'operator' },
  ]);
  // Shopify knows three orders; none of their webhooks ever arrives.
  for (const [i, sku] of ['SKU-RED', 'SKU-BLUE', 'SKU-RED'].entries()) {
    const t = new Date(Date.parse('2026-11-20T10:00:00Z') + i * 60_000).toISOString();
    a.shopify.control.upsertOrder({
      name: `#M${i + 1}`,
      createdAt: t,
      updatedAt: t,
      email: 'b@bluewave.test',
      lineItems: [{ sku, title: 'Part', quantity: 1, unitPrice: '5.00' }],
    });
  }
}, 60_000);

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await h?.close();
});

async function cookie(email: string) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  });
  return (r.headers.get('set-cookie') ?? '').split(';')[0]!;
}
async function ui(c: string) {
  const client = createClient({
    transport: createHttpTransport({ url: `${base}/appport`, headers: { cookie: c } }),
  });
  await client.connect();
  await client.load();
  return client;
}
async function mcp(c: string) {
  const client = new Client({ name: 'recon-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { cookie: c } } }),
  );
  return client;
}
type ToolResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
};
const json = (r: ToolResult) =>
  (r.structuredContent ?? JSON.parse(r.content?.find((x) => x.type === 'text')?.text ?? 'null')) as Record<
    string,
    unknown
  >;
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};
async function drain<T>(queue: string, run: (data: T) => Promise<unknown>) {
  const out = [];
  for (;;) {
    const [job] = await boss.fetch<T>(queue);
    if (!job) return out;
    out.push(await run(job.data));
    await boss.complete(queue, job.id);
  }
}

describe('reconciliation through AppPort', () => {
  let runId: string;

  it('MCP discovers the reconciliation capabilities', async () => {
    const c = await mcp(await cookie('ops@bluewave.test'));
    const tools = (await c.listTools()).tools.map((t) => t.name);
    await c.close();
    expect(tools).toEqual(
      expect.arrayContaining([
        'reconciliation_start',
        'reconciliation_runs',
        'reconciliation_items',
        'reconciliation_recover',
      ]),
    );
  });

  it('a customer starts reconciliation; the queued scan discovers orders that never arrived by webhook', async () => {
    const c = await ui(await cookie('ops@bluewave.test'));
    const [s1, s2] = (await Promise.all([
      c.call('reconciliation.start', { integrationId: a.integrationId }),
      c.call('reconciliation.start', { integrationId: a.integrationId }),
    ])) as { runId: string; deduplicated: boolean }[];
    expect(s1!.runId).toBe(s2!.runId);
    runId = s1!.runId;
    const clients = await adoptedClients(h.dbh.db, testCipher, h.endpoints, a.integrationId);
    const scans = await drain<{ runId: string }>(QUEUES.adoptedReconcile, (d) =>
      scanReconciliation({ db: h.dbh.db, runId: d.runId, workerId: 'worker-1', clients, retry: FAST_RETRY }),
    );
    expect(scans.map((x) => (x as { status: string }).status)).toContain('completed');
    const items = (await c.call('reconciliation.items', { runId })) as {
      run: { status: string; discovered: number; counts: Record<string, number> };
      items: { classification: string; recoverable: boolean }[];
    };
    expect(items.run).toMatchObject({
      status: 'completed',
      discovered: 3,
      counts: expect.objectContaining({ missing_delivery: 3 }),
    });
    expect(items.items.every((i) => i.classification === 'missing_delivery' && i.recoverable)).toBe(true);
  });

  it('UI client and MCP return identical run views', async () => {
    const ck = await cookie('ops@bluewave.test');
    const viaUi = await (await ui(ck)).call('reconciliation.runs', { integrationId: a.integrationId });
    const m = await mcp(ck);
    const viaMcp = json(
      (await m.callTool({
        name: 'reconciliation_runs',
        arguments: { integrationId: a.integrationId },
      })) as ToolResult,
    );
    await m.close();
    expect(viaMcp).toEqual(viaUi);
  });

  it('cross-tenant reconciliation and recovery are denied at the boundary (tests 14, 15)', async () => {
    const acme = await ui(await cookie('customer@acme.test'));
    expect(await code(acme.call('reconciliation.start', { integrationId: a.integrationId }))).toBe(
      'FORBIDDEN',
    );
    expect(await code(acme.call('reconciliation.runs', { integrationId: a.integrationId }))).toBe(
      'FORBIDDEN',
    );
    expect(await code(acme.call('reconciliation.items', { runId }))).toBe('FORBIDDEN');
    expect(
      await code(
        acme.call('reconciliation.recover', {
          runId,
          sourceOrderIds: ['gid://shopify/Order/5000000001'],
          reason: 'not mine',
        }),
      ),
    ).toBe('FORBIDDEN');
    const m = await mcp(await cookie('customer@acme.test'));
    const r = (await m.callTool({
      name: 'reconciliation_recover',
      arguments: { runId, sourceOrderIds: ['gid://shopify/Order/5000000001'], reason: 'not mine' },
    })) as ToolResult;
    await m.close();
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).toMatch(/FORBIDDEN/);
    // the native tenant's own integration is not reconciled by this capability
    expect(await code(acme.call('reconciliation.start', { integrationId: h.integrationId }))).toBe(
      'CONFLICT',
    );
  });

  it('recovery via MCP: bulk requires confirm, executes through the adopted code, verifies NetSuite, refuses duplicates', async () => {
    const ck = await cookie('ops@bluewave.test');
    const m = await mcp(ck);
    const ids = [...a.shopify.state.orders.values()].map((o) => `gid://shopify/Order/${o.legacyId}`);
    const noConfirm = (await m.callTool({
      name: 'reconciliation_recover',
      arguments: { runId, sourceOrderIds: ids, reason: 'webhooks lost' },
    })) as ToolResult;
    expect(noConfirm.isError).toBe(true);
    expect(JSON.stringify(noConfirm)).toMatch(/confirm/);
    const ok = json(
      (await m.callTool({
        name: 'reconciliation_recover',
        arguments: { runId, sourceOrderIds: ids, reason: 'webhooks lost', confirm: true },
      })) as ToolResult,
    );
    expect(ok).toMatchObject({ requested: 3, refused: [] });
    const dup = json(
      (await m.callTool({
        name: 'reconciliation_recover',
        arguments: { runId, sourceOrderIds: [ids[0]!], reason: 'again' },
      })) as ToolResult,
    );
    expect(dup).toMatchObject({
      accepted: [],
      refused: [expect.objectContaining({ reason: expect.stringMatching(/already/) })],
    });
    await m.close();

    const clients = await adoptedClients(h.dbh.db, testCipher, h.endpoints, a.integrationId);
    const done = await drain<{ itemId: string }>(QUEUES.adoptedRecover, (d) =>
      executeRecovery({
        db: h.dbh.db,
        cipher: testCipher,
        endpoints: h.endpoints,
        itemId: d.itemId,
        clients,
        retry: FAST_RETRY,
      }),
    );
    expect(done.map((x) => (x as { state: string }).state)).toEqual(['recovered', 'recovered', 'recovered']);
    for (const o of a.shopify.state.orders.values()) {
      expect(
        [...h.netsuite.state.salesOrders.values()].filter((r) => r.externalId === `shopify-${o.legacyId}`),
      ).toHaveLength(1);
    }
    const view = (await (await ui(ck)).call('reconciliation.runs', { integrationId: a.integrationId })) as {
      runs: { recovery: Record<string, number> }[];
    };
    expect(view.runs[0]!.recovery).toEqual({ recovered: 3 });
  });

  it('an operator may reconcile any tenant; every request leaves actor and invocation evidence', async () => {
    const op = await ui(await cookie('operator@mi.test'));
    const r = (await op.call('reconciliation.runs', { integrationId: a.integrationId })) as {
      runs: unknown[];
    };
    expect(r.runs.length).toBeGreaterThanOrEqual(1);
    await sink.flush();
    const requested = await h.dbh.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'reconciliation.requested'));
    expect(requested.length).toBeGreaterThanOrEqual(2);
    expect(requested[0]!.details).toMatchObject({
      integrationId: a.integrationId,
      appportRequestId: expect.any(String),
    });
    const recov = await h.dbh.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'reconciliation.recovery_requested'));
    expect(recov).toHaveLength(3);
    const denied = await h.dbh.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, APPPORT_INVOCATION_ACTION),
          eq(auditLog.targetId, 'reconciliation.recover@1'),
        ),
      );
    expect(denied.some((d) => (d.details as { errorCode: string | null }).errorCode === 'FORBIDDEN')).toBe(
      true,
    );
  });
});
