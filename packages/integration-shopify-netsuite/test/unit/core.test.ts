import { describe, expect, it } from 'vitest';
import { CONTRACT_V1, ProviderError } from '@mi/contracts';
import { redact } from '@mi/observability';
import { advanceWatermark, configHash, idempotencyKey, shopifyUpdatedAtQuery } from '../../src/engine.ts';
import { classifyStatus } from '../../src/http.ts';
import { implementation } from '../../src/implementation/index.ts';
import { toMinor } from '../../src/implementation/mapping.ts';
import { parseRawOrder } from '../../src/implementation/shopify-orders.ts';
import { computeBackoffMs, parseRetryAfter, withRetry } from '../../src/retry.ts';
import { CredentialCipher, parseKeyRing } from '../../src/secrets.ts';
import { classifyGraphqlErrors } from '../../src/shopify-client.ts';
import {
  normalizeShopDomain,
  resolveNetSuiteBaseUrl,
  resolveShopifyBaseUrl,
  verifyShopifyCallbackHmac,
} from '../../src/connections.ts';
import { createHmac, randomBytes } from 'node:crypto';

const cfg = {
  backfillFrom: '2026-01-01T00:00:00Z',
  netsuiteCustomerId: '501',
  netsuiteSubsidiaryId: '1',
  currencyCode: 'USD',
  skuMap: { A: '101' },
  pageSize: 10,
};
const order = (over: Record<string, unknown> = {}) => ({
  sourceId: 'gid://shopify/Order/7',
  legacyId: '7',
  name: '#1007',
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
  cancelledAt: null,
  currencyCode: 'USD',
  totalAmount: '39.98',
  email: null,
  lineItems: [{ sku: 'A', title: 'A', quantity: 2, unitPrice: '19.99' }],
  ...over,
});

describe('backoff and retry', () => {
  const p = { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 1000, random: () => 0.999 };
  it('grows exponentially with full jitter and is capped', () => {
    expect(computeBackoffMs(1, p)).toBe(99);
    expect(computeBackoffMs(3, p)).toBe(399);
    expect(computeBackoffMs(10, p)).toBe(999);
    expect(computeBackoffMs(3, { ...p, random: () => 0 })).toBe(0);
  });
  it('never waits less than Retry-After', () => {
    expect(computeBackoffMs(1, { ...p, random: () => 0 }, 5000)).toBe(5000);
  });
  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(new Date(Date.now() + 3000).toUTCString())).toBeGreaterThan(1000);
    expect(parseRetryAfter('garbage')).toBeUndefined();
  });
  it('retries only retryable errors, records attempts, and stops at the limit', async () => {
    const attempts: unknown[] = [];
    let n = 0;
    const r = await withRetry(
      async () => {
        if (++n < 3) throw new ProviderError('x', 'transient', { provider: 'shopify' });
        return 'ok';
      },
      { ...p, sleep: async () => {} },
      (a) => {
        attempts.push(a);
      },
    );
    expect(r).toBe('ok');
    expect(attempts).toHaveLength(3);
    await expect(
      withRetry(
        async () => {
          throw new ProviderError('bad', 'invalid_data', { provider: 'netsuite' });
        },
        { ...p, sleep: async () => {} },
      ),
    ).rejects.toThrow('bad');
    let m = 0;
    await expect(
      withRetry(
        async () => {
          m++;
          throw new ProviderError('t', 'rate_limited', { provider: 'netsuite' });
        },
        { ...p, sleep: async () => {} },
      ),
    ).rejects.toThrow();
    expect(m).toBe(4);
  });
});

describe('error classification', () => {
  it('maps HTTP statuses to classes', () => {
    expect(classifyStatus(429)).toBe('rate_limited');
    expect(classifyStatus(401)).toBe('authentication');
    expect(classifyStatus(403)).toBe('authorization');
    expect(classifyStatus(503)).toBe('transient');
    expect(classifyStatus(400)).toBe('invalid_data');
    expect(classifyStatus(418)).toBe('permanent');
  });
  it('classifies GraphQL error codes and derives throttle wait from the cost bucket', () => {
    const t = classifyGraphqlErrors([{ extensions: { code: 'THROTTLED' } }], {
      requestedQueryCost: 300,
      throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 100, restoreRate: 100 },
    });
    expect(t.errorClass).toBe('rate_limited');
    expect(t.details.retryAfterMs).toBe(2000);
    expect(classifyGraphqlErrors([{ message: 'Cannot query field "x" on type "Y".' }]).errorClass).toBe(
      'schema',
    );
    expect(classifyGraphqlErrors([{ message: 'no', extensions: { code: 'ACCESS_DENIED' } }]).errorClass).toBe(
      'authorization',
    );
    expect(classifyGraphqlErrors([{ message: 'weird' }]).errorClass).toBe('unknown');
  });
});

describe('cursor and idempotency', () => {
  it('never moves the watermark backwards', () => {
    expect(advanceWatermark(null, '2026-01-02T00:00:00Z')).toBe('2026-01-02T00:00:00Z');
    expect(advanceWatermark('2026-01-03T00:00:00Z', '2026-01-02T00:00:00Z')).toBe('2026-01-03T00:00:00Z');
    expect(advanceWatermark('2026-01-01T00:00:00Z', null)).toBe('2026-01-01T00:00:00Z');
  });
  it('uses stable keys and an inclusive updated_at query', () => {
    expect(idempotencyKey('i', 'gid://shopify/Order/1')).toBe('i:gid://shopify/Order/1');
    expect(implementation.externalIdFor('1')).toBe('shopify-1');
    expect(shopifyUpdatedAtQuery('2026-01-01T00:00:00.000Z')).toBe("updated_at:>='2026-01-01T00:00:00.000Z'");
    expect(configHash(cfg)).toBe(configHash({ ...cfg }));
    expect(configHash(cfg)).not.toBe(configHash({ ...cfg, skuMap: { A: '102' } }));
  });
});

