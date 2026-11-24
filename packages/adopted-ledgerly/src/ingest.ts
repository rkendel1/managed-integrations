/**
 * Durable receipt of Stripe webhooks (integration-specific). Upstream's own Express receiver is not used:
 * receipt must be durable, tenant-routed and replayable. Authenticity per Stripe's documentation:
 * Stripe-Signature `t=<unix>,v1=<hex HMAC-SHA256(endpoint secret, "<t>.<raw body>")>`, checked on the raw
 * bytes with a 5-minute tolerance. The endpoint secret is unique to this integration's endpoint, so a valid
 * signature also proves which integration the event belongs to.
 *
 * One delivery per Stripe event id (Stripe retries the same event id); the encrypted payload is the input
 * the adopted code executes.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { deliveries, integrations, webhookReceipts, type Db } from '@mi/database';
import { sha256Hex, type CredentialCipher } from '@mi/integration-shopify-netsuite';
import {
  LEDGERLY_FLOW_TYPE,
  LedgerlyConfigSchema,
  MANAGED_EVENT_TYPES,
  webhookSecretAad,
} from './contract.ts';
import { docNumberOf } from './providers.ts';

const TOLERANCE_S = 300;

export function verifyStripeSignature(
  raw: Buffer,
  header: string | undefined,
  secret: string,
  now = Date.now(),
): boolean {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!Number.isFinite(t) || !sigs.length || Math.abs(now / 1000 - t) > TOLERANCE_S) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex'));
  return sigs.some((s) => {
    const b = Buffer.from(s);
    return b.length === expected.length && timingSafeEqual(b, expected);
  });
}

interface StripeEventIdentity {
  id: string;
  type: string;
  created: number;
  api_version?: string;
  data?: { object?: { id?: string; object?: string; charge?: unknown } };
}

/** What the customer would recognise: "Charge ch_…", "Invoice in_…", "Refund on ch_…", "Payout po_…". */
export function labelOf(e: StripeEventIdentity): string {
  const id = e.data?.object?.id ?? '?';
  if (e.type === 'charge.refunded') return `Refund on ${id}`;
  if (e.type.startsWith('invoice.')) return `Invoice ${id}`;
  if (e.type.startsWith('payout.')) return `Payout ${id}`;
  return `Charge ${id}`;
}

export type StripeIngestDisposition =
  'accepted' | 'duplicate_webhook' | 'already_delivered' | 'ignored_topic' | 'joined_recovery';
export interface StripeIngestResult {
  httpStatus: number;
  disposition?: StripeIngestDisposition;
  receiptId?: string;
  deliveryId?: string;
  execute: boolean;
  error?: string;
}

export async function ingestStripeWebhook(p: {
  db: Db;
  cipher: CredentialCipher;
  integrationId: string;
  rawBody: Buffer;
  signature: string | undefined;
  correlationId?: string;
  origin?: 'webhook' | 'reconciliation';
}): Promise<StripeIngestResult> {
  const [integ] = await p.db
    .select()
    .from(integrations)
    .where(and(eq(integrations.id, p.integrationId), eq(integrations.flowType, LEDGERLY_FLOW_TYPE)));
  if (!integ || !integ.enabled) return { httpStatus: 404, execute: false, error: 'Unknown integration' };
  const config = LedgerlyConfigSchema.parse(integ.config);
  if (!config.webhook) return { httpStatus: 404, execute: false, error: 'No webhook endpoint registered' };
  const secret = p.cipher.decrypt<string>(config.webhook.secretCiphertext, webhookSecretAad(integ.id));
  if (!verifyStripeSignature(p.rawBody, p.signature, secret))
    return { httpStatus: 400, execute: false, error: 'invalid signature' };
  let ev: StripeEventIdentity;
  try {
    ev = JSON.parse(p.rawBody.toString('utf8')) as StripeEventIdentity;
  } catch {
    return { httpStatus: 400, execute: false, error: 'body is not JSON' };
  }
  if (!/^evt_[A-Za-z0-9]+$/.test(ev?.id ?? '') || typeof ev.type !== 'string')
    return { httpStatus: 400, execute: false, error: 'payload is not a Stripe event' };
  return recordEvent(p.db, p.cipher, integ, ev, p.rawBody, p.origin ?? 'webhook', p.correlationId);
}

/** Records one Stripe event as durable execution input (webhook, or reconstructed from the Events API). */
export async function recordEvent(
  db: Db,
  cipher: CredentialCipher,
  integ: typeof integrations.$inferSelect,
  ev: StripeEventIdentity,
  raw: Buffer,
  origin: 'webhook' | 'reconciliation',
  correlationId?: string,
): Promise<StripeIngestResult> {
  const managed = (MANAGED_EVENT_TYPES as readonly string[]).includes(ev.type);
  return db.transaction(async (tx) => {
    const receiptId = crypto.randomUUID();
    const inserted = await tx
      .insert(webhookReceipts)
      .values({
        id: receiptId,
        tenantId: integ.tenantId,
        integrationId: integ.id,
        // Stripe retries carry the same event id; a reconstructed input is a separate receipt.
        providerWebhookId: origin === 'webhook' ? ev.id : `${ev.id}:recovery:${receiptId}`,
        topic: ev.type,
        shopDomain: 'stripe',
        payloadCiphertext: cipher.encrypt(raw.toString('base64'), `receipt:${receiptId}`),
        payloadSha256: sha256Hex(raw),
        apiVersion: ev.api_version ?? null,
        disposition: managed ? (origin === 'webhook' ? 'accepted' : 'recovery_input') : 'ignored_topic',
        origin,
        correlationId: correlationId ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: webhookReceipts.id });
    if (!inserted.length) return { httpStatus: 200, disposition: 'duplicate_webhook', execute: false };
    if (!managed) return { httpStatus: 200, disposition: 'ignored_topic', receiptId, execute: false };
    const created = new Date(ev.created * 1000);
    const key = `${integ.id}:${ev.id}`;
    const [fresh] = await tx
      .insert(deliveries)
      .values({
        integrationId: integ.id,
        idempotencyKey: key,
        sourceId: ev.id,
        sourceLegacyId: ev.data?.object?.id ?? '',
        sourceName: labelOf(ev),
        sourceCreatedAt: created,
        sourceUpdatedAt: created,
        latestSourceUpdatedAt: created,
        externalId: docNumberOf(ev.id),
        outcome: 'pending',
        receiptId,
      })
      .onConflictDoNothing()
      .returning({ id: deliveries.id });
    let deliveryId: string;
    let execute = true;
    let disposition: StripeIngestDisposition = 'accepted';
    if (fresh) deliveryId = fresh.id;
    else {
      const [existing] = await tx
        .select()
        .from(deliveries)
        .where(eq(deliveries.idempotencyKey, key))
        .for('update');
      deliveryId = existing!.id;
      if (existing!.outcome === 'delivered' || existing!.outcome === 'excluded') {
        execute = false;
        disposition = 'already_delivered';
      } else if (['pending', 'running'].includes(existing!.outcome)) {
        execute = false;
        disposition = 'duplicate_webhook';
      } else {
        // failed / held / awaiting_authorization: the newest input is what will run next.
        await tx
          .update(deliveries)
          .set({ receiptId, updatedAt: new Date() })
          .where(eq(deliveries.id, existing!.id));
        execute = existing!.outcome === 'failed';
        disposition = 'joined_recovery';
      }
    }
    await tx.update(webhookReceipts).set({ deliveryId }).where(eq(webhookReceipts.id, receiptId));
    return { httpStatus: 200, disposition, receiptId, deliveryId, execute };
  });
}
