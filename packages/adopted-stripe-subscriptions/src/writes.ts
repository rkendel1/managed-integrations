/**
 * The application's writes to Stripe, through its own routes (src/routes/stripe.ts): each request is a
 * durable delivery keyed by the caller's request id (a repeated request returns the first result and never
 * calls the application again), and its result is read back from Stripe.
 */
import { and, eq } from 'drizzle-orm';
import { deliveries, deliveryAttempts, integrations, type Db } from '@mi/database';
import type { CredentialCipher, ProviderEndpointConfig } from '@mi/integration-shopify-netsuite';
import { stripeFor } from '@mi/provider-connections';
import { instanceFor } from './host.ts';

export const OPERATIONS = {
  'checkout-session': { path: '/v1/stripe/checkout-session', label: 'Checkout session' },
  'payment-intent': { path: '/v1/stripe/payment-intent', label: 'Payment' },
} as const;

export async function invokeAppOperation(
  deps: { db: Db; cipher: CredentialCipher; endpoints: ProviderEndpointConfig },
  p: { integrationId: string; operation: string; input: Record<string, unknown>; requestId: string; principalId: string },
) {
  const { db } = deps;
  const op = OPERATIONS[p.operation as keyof typeof OPERATIONS];
  if (!op) throw new Error(`Unknown operation ${p.operation}`);
  const key = `${p.integrationId}:write:${p.requestId}`;
  const now = new Date();
  const [fresh] = await db
    .insert(deliveries)
    .values({
      integrationId: p.integrationId,
      idempotencyKey: key,
      sourceId: `write:${p.requestId}`,
      sourceLegacyId: p.requestId,
      sourceName: `${op.label} request ${p.requestId}`,
      sourceCreatedAt: now,
      sourceUpdatedAt: now,
      latestSourceUpdatedAt: now,
      externalId: p.requestId,
      outcome: 'running',
      summary: { operation: p.operation, input: p.input, by: p.principalId },
    })
    .onConflictDoNothing()
    .returning();
  if (!fresh) {
    const [prev] = await db.select().from(deliveries).where(eq(deliveries.idempotencyKey, key));
    const v = (prev!.validation ?? {}) as Record<string, unknown>;
    return { deliveryId: prev!.id, outcome: prev!.outcome, output: (v['output'] ?? {}) as Record<string, unknown>, verification: v, replayed: true };
  }
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, p.integrationId));
  const inst = await instanceFor(deps, p.integrationId);
  const startedAt = new Date();
  const res = await inst.call(op.path, p.input);
  let outcome = res.status === 200 ? 'delivered' : res.status >= 500 ? 'failed' : 'rejected';
  const verification: Record<string, unknown> = { output: res.body, applicationStatus: res.status };
  if (res.status === 200 && typeof res.body['id'] === 'string') {
    // Read the created object back from Stripe: it exists and says what was asked.
    const stripe = await stripeFor(db, deps.cipher, deps.endpoints, integ!.tenantId);
    const id = res.body['id'];
    const back = (p.operation === 'checkout-session'
      ? await stripe.sdk.checkout.sessions.retrieve(id)
      : await stripe.sdk.paymentIntents.retrieve(id)) as unknown as Record<string, unknown>;
    const checks =
      p.operation === 'checkout-session'
        ? { mode: back['mode'] === (p.input['mode'] ?? 'subscription'), successUrl: back['success_url'] === p.input['successUrl'] }
        : { amount: back['amount'] === p.input['amount'], currency: back['currency'] === (p.input['currency'] ?? 'usd') };
    const ok = Object.values(checks).every(Boolean);
    Object.assign(verification, { verified: ok, checks, stripeObject: id });
    if (!ok) outcome = 'failed';
  }
  await db.transaction(async (tx) => {
    await tx
      .update(deliveries)
      .set({ outcome, destinationId: (res.body['id'] as string | undefined) ?? null, validation: verification, ...(outcome === 'delivered' ? { deliveredAt: new Date() } : {}), updatedAt: new Date() })
      .where(and(eq(deliveries.id, fresh.id)));
    await tx.insert(deliveryAttempts).values({
      deliveryId: fresh.id,
      attemptNo: 1,
      outcome,
      errorClass: outcome === 'delivered' ? null : res.status >= 500 ? 'transient' : 'application_refused',
      destinationId: (res.body['id'] as string | undefined) ?? null,
      implementationVersionId: inst.artifact.id,
      evidence: { trigger: { kind: 'manual_retry', principalId: p.principalId }, operation: p.operation, application: res, verification },
      startedAt,
      finishedAt: new Date(),
    });
  });
  return { deliveryId: fresh.id, outcome, output: res.body, verification, replayed: false };
}