describe('mapping and contract validation', () => {
  it('maps an in-scope order to a NetSuite payload with an exact minor-unit total', () => {
    const r = implementation.mapOrder(order(), cfg);
    expect(r.kind).toBe('deliver');
    if (r.kind !== 'deliver') return;
    expect(r.payload).toMatchObject({
      externalId: 'shopify-7',
      entity: { id: '501' },
      subsidiary: { id: '1' },
      tranDate: '2026-11-01',
      otherRefNum: '#1007',
    });
    expect(r.payload.item.items).toEqual([{ item: { id: '101' }, quantity: 2, rate: 19.99 }]);
    expect(r.summary.computedTotalMinor).toBe(3998);
  });
  it('rejects unmapped SKUs, missing SKUs and foreign currency; skips cancelled', () => {
    expect(
      implementation.mapOrder(
        order({ lineItems: [{ sku: 'B', title: 'B', quantity: 1, unitPrice: '1' }] }),
        cfg,
      ),
    ).toMatchObject({ kind: 'reject' });
    expect(
      implementation.mapOrder(
        order({ lineItems: [{ sku: null, title: 'B', quantity: 1, unitPrice: '1' }] }),
        cfg,
      ),
    ).toMatchObject({ kind: 'reject' });
    expect(implementation.mapOrder(order({ currencyCode: 'EUR' }), cfg)).toMatchObject({ kind: 'reject' });
    expect(implementation.mapOrder(order({ cancelledAt: '2026-11-01T11:00:00Z' }), cfg)).toMatchObject({
      kind: 'skip',
    });
  });
  it('converts decimal strings to minor units without float drift', () => {
    expect(toMinor('0.1')).toBe(10);
    expect(toMinor('19.99')).toBe(1999);
    expect(toMinor('-3.5')).toBe(-350);
  });
  it('rejects orders whose line items exceed the readable limit rather than truncating', () => {
    const r = parseRawOrder({
      id: 'g',
      legacyResourceId: '1',
      updatedAt: '2026-01-01T00:00:00Z',
      lineItems: { nodes: [], pageInfo: { hasNextPage: true } },
    } as never);
    expect(r.ok).toBe(false);
  });
  it('publishes a contract with every required section', () => {
    for (const k of [
      'scope',
      'direction',
      'freshness',
      'completeness',
      'correctness',
      'idempotency',
      'recovery',
      'compatibility',
      'responsibility',
    ] as const)
      expect(CONTRACT_V1[k]).toBeTruthy();
  });
});

describe('security primitives', () => {
  it('encrypts with AES-GCM bound to the row (AAD) and rejects tampering', () => {
    const c = new CredentialCipher(parseKeyRing(`a:${randomBytes(32).toString('base64')}`)!);
    const env = c.encrypt({ token: 'shpat_abcdefgh123' }, 'connection:1');
    expect(env).not.toContain('shpat_');
    expect(c.decrypt(env, 'connection:1')).toEqual({ token: 'shpat_abcdefgh123' });
    expect(() => c.decrypt(env, 'connection:2')).toThrow();
    expect(() => parseKeyRing('a:short')).toThrow(/32 bytes/);
  });
  it('redacts secrets by key and by value shape', () => {
    const r = redact({
      accessToken: 'x',
      nested: { client_secret: 'y', note: 'Bearer abcdefghijklmnop shpat_0123456789abcdef' },
    }) as { accessToken: string; nested: { client_secret: string; note: string } };
    expect(r.accessToken).toBe('[REDACTED]');
    expect(r.nested.client_secret).toBe('[REDACTED]');
    expect(r.nested.note).not.toMatch(/shpat_|abcdefghijklmnop/);
  });
  it('verifies Shopify callback HMAC and validates provider hosts (SSRF)', () => {
    const q: Record<string, string> = { code: 'c', shop: 'a.myshopify.com', state: 's', timestamp: '1' };
    q.hmac = createHmac('sha256', 'secret')
      .update('code=c&shop=a.myshopify.com&state=s&timestamp=1')
      .digest('hex');
    expect(verifyShopifyCallbackHmac(q, 'secret')).toBe(true);
    expect(verifyShopifyCallbackHmac({ ...q, shop: 'b.myshopify.com' }, 'secret')).toBe(false);
    expect(normalizeShopDomain('https://Store-1.myshopify.com/admin')).toBe('store-1.myshopify.com');
    expect(() => normalizeShopDomain('169.254.169.254')).toThrow();
    const prod = { shopifyClientId: '', shopifyClientSecret: '', production: true };
    expect(resolveShopifyBaseUrl('a.myshopify.com', prod)).toBe('https://a.myshopify.com');
    expect(() =>
      resolveShopifyBaseUrl('a.myshopify.com', { ...prod, shopifyBaseUrlOverride: 'http://evil' }),
    ).toThrow();
    expect(() => resolveNetSuiteBaseUrl('evil.example.com', prod)).toThrow();
    expect(resolveNetSuiteBaseUrl('1234567-sb1.suitetalk.api.netsuite.com', prod)).toBe(
      'https://1234567-sb1.suitetalk.api.netsuite.com',
    );
  });
});
