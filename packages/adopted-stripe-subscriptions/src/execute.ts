/**
 * Runs one durably received Stripe event through the hosted application (its own webhook route: signature
 * check, idempotency, processing), then verifies the application's record against what Stripe states.
 *
 * Outcomes: delivered (verified) · failed/verification (the application answered 200 but recorded something
 * other than what Stripe states — held for maintenance, never retried blindly) · failed/transient (the
 * application answered 5xx: retried) · rejected (4xx) · awaiting_authorization (Stripe access lost).
 */
import { eq } from 'drizzle-orm';
import { deliveries, deliveryAttempts, integrations, observations, webhookReceipts, type Db } from '@mi/database';
import type { CredentialCipher, ProviderEndpointConfig } from '@mi/integration-shopify-netsuite';
import { claimDelivery, observeContract, type ExecutionTrigger } from '@mi/managed';
import { describeError, redact } from '@mi/observability';
import { AuthorizationLost } from '@mi/provider-connections';
import { instanceFor } from './host.ts';
import { compare, expectationOf, type Mismatch } from './verify.ts';

export type StripeEventPayload = {
  id: string;
  type: string;
  created: number;
  api_version?: string;
  data: { object: Record<string, any> };
};

export async function payloadOf(db: Db, cipher: CredentialCipher, receiptId: string) {
  const [r] = await db.select().from(webhookReceipts).where(eq(webhookReceipts.id, receiptId));
  if (!r) throw new Error('Webhook receipt missing for delivery');
  const raw = Buffer.from(cipher.decrypt<string>(r.payloadCiphertext, `receipt:${r.id}`), 'base64');
  return { raw, event: JSON.parse(raw.toString('utf8')) as StripeEventPayload };
}

/** The shape of a Stripe object as the application reads it: its fields (and its items' fields). */
export function shapeOf(o: Record<string, any>) {
  return {
    object: o?.object ?? null,
    fields: Object.keys(o ?? {}).sort(),
    itemFields: o?.items?.data?.[0] ? Object.keys(o.items.data[0]).sort() : null,
  };
}

export type AppOutcome = 'delivered' | 'failed' | 'rejected' | 'awaiting_authorization';
export interface AppExecuteResult {
  executed: boolean;
  outcome?: AppOutcome;
  errorClass?: string | null;
  mismatches?: Mismatch[];
  drift?: { contract: string; apiVersion: string | null; fingerprint: string } | null;
  attemptNo?: number;
  reason?: string;
}

export async function executeAppDelivery(p: {
  db: Db;
  cipher: CredentialCipher;
  endpoints: ProviderEndpointConfig;
  deliveryId: string;
  trigger: ExecutionTrigger;
}): Promise<AppExecuteResult> {
  const { db } = p;
  const claimed = await claimDelivery(db, p.deliveryId);
  if (!claimed) return { executed: false, reason: 'not_claimable' };
  const attemptNo = claimed.attempts;
  const startedAt = new Date();
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, claimed.integrationId));
  let outcome: AppOutcome;
  let errorClass: string | null = null;
  let message: string | null = null;
  let mismatches: Mismatch[] = [];
  let drift: AppExecuteResult['drift'] = null;
  let response: { status: number; body: Record<string, unknown> } | null = null;
  let artifactId = 'unknown';
  try {
    const { raw, event } = await payloadOf(db, p.cipher, claimed.receiptId!);
    // Provider boundary: the representation of the Stripe object the event carries (a subscription, an
    // invoice, …), whatever the event type. Drift from the first representation seen is a durable fact.
    const contract = `stripe.${String(event.data.object['object'] ?? 'unknown')}`;
    const seen = await observeContract(db, {
      integrationId: integ!.id,
      boundary: 'provider',
      provider: 'stripe',
      contract,
      version: event.api_version ?? null,
      shape: shapeOf(event.data.object),
      sample: { eventId: event.id, apiVersion: event.api_version ?? null, shape: shapeOf(event.data.object) },
    });
    if (seen.drift) drift = { contract, apiVersion: event.api_version ?? null, fingerprint: seen.observation.fingerprint };
    const inst = await instanceFor(p, integ!.id);
    artifactId = inst.artifact.id;
    await observeContract(db, {
      integrationId: integ!.id,
      boundary: 'integration',
      contract: 'stripe-subscriptions-app.artifact',
      shape: inst.artifact.id,
      sample: { files: inst.artifact.files, dependencies: inst.artifact.dependencies },
    });
    response = await inst.deliverWebhook(raw);
    if (response.status === 200) {
      const expected = expectationOf(event.data.object);
      if (expected) mismatches = compare(expected, await inst.store.get(expected.model, expected.key));
      outcome = mismatches.length ? 'failed' : 'delivered';
      if (mismatches.length) {
        errorClass = 'verification';
        message = `The application accepted the event but its ${expected!.model} record differs from Stripe: ${mismatches.map((m) => m.field).join(', ')}`;
      }
    } else if (response.status >= 500) {
      outcome = 'failed';
      errorClass = 'transient';
      message = `The application answered ${response.status}: ${JSON.stringify(response.body).slice(0, 300)}`;
    } else {
      outcome = 'rejected';
      errorClass = 'application_refused';
      message = `The application answered ${response.status}: ${JSON.stringify(response.body).slice(0, 300)}`;
    }
  } catch (err) {
    message = describeError(err).message;
    if (err instanceof AuthorizationLost) {
      outcome = 'awaiting_authorization';
      errorClass = 'authentication';
    } else {
      outcome = 'failed';
      errorClass = 'transient';
    }
  }
  const finishedAt = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(deliveries)
      .set({
        outcome,
        lastErrorClass: errorClass,
        lastError: message ? String(redact(message)).slice(0, 1000) : null,
        destinationId: claimed.sourceLegacyId || null,
        summary: { artifact: artifactId, applicationStatus: response?.status ?? null },
        validation: mismatches.length ? { mismatches } : { verified: outcome === 'delivered' },
        ...(outcome === 'delivered' ? { deliveredAt: finishedAt } : {}),
        updatedAt: finishedAt,
      })
      .where(eq(deliveries.id, claimed.id));
    await tx.insert(deliveryAttempts).values({
      deliveryId: claimed.id,
      attemptNo,
      outcome,
      errorClass,
      errorMessage: message ? String(redact(message)).slice(0, 1000) : null,
      destinationId: claimed.sourceLegacyId || null,
      implementationVersionId: artifactId,
      evidence: { trigger: p.trigger, artifact: artifactId, application: response, mismatches, drift },
      startedAt,
      finishedAt,
    });
    if (outcome !== 'delivered')
      await tx.insert(observations).values({
        tenantId: integ!.tenantId,
        integrationId: integ!.id,
        provider: errorClass === 'authentication' ? 'stripe' : 'adopted',
        kind: 'error',
        errorClass,
        code: outcome.toUpperCase(),
        message: `${claimed.sourceName}: ${String(redact(message ?? outcome))}`.slice(0, 2000),
        data: { deliveryId: claimed.id, attemptNo },
        implementationVersionId: artifactId,
      });
  });
  return { executed: true, outcome, errorClass, mismatches, drift, attemptNo };
}
