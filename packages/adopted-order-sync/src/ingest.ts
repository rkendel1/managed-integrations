/**
 * Webhook ingress for the adopted flow. Managed Integrations hosts the endpoint (instead of the
 * upstream `server.js`) so that every accepted webhook is tenant-routed and durably recorded
 * BEFORE it is acknowledged. Signature verification is the upstream implementation.
 */
import { and, eq } from 'drizzle-orm';
import { verifyShopifyHmac } from 'shopify-sync/src/webhook.js';
import { connections, deliveries, integrations, webhookReceipts, type Db } from '@mi/database';
import { normalizeShopDomain, sha256Hex, type CredentialCipher } from '@mi/integration-shopify-netsuite';
import { ADOPTED_FLOW_TYPE } from './contract.ts';

export const SUPPORTED_TOPIC = 'orders/create';

export type IngestDisposition =
  'accepted' | 'duplicate_webhook' | 'already_delivered' | 'ignored_topic' | 'joined_recovery';

export interface IngestResult {
  httpStatus: 200 | 400 | 401 | 404;
  disposition?: IngestDisposition;
  receiptId?: string;
  deliveryId?: string;
  /** True when the delivery must be executed (enqueue it). */
  execute: boolean;
  error?: string;
}

export interface IngestParams {
  db: Db;
  cipher: CredentialCipher;
  integrationId: string;
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  /** Shopify app client secret (Shopify signs app webhooks with it). */
  webhookSecret: string;
  correlationId?: string;
}

const header = (h: IngestParams['headers'], name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

interface ShopifyOrderIdentity {
  id: number | string;
  name: string;
  created_at?: string;
  updated_at?: string;
}

export async function ingestShopifyWebhook(p: IngestParams): Promise<IngestResult> {
  const [integ] = await p.db
    .select()
    .from(integrations)
    .where(and(eq(integrations.id, p.integrationId), eq(integrations.flowType, ADOPTED_FLOW_TYPE)));
  if (!integ || !integ.enabled) return { httpStatus: 404, execute: false, error: 'Unknown integration' };

  // 1. Authenticity — upstream implementation, on the raw bytes.
  if (!verifyShopifyHmac(p.rawBody, header(p.headers, 'x-shopify-hmac-sha256'), p.webhookSecret)) {
    return { httpStatus: 401, execute: false, error: 'invalid signature' };
  }
  // 2. The signed shop must be the shop this tenant connected (a valid signature from another shop is refused).
  const [shopConn] = await p.db
    .select()
    .from(connections)
    .where(and(eq(connections.tenantId, integ.tenantId), eq(connections.providerId, 'shopify')));
  let shopDomain: string;
  try {
    shopDomain = normalizeShopDomain(header(p.headers, 'x-shopify-shop-domain') ?? '');
  } catch {
    return { httpStatus: 401, execute: false, error: 'missing or invalid shop domain' };
  }
  if (!shopConn?.externalAccount || shopConn.externalAccount !== shopDomain) {
    return { httpStatus: 401, execute: false, error: 'shop is not attached to this integration' };
  }
  const webhookId = header(p.headers, 'x-shopify-webhook-id');
  const topic = header(p.headers, 'x-shopify-topic') ?? '';
  if (!webhookId || webhookId.length > 200)
    return { httpStatus: 400, execute: false, error: 'missing webhook id' };

  let order: ShopifyOrderIdentity;
  try {
    order = JSON.parse(p.rawBody.toString('utf8')) as ShopifyOrderIdentity;
  } catch {
    return { httpStatus: 400, execute: false, error: 'body is not JSON' };
  }

  return p.db.transaction(async (tx) => {
    const receiptId = crypto.randomUUID();
    const disposition: IngestDisposition = topic === SUPPORTED_TOPIC ? 'accepted' : 'ignored_topic';
    const inserted = await tx
      .insert(webhookReceipts)
      .values({
        id: receiptId,
        tenantId: integ.tenantId,
        integrationId: integ.id,
        providerWebhookId: webhookId,
        topic,
        shopDomain,
        payloadCiphertext: p.cipher.encrypt(p.rawBody.toString('base64'), `receipt:${receiptId}`),
        payloadSha256: sha256Hex(p.rawBody),
        disposition,
        correlationId: p.correlationId ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: webhookReceipts.id });
    if (!inserted.length)
      return { httpStatus: 200, disposition: 'duplicate_webhook', execute: false } as IngestResult;
    if (disposition === 'ignored_topic')
      return { httpStatus: 200, disposition, receiptId, execute: false } as IngestResult;

    if (order?.id == null || !/^\d+$/.test(String(order.id)) || typeof order.name !== 'string') {
      return { httpStatus: 400, execute: false, error: 'payload is not a Shopify order' } as IngestResult;
    }
    const legacyId = String(order.id);
    const sourceId = `gid://shopify/Order/${legacyId}`;
    const createdAt = new Date(order.created_at ?? Date.now());
    const updatedAt = new Date(order.updated_at ?? order.created_at ?? Date.now());
    const key = `${integ.id}:${sourceId}`;
    // Conflict-safe: a reconciliation recovery may create the same delivery concurrently.
    const [created] = await tx
      .insert(deliveries)
      .values({
        integrationId: integ.id,
        idempotencyKey: key,
        sourceId,
        sourceLegacyId: legacyId,
        sourceName: order.name,
        sourceCreatedAt: createdAt,
        sourceUpdatedAt: updatedAt,
        latestSourceUpdatedAt: updatedAt,
        externalId: `shopify-${legacyId}`,
        outcome: 'pending',
        receiptId,
      })
      .onConflictDoNothing()
      .returning({ id: deliveries.id });
    let deliveryId: string;
    let execute = true;
    let finalDisposition: IngestDisposition = 'accepted';
    if (created) {
      deliveryId = created.id;
    } else {
      const [existing] = await tx
        .select()
        .from(deliveries)
        .where(eq(deliveries.idempotencyKey, key))
        .for('update');
      deliveryId = existing!.id;
      if (existing!.outcome === 'delivered') {
        execute = false;
        finalDisposition = 'already_delivered';
      } else if (existing!.outcome === 'pending' && existing!.receiptId == null) {
        // A reconciliation recovery is waiting for its input: the real webhook payload takes precedence.
        await tx
          .update(deliveries)
          .set({ receiptId, updatedAt: new Date() })
          .where(eq(deliveries.id, existing!.id));
        execute = false; // the recovery job executes it (single execution path)
        finalDisposition = 'joined_recovery';
      } else if (existing!.outcome === 'pending' || existing!.outcome === 'running') {
        execute = false; // already queued/executing; the newer receipt is kept as evidence only
        finalDisposition = 'duplicate_webhook';
      } else {
        await tx
          .update(deliveries)
          .set({ outcome: 'pending', receiptId, updatedAt: new Date() })
          .where(eq(deliveries.id, existing!.id));
      }
    }
    await tx
      .update(webhookReceipts)
      .set({ deliveryId, disposition: finalDisposition })
      .where(eq(webhookReceipts.id, receiptId));
    return { httpStatus: 200, disposition: finalDisposition, receiptId, deliveryId, execute } as IngestResult;
  });
}
