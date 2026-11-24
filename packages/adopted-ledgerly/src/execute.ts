/**
 * Executes one Stripe event through the ADOPTED ledgerly code (integration-specific).
 *
 *   claim (generic) → load the durable input → expand nested Stripe objects (upstream expandEvent, Stripe
 *   pinned to 2024-06-20) → map to balanced journal entries (upstream mapEvent) → look for entries already
 *   in QuickBooks (DocNumber) → post the rest (upstream toQbo + qboDispatcher, requestid-idempotent) → read
 *   back → record the attempt with the artifact and corrections that ran.
 *
 * Outcomes: delivered · excluded (upstream books nothing for it, e.g. a charge booked via its invoice) ·
 * rejected (upstream refuses it: e.g. a cross-currency payout, an annual plan's deferred schedule) ·
 * failed (transient; retried) · held (a provider contract violation: maintenance takes over) ·
 * awaiting_authorization (QuickBooks or Stripe access lost: the customer must reconnect; nothing lost).
 */
import { eq } from 'drizzle-orm';
import {
  deliveries,
  deliveryAttempts,
  integrations,
  observations,
  webhookReceipts,
  type Db,
} from '@mi/database';
import type { CredentialCipher, ProviderEndpointConfig } from '@mi/integration-shopify-netsuite';
import { claimDelivery, type ExecutionTrigger } from '@mi/managed';
import { describeError, redact } from '@mi/observability';
import { runtimeFor } from './adaptation.ts';
import type { LedgerlyEntry, QboAccountMap } from './artifact.ts';
import { LedgerlyConfigSchema } from './contract.ts';
import {
  AuthorizationLost,
  docNumberOf,
  journalEntriesByDocNumber,
  QuickBooksAccess,
  stripeFor,
} from './providers.ts';

export type LedgerlyOutcome =
  'delivered' | 'excluded' | 'rejected' | 'failed' | 'held' | 'awaiting_authorization';
export type LedgerlyExecuteResult =
  | { executed: false; reason: string }
  | {
      executed: true;
      outcome: LedgerlyOutcome;
      attemptNo: number;
      message: string | null;
      entries: number;
      journalEntryIds: string[];
      lost?: 'stripe' | 'quickbooks';
      missingField?: string;
    };

const silent = { info() {}, warn() {}, error() {}, debug() {} };

/** Every DocNumber the mapped entries will carry (upstream toQbo: last 21 characters of the event id). */
export const docNumbersOf = (entries: LedgerlyEntry[]) => entries.map((e) => docNumberOf(e.sourceEventId));

export async function payloadOfReceipt(db: Db, cipher: CredentialCipher, receiptId: string) {
  const [r] = await db.select().from(webhookReceipts).where(eq(webhookReceipts.id, receiptId));
  if (!r) throw new Error('Webhook receipt missing for delivery');
  return {
    receipt: r,
    event: JSON.parse(
      Buffer.from(cipher.decrypt<string>(r.payloadCiphertext, `receipt:${r.id}`), 'base64').toString('utf8'),
    ) as { id: string; type: string; created: number; data: { object: Record<string, unknown> } },
  };
}

