/**
 * Durable receipt of Stripe webhooks addressed to the hosted application (shared Stripe ingress route; this
 * runtime verifies and records). Our endpoint's secret is unique to this integration, so a valid signature
 * proves which customer's application the event belongs to. One delivery per Stripe event id: Stripe's
 * retries of the same event never run the application twice from our side (and the application's own
 * idempotency stays in place behind it).
 */
import { and, eq } from 'drizzle-orm';
import { deliveries, integrations, webhookReceipts, type Db } from '@mi/database';
import { sha256Hex, type CredentialCipher } from '@mi/integration-shopify-netsuite';
import { verifyStripeSignature } from '@mi/provider-connections';
import { APP_EVENT_TYPES, appWebhookSecretAad, STRIPE_APP_FLOW_TYPE, StripeAppConfigSchema } from './contract.ts';
import type { StripeEventPayload } from './execute.ts';

export function labelOf(e: Pick<StripeEventPayload, 'type' | 'data'>): string {
  const id = String(e.data?.object?.['id'] ?? '?');
  if (e.type.startsWith('customer.subscription.')) return `Subscription ${id}`;
  if (e.type.startsWith('invoice.')) return `Invoice ${id}`;
  if (e.type.startsWith('payment_intent.')) return `Payment ${id}`;
  return `Checkout ${id}`;
}

export async function receiveAppWebhook(p: {
  db: Db;
  cipher: CredentialCipher;
  integrationId: string;
  rawBody: Buffer;
  signature: string | undefined;
  correlationId?: string;
}) {
  const [integ] = await p.db
    .select()
    .from(integrations)
    .where(and(eq(integrations.id, p.integrationId), eq(integrations.flowType, STRIPE_APP_FLOW_TYPE)));
  if (!integ || !integ.enabled) return { httpStatus: 404, execute: false, error: 'Unknown integration' };
  const config = StripeAppConfigSchema.parse(integ.config);
  if (!config.webhook) return { httpStatus: 404, execute: false, error: 'No webhook endpoint registered' };
  const secret = p.cipher.decrypt<string>(config.webhook.secretCiphertext, appWebhookSecretAad(integ.id));
  if (!verifyStripeSignature(p.rawBody, p.signature, secret))
    return { httpStatus: 400, execute: false, error: 'invalid signature' };
  let ev: StripeEventPayload;
  try {
    ev = JSON.parse(p.rawBody.toString('utf8')) as StripeEventPayload;
  } catch {
    return { httpStatus: 400, execute: false, error: 'body is not JSON' };
  }
  if (!/^evt_[A-Za-z0-9]+$/.test(ev?.id ?? '') || typeof ev.type !== 'string')
    return { httpStatus: 400, execute: false, error: 'payload is not a Stripe event' };
  return recordAppEvent(p.db, p.cipher, integ, ev, p.rawBody, 'webhook', p.correlationId);
}

/** Records one Stripe event as durable input to the application (webhook, or recovered from the Events API). */
export async function recordAppEvent(
  db: Db,
  cipher: CredentialCipher,
  integ: typeof integrations.$inferSelect,
  ev: StripeEventPayload,
  raw: Buffer,
  origin: 'webhook' | 'reconciliation',
  correlationId?: string,
) {
  const handled = (APP_EVENT_TYPES as readonly string[]).includes(ev.type);
  return db.transaction(async (tx) => {
    const receiptId = crypto.randomUUID();
    const inserted = await tx
      .insert(webhookReceipts)
      .values({
        id: receiptId,
        tenantId: integ.tenantId,
        integrationId: integ.id,
        providerWebhookId: origin === 'webhook' ? ev.id : `${ev.id}:recovery:${receiptId}`,
        topic: ev.type,
        shopDomain: 'stripe',
        payloadCiphertext: cipher.encrypt(raw.toString('base64'), `receipt:${receiptId}`),
        payloadSha256: sha256Hex(raw),
        apiVersion: ev.api_version ?? null,
        disposition: handled ? (origin === 'webhook' ? 'accepted' : 'recovery_input') : 'ignored_topic',
        origin,
        correlationId: correlationId ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: webhookReceipts.id });
    if (!inserted.length) return { httpStatus: 200, disposition: 'duplicate_webhook', execute: false };
    if (!handled) return { httpStatus: 200, disposition: 'ignored_topic', execute: false };
    const created = new Date(ev.created * 1000);
    const key = `${integ.id}:${ev.id}`;
    const [fresh] = await tx
      .insert(deliveries)
      .values({
        integrationId: integ.id,
        idempotencyKey: key,
        sourceId: ev.id,
        sourceLegacyId: String(ev.data?.object?.['id'] ?? ''),
        sourceName: labelOf(ev),
        sourceCreatedAt: created,
        sourceUpdatedAt: created,
        latestSourceUpdatedAt: created,
        externalId: ev.id,
        outcome: 'pending',
        receiptId,
      })
      .onConflictDoNothing()
      .returning({ id: deliveries.id });
    if (fresh) {
      await tx.update(webhookReceipts).set({ deliveryId: fresh.id }).where(eq(webhookReceipts.id, receiptId));
      return { httpStatus: 200, disposition: 'accepted', deliveryId: fresh.id, execute: true };
    }
    const [existing] = await tx.select().from(deliveries).where(eq(deliveries.idempotencyKey, key));
    await tx.update(webhookReceipts).set({ deliveryId: existing!.id }).where(eq(webhookReceipts.id, receiptId));
    return { httpStatus: 200, disposition: 'already_received', deliveryId: existing!.id, execute: false };
  });
}
