/**
 * The execution boundary every adopted executor shares (generic; extracted from slice 2): one durable
 * delivery per source transaction, an atomic claim so only one executor runs it (a stuck execution becomes
 * claimable again), bounded automatic retries, and retry requests that cannot queue duplicate work.
 * What an execution DOES is the integration's own code.
 */
import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { deliveries, type Db } from '@mi/database';

export const STUCK_AFTER_MS = 10 * 60_000;
/** Automatic executions per delivery before it is left for a person (manual retry stays available). */
export const MAX_AUTOMATIC_EXECUTIONS = 5;
const RESCHEDULE_DELAYS_S = [60, 300, 1800, 7200];

export function nextAutomaticRetryDelaySeconds(executions: number): number | null {
  if (executions >= MAX_AUTOMATIC_EXECUTIONS) return null;
  return RESCHEDULE_DELAYS_S[Math.min(executions - 1, RESCHEDULE_DELAYS_S.length - 1)] ?? null;
}

/** Atomic claim: pending (or stuck running) → running, attempts + 1. Null when not claimable. */
export async function claimDelivery(db: Db, deliveryId: string) {
  const stuckBefore = new Date(Date.now() - STUCK_AFTER_MS);
  const [claimed] = await db
    .update(deliveries)
    .set({ outcome: 'running', attempts: sql`${deliveries.attempts} + 1`, updatedAt: new Date() })
    .where(
      and(
        eq(deliveries.id, deliveryId),
        or(
          eq(deliveries.outcome, 'pending'),
          and(eq(deliveries.outcome, 'running'), lt(deliveries.updatedAt, stuckBefore)),
        ),
      ),
    )
    .returning();
  return claimed ?? null;
}

export type RetryRequestResult =
  | { accepted: true; deliveryId: string; previousOutcome: string }
  | { accepted: false; currentOutcome: string | null };

/**
 * Atomically moves a delivery back to `pending` so it can be executed again. Allowed only for failed or
 * rejected deliveries, or ones stuck in pending/running. A second concurrent request finds the delivery
 * already pending and is refused, so duplicate invocations cannot queue duplicate work.
 */
export async function requestDeliveryRetry(db: Db, deliveryId: string): Promise<RetryRequestResult> {
  const stuckBefore = new Date(Date.now() - STUCK_AFTER_MS);
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(deliveries).where(eq(deliveries.id, deliveryId)).for('update');
    if (!cur) return { accepted: false, currentOutcome: null };
    const retryable =
      cur.receiptId != null &&
      (['failed', 'rejected'].includes(cur.outcome) ||
        (['pending', 'running'].includes(cur.outcome) && cur.updatedAt < stuckBefore));
    if (!retryable) return { accepted: false, currentOutcome: cur.outcome };
    await tx
      .update(deliveries)
      .set({ outcome: 'pending', updatedAt: new Date() })
      .where(eq(deliveries.id, cur.id));
    return { accepted: true, deliveryId: cur.id, previousOutcome: cur.outcome };
  });
}

/** Releases held work (held by a guard or waiting for authorization) back to pending, atomically. */
export async function releaseDeliveries(db: Db, integrationId: string, outcomes: string[]) {
  return db
    .update(deliveries)
    .set({ outcome: 'pending', updatedAt: new Date() })
    .where(and(eq(deliveries.integrationId, integrationId), inArray(deliveries.outcome, outcomes)))
    .returning({ id: deliveries.id, sourceId: deliveries.sourceId });
}