export async function executeLedgerlyDelivery(p: {
  db: Db;
  cipher: CredentialCipher;
  endpoints: ProviderEndpointConfig;
  deliveryId: string;
  trigger: ExecutionTrigger;
}): Promise<LedgerlyExecuteResult> {
  const { db } = p;
  const claimed = await claimDelivery(db, p.deliveryId);
  if (!claimed) return { executed: false, reason: 'not_claimable' };
  const attemptNo = claimed.attempts;
  const startedAt = new Date();
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, claimed.integrationId));
  const config = LedgerlyConfigSchema.parse(integ!.config);
  const runtime = await runtimeFor(db, integ!.id);
  const m = runtime.artifact.modules;

  let outcome: LedgerlyOutcome;
  let message: string | null = null;
  let errorClass: string | null = null;
  let entries: LedgerlyEntry[] = [];
  let posted: string[] = [];
  let found: string[] = [];
  let lost: 'stripe' | 'quickbooks' | undefined;
  let missingField: string | undefined;
  try {
    const { event } = await payloadOfReceipt(db, p.cipher, claimed.receiptId!);
    const stripe = await stripeFor(db, p.cipher, p.endpoints, integ!.tenantId);
    // ---- upstream: expand, then map ----
    const expanded = await m.expandEvent(stripe.sdk, event);
    let result;
    try {
      result = m.mapEvent(expanded);
    } catch (err) {
      if (err instanceof m.MissingExpansionError) {
        missingField = err.field;
        throw Object.assign(err, { mi: 'input_contract' });
      }
      throw Object.assign(new Error(describeError(err).message), { mi: 'refused_by_upstream' });
    }
    if (result.schedule)
      throw Object.assign(
        new Error(
          'Deferred revenue schedule (annual plan): this integration does not post recognition schedules',
        ),
        {
          mi: 'refused_by_upstream',
        },
      );
    entries = [...result.entries];
    if (!entries.length) {
      outcome = 'excluded';
      message =
        'Upstream books no journal entry for this event (e.g. a charge booked through its invoice, or a zero amount)';
    } else {
      // ---- idempotency guard: entries already in QuickBooks are recorded, never duplicated ----
      const qbo = new QuickBooksAccess(db, p.cipher, p.endpoints, integ!.tenantId);
      const existing = await journalEntriesByDocNumber(qbo, docNumbersOf(entries));
      found = existing.map((e) => e.Id);
      const toPost = entries.filter(
        (e) => !existing.some((x) => x.DocNumber === docNumberOf(e.sourceEventId)),
      );
      if (toPost.length) {
        const { creds, apiBase } = await qbo.current();
        const dispatch = m.qboDispatcher({
          accessToken: creds.accessToken,
          realmId: creds.realmId,
          accountMap: config.accountMap as QboAccountMap,
          apiBase,
          fetch: ((url: string, init: RequestInit) => qbo.fetch(url, init)) as typeof fetch,
          log: silent,
        });
        for (const [i, entry] of toPost.entries())
          await dispatch({ id: `${claimed.id}:${i}`, entry, subscriptionId: null });
        const after = await journalEntriesByDocNumber(qbo, docNumbersOf(toPost));
        posted = after.map((e) => e.Id);
      }
      outcome = 'delivered';
    }
  } catch (err) {
    const tag = (err as { mi?: string }).mi;
    message = describeError(err).message;
    if (err instanceof AuthorizationLost) {
      outcome = 'awaiting_authorization';
      errorClass = 'authentication';
      lost = err.provider;
    } else if (tag === 'input_contract') {
      outcome = 'held';
      errorClass = 'input_contract';
    } else if (tag === 'refused_by_upstream' || /QBO API returned 400/.test(message)) {
      outcome = 'rejected';
      errorClass = 'invalid_data';
    } else if (
      (err as { statusCode?: number }).statusCode === 401 &&
      String((err as { type?: string }).type ?? '').startsWith('Stripe')
    ) {
      // Stripe refused the key (revoked or expired restricted key).
      outcome = 'awaiting_authorization';
      errorClass = 'authentication';
      lost = 'stripe';
    } else {
      outcome = 'failed';
      errorClass = 'transient';
    }
  }
  const finishedAt = new Date();
  const destination = [...found, ...posted];
  const debit = entries
    .flatMap((e) => e.lines)
    .filter((l) => l.side === 'debit')
    .reduce((a, l) => a + l.amount, 0);
  await db.transaction(async (tx) => {
    await tx
      .update(deliveries)
      .set({
        outcome,
        lastErrorClass: errorClass,
        lastError: message ? String(redact(message)).slice(0, 1000) : null,
        destinationId: destination[0] ?? null,
        summary: {
          entries: entries.length,
          debitMinor: debit,
          currency: entries[0]?.currency ?? null,
          docNumbers: docNumbersOf(entries),
        },
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
      destinationId: destination[0] ?? null,
      implementationVersionId: runtime.artifact.id,
      evidence: {
        trigger: p.trigger,
        artifact: {
          id: runtime.artifact.id,
          patches: runtime.artifact.patches,
          adaptations: runtime.adaptationIds,
        },
        entries: entries.length,
        journalEntries: { alreadyPresent: found, posted },
        ...(missingField ? { missingField } : {}),
      },
      startedAt,
      finishedAt,
    });
    if (outcome === 'failed' || outcome === 'rejected' || outcome === 'awaiting_authorization')
      await tx.insert(observations).values({
        tenantId: integ!.tenantId,
        integrationId: integ!.id,
        provider: lost ?? (errorClass === 'transient' ? 'quickbooks' : 'adopted'),
        kind: 'error',
        errorClass,
        code: outcome.toUpperCase(),
        message: `${claimed.sourceName}: ${String(redact(message ?? outcome))}`.slice(0, 2000),
        data: { deliveryId: claimed.id, attemptNo },
        implementationVersionId: runtime.artifact.id,
      });
    if (outcome === 'delivered')
      await tx
        .update(integrations)
        .set({ lastSuccessfulSyncAt: finishedAt, updatedAt: finishedAt })
        .where(eq(integrations.id, integ!.id));
  });
  return {
    executed: true,
    outcome,
    attemptNo,
    message,
    entries: entries.length,
    journalEntryIds: destination,
    ...(lost ? { lost } : {}),
    ...(missingField ? { missingField } : {}),
  };
}
