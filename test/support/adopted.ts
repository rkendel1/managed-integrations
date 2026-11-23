/**
 * Test support for the ADOPTED executor: a second tenant whose Shopify → NetSuite flow is run by
 * the upstream shopify-erp-order-sync code. Uses the same fixtures and test database as the
 * native harness so tenant isolation can be tested against real rows.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ADOPTED_CONTRACT, ADOPTED_FLOW_TYPE, registerAdoptedContract } from '@mi/adopted-order-sync';
import { connections, integrations, tenants } from '@mi/database';
import { generateNetSuiteKeyPair } from '@mi/integration-shopify-netsuite';
import { testCipher, type Harness } from './harness.ts';

export const ADOPTED_SHOP = 'bluewave-supply.myshopify.com';

export async function attachAdoptedTenant(h: Harness, opts: { name?: string; shop?: string } = {}) {
  const { db } = h.dbh;
  await registerAdoptedContract(db);
  h.netsuite.state.oneWorld = false; // the adopted code sends no subsidiary (documented gap)
  const [tenant] = await db
    .insert(tenants)
    .values({
      name: opts.name ?? 'Bluewave Supply',
      slug: `bluewave-${randomBytes(3).toString('hex')}`,
      lifecycle: 'active',
    })
    .returning();
  const shop = opts.shop ?? ADOPTED_SHOP;
  await db.insert(connections).values({
    tenantId: tenant!.id,
    providerId: 'shopify',
    status: 'verified',
    externalAccount: shop,
    baseUrl: h.shopifyUrl,
    grantedScopes: ['read_orders'],
  });
  const kp = generateNetSuiteKeyPair();
  h.netsuite.control.registerPublicKey(kp.publicKeyPem);
  const [nc] = await db
    .insert(connections)
    .values({
      tenantId: tenant!.id,
      providerId: 'netsuite',
      status: 'verified',
      externalAccount: h.netsuite.accountId,
      baseUrl: h.netsuiteUrl,
      grantedScopes: ['rest_webservices'],
    })
    .returning();
  await db
    .update(connections)
    .set({
      credentialsCiphertext: testCipher.encrypt(
        {
          clientId: h.netsuite.clientId,
          certificateId: h.netsuite.certificateId,
          privateKeyPem: kp.privateKeyPem,
          algorithm: 'PS256',
        },
        `connection:${nc!.id}`,
      ),
      credentialsKeyId: testCipher.keyId,
    })
    .where(sql`id = ${nc!.id}`);
  const [integration] = await db
    .insert(integrations)
    .values({
      tenantId: tenant!.id,
      flowType: ADOPTED_FLOW_TYPE,
      displayName: 'Shopify orders → NetSuite (adopted: shopify-erp-order-sync)',
      config: { erp: 'netsuite', customerByEmail: {}, defaultCustomer: 'WEB' },
      enabled: true,
      lifecycle: 'active',
      contractVersion: ADOPTED_CONTRACT.version,
    })
    .returning();
  return { tenantId: tenant!.id, integrationId: integration!.id, shop };
}

let orderSeq = 7_100_000_000;

/** A Shopify REST `orders/create` webhook body, as Shopify sends it. */
export function shopifyOrderPayload(
  over: { id?: number; name?: string; sku?: string; quantity?: number; price?: string } = {},
) {
  const id = over.id ?? orderSeq++;
  return {
    id,
    name: over.name ?? `#${id % 100000}`,
    created_at: '2026-11-23T10:00:00-05:00',
    updated_at: '2026-11-23T10:00:00-05:00',
    email: 'buyer@example.test',
    currency: 'USD',
    note: '',
    line_items: [
      {
        sku: over.sku ?? 'SKU-RED',
        quantity: over.quantity ?? 2,
        price: over.price ?? '19.99',
        title: 'Widget',
      },
    ],
  };
}

/** Signs a body exactly as Shopify does: base64(HMAC-SHA256(raw body, app secret)). */
export function signedWebhook(
  body: object,
  secret: string,
  shop: string,
  webhookId = `wh-${randomBytes(6).toString('hex')}`,
  topic = 'orders/create',
) {
  const raw = Buffer.from(JSON.stringify(body));
  return {
    raw,
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': createHmac('sha256', secret).update(raw).digest('base64'),
      'x-shopify-shop-domain': shop,
      'x-shopify-topic': topic,
      'x-shopify-webhook-id': webhookId,
    } as Record<string, string>,
  };
}
