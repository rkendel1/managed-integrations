/**
 * ADOPTION TESTS (new) — the managed boundary around the adopted shopify-erp-order-sync code.
 * The upstream repository's own tests are run separately and unmodified (see "inherited suite").
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, deliveries, deliveryAttempts, webhookReceipts } from '@mi/database';
import { ADOPTED, executeDelivery, ingestShopifyWebhook, requestDeliveryRetry } from '../src/index.ts';
import { createHarness, TEST_DB_URL, testCipher, type Harness } from '../../../test/support/harness.ts';
import { attachAdoptedTenant, shopifyOrderPayload, signedWebhook } from '../../../test/support/adopted.ts';

const UPSTREAM_DIR = join(import.meta.dirname, '..', 'node_modules', 'shopify-sync');

describe('inherited suite: upstream tests run unmodified', () => {
  it('passes the adopted repository’s own 20 tests at the pinned commit', () => {
    const out = execFileSync(process.execPath, ['--test', ...['test/sync.test.js']], {
      cwd: UPSTREAM_DIR,
      encoding: 'utf8',
    });
    expect(out).toMatch(/# tests 20/);
    expect(out).toMatch(/# fail 0/);
  });
});

describe('provenance', () => {
  it('the installed upstream files are byte-identical to the adopted commit (no local modifications)', () => {
    for (const [file, sha] of Object.entries(ADOPTED.fileSha256)) {
      const actual = createHash('sha256')
        .update(readFileSync(join(UPSTREAM_DIR, file)))
        .digest('hex');
      expect(actual, file).toBe(sha);
    }
    expect(ADOPTED.localModifications).toEqual([]);
    expect(readFileSync(join(UPSTREAM_DIR, 'LICENSE'), 'utf8')).toMatch(/^MIT License/);
  });
  it('the lockfile pins the exact adopted commit', () => {
    const lock = readFileSync(join(import.meta.dirname, '..', '..', '..', 'pnpm-lock.yaml'), 'utf8');
    expect(lock).toContain(`resolution: {commit: ${ADOPTED.commit}`);
    const req = createRequire(join(dirname(UPSTREAM_DIR), 'x.js'));
    expect(req('shopify-sync/package.json').name).toBe(ADOPTED.packageName);
  });
});

describe('managed execution of the adopted code', () => {
  let h: Harness;
  let a: Awaited<ReturnType<typeof attachAdoptedTenant>>;
  const secret = 'fixture-shopify-client-secret';
  beforeEach(async () => {
    h = await createHarness();
    a = await attachAdoptedTenant(h);
  });
  afterEach(() => h.close());

  const ingest = (
    body: object,
    o: { webhookId?: string; topic?: string; shop?: string; secret?: string; integrationId?: string } = {},
  ) => {
    const w = signedWebhook(body, o.secret ?? secret, o.shop ?? a.shop, o.webhookId, o.topic);
    return ingestShopifyWebhook({
      db: h.dbh.db,
      cipher: testCipher,
      integrationId: o.integrationId ?? a.integrationId,
      rawBody: w.raw,
      headers: w.headers,
      webhookSecret: secret,
    });
  };
  const execute = (deliveryId: string) =>
    executeDelivery({
      db: h.dbh.db,
      cipher: testCipher,
      endpoints: h.endpoints,
      deliveryId,
      trigger: { kind: 'webhook' },
    });

  it('refuses unsigned, mis-signed and foreign-shop webhooks before recording anything', async () => {
    expect((await ingest(shopifyOrderPayload(), { secret: 'wrong' })).httpStatus).toBe(401);
    expect((await ingest(shopifyOrderPayload(), { shop: 'someone-else.myshopify.com' })).httpStatus).toBe(
      401,
    );
    // the native tenant's integration is not an adopted endpoint
    expect((await ingest(shopifyOrderPayload(), { integrationId: h.integrationId })).httpStatus).toBe(404);
    expect(await h.dbh.db.select().from(webhookReceipts)).toHaveLength(0);
  });

  it('records the webhook durably and encrypted, then the upstream code creates the NetSuite sales order', async () => {
    const order = shopifyOrderPayload({ name: '#5001' });
    const r = await ingest(order);
    expect(r).toMatchObject({ httpStatus: 200, disposition: 'accepted', execute: true });
    const [receipt] = await h.dbh.db.select().from(webhookReceipts);
    expect(receipt!.payloadCiphertext).not.toContain('buyer@example.test');

    const x = await execute(r.deliveryId!);
    expect(x).toMatchObject({
      executed: true,
      outcome: 'delivered',
      upstream: { status: 'created', erp: 'netsuite' },
    });
    const rec = h.netsuite.control.findByExternalId(`shopify-${order.id}`);
    expect(rec?.otherRefNum).toBe('#5001');
    expect(rec?.entity.id).toBe('501'); // defaultCustomer WEB resolved by the upstream SuiteQL lookup

    const [d] = await h.dbh.db.select().from(deliveries).where(eq(deliveries.id, r.deliveryId!));
    expect(d).toMatchObject({ outcome: 'delivered', destinationId: rec!.id, attempts: 1 });
    const [att] = await h.dbh.db
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.deliveryId, d!.id));
    expect(att!.implementationVersionId).toBe(`adopted:${ADOPTED.commit.slice(0, 12)}`);
    expect(att!.evidence).toMatchObject({
      adopted: { commit: ADOPTED.commit },
      upstreamResult: { status: 'created' },
      trigger: { kind: 'webhook' },
    });
  });

  it('deduplicates Shopify webhook retries and never re-executes a delivered order', async () => {
    const order = shopifyOrderPayload();
    const first = await ingest(order, { webhookId: 'wh-1' });
    await execute(first.deliveryId!);
    expect(await ingest(order, { webhookId: 'wh-1' })).toMatchObject({
      disposition: 'duplicate_webhook',
      execute: false,
    });
    expect(await ingest(order, { webhookId: 'wh-2' })).toMatchObject({
      disposition: 'already_delivered',
      execute: false,
    });
    expect(await ingest(order, { topic: 'orders/updated', webhookId: 'wh-3' })).toMatchObject({
      disposition: 'ignored_topic',
      execute: false,
    });
    expect(h.netsuite.state.salesOrders.size).toBe(1);
  });

  it('represents an upstream business rejection accurately and recovers after the cause is fixed', async () => {
    const r = await ingest(shopifyOrderPayload({ sku: 'SKU-NEW' }));
    const x = await execute(r.deliveryId!);
    expect(x).toMatchObject({
      outcome: 'rejected',
      errorClass: 'invalid_data',
      message: 'Items not found in NetSuite: SKU-NEW',
    });
    // the customer creates the item in NetSuite; then a retry is requested
    h.netsuite.state.items.add('104');
    h.netsuite.state.itemCodes.set('104', 'SKU-NEW');
    expect(await requestDeliveryRetry(h.dbh.db, r.deliveryId!)).toMatchObject({
      accepted: true,
      previousOutcome: 'rejected',
    });
    expect(await execute(r.deliveryId!)).toMatchObject({ outcome: 'delivered', attemptNo: 2 });
  });

  it('reports transient failures after the upstream retries, and refuses duplicate concurrent retries', async () => {
    h.netsuite.state.faults.add({ target: 'record.put', type: 'http503', count: 4 });
    const r = await ingest(shopifyOrderPayload());
    expect(await execute(r.deliveryId!)).toMatchObject({ outcome: 'failed', errorClass: 'transient' });
    const fired = h.netsuite.state.faults.fired.filter((f) => f.target === 'record.put').length;
    expect(fired).toBe(4); // 1 call + 3 upstream retries (src/http.js)

    const [one, two] = await Promise.all([
      requestDeliveryRetry(h.dbh.db, r.deliveryId!),
      requestDeliveryRetry(h.dbh.db, r.deliveryId!),
    ]);
    expect([one.accepted, two.accepted].sort()).toEqual([false, true]);
    const [e1, e2] = await Promise.all([execute(r.deliveryId!), execute(r.deliveryId!)]);
    expect([e1.executed, e2.executed].sort()).toEqual([false, true]);
    expect(h.netsuite.state.salesOrders.size).toBe(1);
  });

  it('keeps receipts and pending work across a process restart', async () => {
    const r = await ingest(shopifyOrderPayload());
    const restarted = createDb(TEST_DB_URL, { max: 2 }); // a new process' connection pool
    try {
      const x = await executeDelivery({
        db: restarted.db,
        cipher: testCipher,
        endpoints: h.endpoints,
        deliveryId: r.deliveryId!,
        trigger: { kind: 'automatic_retry' },
      });
      expect(x).toMatchObject({ executed: true, outcome: 'delivered' });
    } finally {
      await restarted.close();
    }
  });

  it('records an unreachable NetSuite authorization as an authentication failure without running upstream code', async () => {
    h.netsuite.control.revoke();
    const r = await ingest(shopifyOrderPayload());
    expect(await execute(r.deliveryId!)).toMatchObject({
      outcome: 'failed',
      errorClass: 'authentication',
      upstream: null,
    });
  });
});
