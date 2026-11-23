/**
 * AUTHORITATIVE ACCEPTANCE SUITE — failure handling (contract 1.0.0 §recovery).
 * Protected: the maintenance agent may not modify files under test/acceptance/.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connections, deliveries, deliveryAttempts, integrations, observations } from '@mi/database';
import { implementation } from '../../src/implementation/index.ts';
import { createHarness, type Harness } from '../../../../test/support/harness.ts';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  h.shopify.control.seedOrders(6, { start: new Date('2026-11-01T00:00:00Z') });
});
afterEach(async () => {
  await h.close();
});
const run = async (o: Partial<Parameters<Awaited<ReturnType<Harness['engine']>>['run']>[0]> = {}) =>
  (await h.engine({ implementation })).run({ integrationId: h.integrationId, trigger: 'manual', ...o });
const integrationRow = async () => (await h.dbh.db.select().from(integrations).where(eq(integrations.id, h.integrationId)))[0]!;

describe('transient provider failures', () => {
  it('retries a NetSuite 500 and records the failed attempt as evidence', async () => {
    h.netsuite.state.faults.add({ target: 'record.put', type: 'http500', count: 2 });
    const r = await run();
    expect(r.status).toBe('succeeded');
    expect(r.counts.delivered).toBe(6);
    const failed = await h.dbh.db.select().from(deliveryAttempts).where(eq(deliveryAttempts.outcome, 'failed'));
    expect(failed).toHaveLength(2);
    expect(failed.every((a) => a.errorClass === 'transient' && a.httpStatus === 500)).toBe(true);
  });

  it('retries a Shopify 500 and a network timeout', async () => {
    h.shopify.state.faults.add({ target: 'graphql', type: 'http500', count: 1 });
    h.shopify.state.faults.add({ target: 'graphql', type: 'timeout', count: 1, delayMs: 2500 });
    const r = await run();
    expect(r.status).toBe('succeeded');
    expect(r.counts.delivered).toBe(6);
  });

  it('fails the run without advancing the cursor past an undelivered order, then resumes', async () => {
    h.netsuite.state.faults.add({ target: 'record.put', type: 'http503', count: 50 });
    const r = await run();
    expect(r.status).toBe('failed');
    expect(r.errorClass).toBe('transient');
    expect(h.netsuite.state.salesOrders.size).toBe(0);
    expect((await integrationRow()).cursorWatermark).toBeNull();
    const [d] = await h.dbh.db.select().from(deliveries);
    expect(d!.outcome).toBe('failed');

    h.netsuite.state.faults.clear();
    const r2 = await run({ trigger: 'recovery' });
    expect(r2.status).toBe('succeeded');
    expect(r2.counts.delivered).toBe(6);
    expect(h.netsuite.state.salesOrders.size).toBe(6);
  });
});

describe('rate limits', () => {
  it('honours NetSuite 429 CONCURRENCY_LIMIT_EXCEEDED with Retry-After', async () => {
    h.netsuite.state.faults.add({ target: 'record.put', type: 'http429', count: 2, retryAfterSeconds: 1 });
    const r = await run();
    expect(r.status).toBe('succeeded');
    const attempts = await h.dbh.db.select().from(deliveryAttempts).where(eq(deliveryAttempts.errorClass, 'rate_limited'));
    expect(attempts).toHaveLength(2);
    // Retry-After (1s) is a floor on the backoff even though the test policy's base delay is 1ms.
    expect(attempts.every((a) => (a.evidence as { retryDelayMs: number }).retryDelayMs >= 1000)).toBe(true);
  });

  it('backs off on Shopify THROTTLED (HTTP 200) and on HTTP 429', async () => {
    h.shopify.state.faults.add({ target: 'graphql', type: 'throttled', count: 1 });
    h.shopify.state.faults.add({ target: 'graphql', type: 'http429', count: 1, retryAfterSeconds: 2 });
    const r = await run();
    expect(r.status).toBe('succeeded');
    const obs = await h.dbh.db.select().from(observations).where(eq(observations.kind, 'rate_limit'));
    expect(obs.length).toBe(2);
  });

  it('never exceeds the client concurrency limit against NetSuite governance', async () => {
    await run();
    expect(h.netsuite.state.maxObservedInflight).toBeLessThanOrEqual(2);
  });
});

describe('pagination anomalies', () => {
  it('detects a repeated page instead of looping, and recovers when it clears', async () => {
    h.shopify.control.seedOrders(15, { start: new Date('2026-11-02T00:00:00Z') });
    // first page served normally, second request repeats the first page once
    const engine = await h.engine({ implementation });
    let calls = 0;
    const orig = h.shopify.state.faults.take.bind(h.shopify.state.faults);
    h.shopify.state.faults.take = (t: string) => (t === 'graphql' && ++calls === 2 ? { target: 'graphql', type: 'repeat_page', count: 0 } : orig(t));
    const r = await engine.run({ integrationId: h.integrationId, trigger: 'manual' });
    expect(r.status).toBe('succeeded');
    expect(r.counts.delivered).toBe(21);
    const anomalies = await h.dbh.db.select().from(observations).where(eq(observations.kind, 'anomaly'));
    expect(anomalies.some((a) => a.message.includes('repeated'))).toBe(true);
  });

  it('fails safely when the provider never advances pagination', async () => {
    h.shopify.control.seedOrders(15, { start: new Date('2026-11-02T00:00:00Z') });
    const engine = await h.engine({ implementation });
    let calls = 0;
    const orig = h.shopify.state.faults.take.bind(h.shopify.state.faults);
    h.shopify.state.faults.take = (t: string) => (t === 'graphql' && ++calls >= 2 ? { target: 'graphql', type: 'repeat_page', count: 0 } : orig(t));
    const r = await engine.run({ integrationId: h.integrationId, trigger: 'manual' });
    expect(r.status).toBe('failed');
    // the first page is durable; nothing beyond it is claimed
    expect(r.counts.delivered).toBe(10);
    expect((await integrationRow()).backfillCompletedAt).toBeNull();
  });

  it('treats hasNextPage without an endCursor (missing page) as an anomaly', async () => {
    h.shopify.state.faults.add({ target: 'graphql', type: 'missing_cursor', count: 1 });
    const r = await run();
    expect(r.status).toBe('succeeded');
    const anomalies = await h.dbh.db.select().from(observations).where(eq(observations.kind, 'anomaly'));
    expect(anomalies.some((a) => a.message.includes('endCursor'))).toBe(true);
  });

  it('terminates pagination: a page limit converts runaway pagination into a failed run', async () => {
    h.shopify.control.seedOrders(40, { start: new Date('2026-11-02T00:00:00Z') });
    const r = await run({ maxPages: 2 });
    expect(r.status).toBe('failed');
    expect(r.errorClass).toBe('permanent');
  });
});

describe('authentication and authorization', () => {
  it('refreshes an expired Shopify access token and persists the rotated pair', async () => {
    const before = (await h.dbh.db.select().from(connections).where(eq(connections.providerId, 'shopify')))[0]!;
    h.shopify.control.expireAccessTokens();
    const r = await run();
    expect(r.status).toBe('succeeded');
    const after = (await h.dbh.db.select().from(connections).where(eq(connections.providerId, 'shopify')))[0]!;
    expect(after.credentialsCiphertext).not.toBe(before.credentialsCiphertext);
    expect(h.shopify.state.requestLog.some((l) => l.kind === 'token_refresh')).toBe(true);
  });

  it('classifies a revoked Shopify grant as authentication and marks the connection revoked', async () => {
    h.shopify.control.revoke();
    const r = await run();
    expect(r.status).toBe('failed');
    expect(r.errorClass).toBe('authentication');
    const conn = (await h.dbh.db.select().from(connections).where(eq(connections.providerId, 'shopify')))[0]!;
    expect(conn.status).toBe('revoked');
    expect(h.netsuite.state.salesOrders.size).toBe(0);
  });

  it('re-mints an expired NetSuite M2M token', async () => {
    const engine = await h.engine({ implementation });
    await engine.run({ integrationId: h.integrationId, trigger: 'manual' });
    h.netsuite.control.expireTokens();
    h.shopify.control.seedOrders(2, { start: new Date('2026-11-05T00:00:00Z') });
    const r = await engine.run({ integrationId: h.integrationId, trigger: 'schedule' });
    expect(r.status).toBe('succeeded');
    expect(r.counts.delivered).toBe(2);
    expect(h.netsuite.state.requestLog.filter((l) => l.kind === 'token').length).toBe(2);
  });

  it('classifies a revoked NetSuite integration as authentication without advancing the cursor', async () => {
    h.netsuite.control.revoke();
    const r = await run();
    expect(r.status).toBe('failed');
    expect(r.errorClass).toBe('authentication');
    expect((await integrationRow()).cursorWatermark).toBeNull();
  });
});
