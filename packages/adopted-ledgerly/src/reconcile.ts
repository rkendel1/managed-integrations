/**
 * Reconciliation, recovery and verification for Stripe → QuickBooks (integration-specific; stored in the
 * shared reconciliation_runs / reconciliation_items tables so accounting, monitoring and the customer product
 * read it unchanged).
 *
 * Source population: the Stripe Events API (managed event types, created in the window; Stripe keeps events
 * for 30 days). Expected outcome per event: the journal entries the RUNNING ledgerly artifact produces from
 * Stripe's current data. Destination: QuickBooks journal entries found by DocNumber. Verification is
 * independent of execution success: each entry must exist exactly once, balance, and have the same accounts,
 * sides and amounts as computed from Stripe's balance transactions.
 *
 * Column names in the shared tables predate this integration (source_order_id, order_name): here they hold the
 * Stripe event id and a label such as "Charge ch_…".
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { deliveries, integrations, reconciliationItems, reconciliationRuns, type Db } from '@mi/database';
import type { CredentialCipher, ProviderEndpointConfig } from '@mi/integration-shopify-netsuite';
import { describeError } from '@mi/observability';
import { runtimeFor } from './adaptation.ts';
import type { QboAccountMap, QboJournalEntryPayload } from './artifact.ts';
import { LedgerlyConfigSchema, MANAGED_EVENT_TYPES } from './contract.ts';
import { executeLedgerlyDelivery } from './execute.ts';
import { labelOf, recordEvent } from './ingest.ts';
import {
  docNumberOf,
  journalEntriesByDocNumber,
  QuickBooksAccess,
  stripeFor,
  type QboEntryRecord,
} from './providers.ts';

export class LedgerlyReconciliationBusy extends Error {}

export async function startLedgerlyReconciliation(
  db: Db,
  p: {
    integrationId: string;
    trigger: 'schedule' | 'manual' | 'incident';
    requestedBy?: string;
    window?: { from: Date; to: Date };
    incidentId?: string | null;
    /** Join a running run instead of refusing (customer/operator requests). */
    dedupe?: boolean;
  },
) {
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, p.integrationId));
  const config = LedgerlyConfigSchema.parse(integ!.config);
  const [running] = await db
    .select()
    .from(reconciliationRuns)
    .where(
      and(eq(reconciliationRuns.integrationId, p.integrationId), eq(reconciliationRuns.status, 'running')),
    );
  if (running) {
    if (p.trigger === 'schedule' || p.dedupe)
      return {
        runId: running.id,
        deduplicated: true,
        windowFrom: running.windowFrom.toISOString(),
        windowTo: running.windowTo.toISOString(),
      };
    throw new LedgerlyReconciliationBusy('Another reconciliation is running');
  }
  const to = p.window?.to ?? new Date(Date.now() - config.reconcileGraceMinutes * 60_000);
  const from =
    p.window?.from ?? new Date(Math.max(Date.parse(config.coverFrom), to.getTime() - 24 * 3600_000));
  const [run] = await db
    .insert(reconciliationRuns)
    .values({
      integrationId: p.integrationId,
      incidentId: p.incidentId ?? null,
      trigger: p.trigger,
      windowFrom: from,
      windowTo: new Date(Math.max(from.getTime(), to.getTime())),
      requestedBy: p.requestedBy ?? null,
    })
    .returning();
  return {
    runId: run!.id,
    deduplicated: false,
    windowFrom: run!.windowFrom.toISOString(),
    windowTo: run!.windowTo.toISOString(),
  };
}

type Classification =
  | 'delivered'
  | 'destination_exists_untracked'
  | 'missing_delivery'
  | 'pending_delivery'
  | 'failed_delivery'
  | 'inconsistent'
  | 'duplicate'
  | 'excluded'
  | 'undetermined';

const lineKey = (
  lines: { Amount: number; JournalEntryLineDetail: { PostingType: string; AccountRef: { value: string } } }[],
) =>
  JSON.stringify(
    lines
      .map((l) => [
        l.JournalEntryLineDetail.PostingType,
        l.JournalEntryLineDetail.AccountRef.value,
        Math.round(l.Amount * 100),
      ])
      .sort(),
  );
const balanced = (e: QboEntryRecord) => {
  const s = (t: string) =>
    Math.round(
      e.Line.filter((l) => l.JournalEntryLineDetail.PostingType === t).reduce((a, l) => a + l.Amount, 0) *
        100,
    );
  return s('Debit') === s('Credit');
};

/** Destination verification of one event: every expected entry exactly once, balanced, same lines. */
export function verifyEntries(expected: QboJournalEntryPayload[], books: QboEntryRecord[]) {
  let records = 0;
  const problems: string[] = [];
  for (const e of expected) {
    const found = books.filter((b) => b.DocNumber === e.DocNumber);
    records = Math.max(records, found.length);
    if (!found.length) problems.push(`${e.DocNumber}: not in QuickBooks`);
    else if (found.length > 1) problems.push(`${e.DocNumber}: ${found.length} entries`);
    else if (!balanced(found[0]!)) problems.push(`${e.DocNumber}: not balanced`);
    else if (lineKey(found[0]!.Line) !== lineKey(e.Line))
      problems.push(`${e.DocNumber}: accounts or amounts differ from Stripe`);
  }
  const ids = books.filter((b) => expected.some((e) => e.DocNumber === b.DocNumber)).map((b) => b.Id);
  return {
    verified: problems.length === 0 && expected.length > 0,
    records,
    ids,
    detail: problems.length
      ? problems.join('; ')
      : `${expected.length} journal entr${expected.length === 1 ? 'y' : 'ies'} in QuickBooks, balanced, accounts and amounts equal Stripe's balance transactions`,
  };
}

interface StripeEventLite {
  id: string;
  type: string;
  created: number;
  data: { object: { id?: string } };
}

export async function scanLedgerlyReconciliation(p: {
  db: Db;
  cipher: CredentialCipher;
  endpoints: ProviderEndpointConfig;
  runId: string;
  workerId: string;
}) {
  const { db } = p;
  const [run] = await db.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, p.runId));
  if (!run || run.status !== 'running') return { skipped: run?.status ?? 'unknown' };
  await db
    .update(reconciliationRuns)
    .set({ leaseOwner: p.workerId, leaseExpiresAt: new Date(Date.now() + 5 * 60_000) })
    .where(eq(reconciliationRuns.id, run.id));
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, run.integrationId));
  const config = LedgerlyConfigSchema.parse(integ!.config);
  try {
    const stripe = await stripeFor(db, p.cipher, p.endpoints, integ!.tenantId);
    const rt = await runtimeFor(db, integ!.id);
    const m = rt.artifact.modules;
    // 1. Source population: every managed Stripe event in the window.
    const events: StripeEventLite[] = [];
    for await (const e of stripe.sdk.events.list({
      created: {
        gte: Math.floor(run.windowFrom.getTime() / 1000),
        lte: Math.floor(run.windowTo.getTime() / 1000),
      },
      types: [...MANAGED_EVENT_TYPES],
      limit: 100,
    }))
      events.push(e as unknown as StripeEventLite);
    // 2. Expected entries per event, from Stripe's current data (running artifact).
    const expected = new Map<
      string,
      { payloads: QboJournalEntryPayload[]; excluded: string | null; error: string | null }
    >();
    for (const e of events) {
      try {
        const r = m.mapEvent(await m.expandEvent(stripe.sdk, e));
        if (r.schedule)
          expected.set(e.id, {
            payloads: [],
            excluded: 'deferred revenue schedule (out of scope)',
            error: null,
          });
        else if (!r.entries.length)
          expected.set(e.id, {
            payloads: [],
            excluded: 'no journal entry for this event (booked via its invoice, or zero amount)',
            error: null,
          });
        else
          expected.set(e.id, {
            payloads: r.entries.map((x) => m.toQbo(x, config.accountMap as QboAccountMap)),
            excluded: null,
            error: null,
          });
      } catch (err) {
        const msg = describeError(err).message;
        // A transaction the adopted code refuses (e.g. cross-currency payout) is outside scope, recorded with its reason.
        if (/cross-currency|Deferred|schedule/i.test(msg))
          expected.set(e.id, { payloads: [], excluded: `refused by the adopted code: ${msg}`, error: null });
        else expected.set(e.id, { payloads: [], excluded: null, error: msg });
      }
    }
    // 3. Destination: QuickBooks journal entries by DocNumber.
    const qbo = new QuickBooksAccess(db, p.cipher, p.endpoints, integ!.tenantId);
    const docs = [...expected.values()].flatMap((x) => x.payloads.map((q) => q.DocNumber!));
    const books = docs.length ? await journalEntriesByDocNumber(qbo, docs) : [];
    // 4. Local evidence.
    const dels = events.length
      ? await db
          .select()
          .from(deliveries)
          .where(
            and(
              eq(deliveries.integrationId, integ!.id),
              inArray(
                deliveries.sourceId,
                events.map((e) => e.id),
              ),
            ),
          )
      : [];
    const missing: string[] = [];
    const duplicates: string[] = [];
    const unresolved: string[] = [];
    const inconsistent: string[] = [];
    let matched = 0;
    for (const e of events) {
      const x = expected.get(e.id)!;
      const d = dels.find((y) => y.sourceId === e.id);
      let cls: Classification;
      let reason: string | null = null;
      let verification: ReturnType<typeof verifyEntries> | null = null;
      if (x.error) {
        cls = 'undetermined';
        reason = x.error;
      } else if (x.excluded) {
        cls = 'excluded';
        reason = x.excluded;
      } else {
        verification = verifyEntries(x.payloads, books);
        const present = books.filter((b) => x.payloads.some((q) => q.DocNumber === b.DocNumber));
        if (verification.records > 1) cls = 'duplicate';
        else if (verification.verified)
          cls = d?.outcome === 'delivered' ? 'delivered' : 'destination_exists_untracked';
        else if (present.length) cls = 'inconsistent';
        else if (!d) cls = 'missing_delivery';
        else if (['failed', 'rejected'].includes(d.outcome)) cls = 'failed_delivery';
        else cls = 'pending_delivery';
        reason = verification.verified ? null : verification.detail;
      }
      if (cls === 'delivered' || cls === 'destination_exists_untracked') matched++;
      if (cls === 'missing_delivery') missing.push(e.id);
      if (cls === 'duplicate') duplicates.push(e.id);
      if (cls === 'inconsistent') inconsistent.push(e.id);
      if (['pending_delivery', 'failed_delivery', 'inconsistent', 'undetermined', 'duplicate'].includes(cls))
        unresolved.push(e.id);
      await db
        .insert(reconciliationItems)
        .values({
          runId: run.id,
          tenantId: integ!.tenantId,
          integrationId: integ!.id,
          sourceOrderId: e.id,
          sourceLegacyId: e.data.object.id ?? '',
          orderName: labelOf(e),
          sourceCreatedAt: new Date(e.created * 1000),
          classification: cls === 'duplicate' || cls === 'inconsistent' ? 'ambiguous' : cls,
          reason,
          deliveryId: d?.id ?? null,
          destinationIds: verification?.ids ?? [],
          verification: verification
            ? { verified: verification.verified, records: verification.records, detail: verification.detail }
            : {},
        })
        .onConflictDoNothing();
    }
    const excluded = [...expected.values()].filter((x) => x.excluded).length;
    await db
      .update(reconciliationRuns)
      .set({
        status: 'completed',
        outcome: missing.length || duplicates.length || unresolved.length ? 'discrepancies' : 'consistent',
        expectedCount: events.length - excluded,
        sourceCount: events.length,
        destinationCount: books.length,
        matchedCount: matched,
        missing,
        duplicates,
        inconsistent,
        unresolved,
        evidence: {
          source: 'Stripe Events API',
          destination: 'QuickBooks JournalEntry by DocNumber',
          artifact: rt.artifact.id,
          excluded,
        },
        finishedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(eq(reconciliationRuns.id, run.id));
    return {
      runId: run.id,
      events: events.length,
      missing: missing.length,
      duplicates: duplicates.length,
      unresolved: unresolved.length,
    };
  } catch (err) {
    // The population could not be read completely: partial, never "consistent".
    await db
      .update(reconciliationRuns)
      .set({
        status: 'completed',
        outcome: 'partial',
        errorMessage: describeError(err).message.slice(0, 1000),
        finishedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(eq(reconciliationRuns.id, run.id));
    return { runId: run.id, partial: describeError(err).message };
  }
}

/**
 * Recovers one missing transaction: the event is reconstructed from the Stripe Events API (exactly what Stripe
 * would have sent), recorded as durable input, executed through the same adopted executor, then verified.
 * Concurrent or repeated requests are idempotent (item state lock; one delivery per event; DocNumber guard).
 */
export async function recoverLedgerlyItem(p: {
  db: Db;
  cipher: CredentialCipher;
  endpoints: ProviderEndpointConfig;
  itemId: string;
  requestedBy: string;
}) {
  const { db } = p;
  const claimed = await db.transaction(async (tx) => {
    const [it] = await tx
      .select()
      .from(reconciliationItems)
      .where(eq(reconciliationItems.id, p.itemId))
      .for('update');
    if (
      !it ||
      it.classification !== 'missing_delivery' ||
      !['none', 'requested', 'failed'].includes(it.recoveryState)
    )
      return null;
    await tx
      .update(reconciliationItems)
      .set({
        recoveryState: 'executing',
        recoveryRequestedBy: p.requestedBy,
        recoveryRequestedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(reconciliationItems.id, it.id));
    return it;
  });
  if (!claimed) return { done: false, reason: 'not recoverable or already being recovered' };
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, claimed.integrationId));
  try {
    const stripe = await stripeFor(db, p.cipher, p.endpoints, integ!.tenantId);
    const ev = await stripe.sdk.events.retrieve(claimed.sourceOrderId);
    const rec = await recordEvent(
      db,
      p.cipher,
      integ!,
      ev as never,
      Buffer.from(JSON.stringify(ev)),
      'reconciliation',
    );
    const [d] = await db
      .select()
      .from(deliveries)
      .where(eq(deliveries.idempotencyKey, `${integ!.id}:${ev.id}`));
    if (d && d.outcome === 'pending')
      await executeLedgerlyDelivery({
        db,
        cipher: p.cipher,
        endpoints: p.endpoints,
        deliveryId: d.id,
        trigger: { kind: 'reconciliation_recovery', reason: `item ${claimed.id}` },
      });
    const rt = await runtimeFor(db, integ!.id);
    const config = LedgerlyConfigSchema.parse(integ!.config);
    const r = rt.artifact.modules.mapEvent(await rt.artifact.modules.expandEvent(stripe.sdk, ev));
    const expected = r.entries.map((x) => rt.artifact.modules.toQbo(x, config.accountMap as QboAccountMap));
    const books = await journalEntriesByDocNumber(
      new QuickBooksAccess(db, p.cipher, p.endpoints, integ!.tenantId),
      expected.map((e) => e.DocNumber!),
    );
    const v = verifyEntries(expected, books);
    await db
      .update(reconciliationItems)
      .set({
        recoveryState: v.verified ? 'recovered' : 'unverified',
        deliveryId: d?.id ?? rec.deliveryId ?? null,
        verifiedDestinationId: v.ids[0] ?? null,
        verifiedAt: v.verified ? new Date() : null,
        verification: { verified: v.verified, records: v.records, detail: v.detail },
        updatedAt: new Date(),
      })
      .where(eq(reconciliationItems.id, claimed.id));
    await db
      .update(reconciliationRuns)
      .set({ recoveryEnqueued: sql`${reconciliationRuns.recoveryEnqueued} + 1` })
      .where(eq(reconciliationRuns.id, claimed.runId));
    return { done: true, verified: v.verified, detail: v.detail };
  } catch (err) {
    await db
      .update(reconciliationItems)
      .set({
        recoveryState: 'failed',
        recoveryReason: describeError(err).message.slice(0, 500),
        updatedAt: new Date(),
      })
      .where(eq(reconciliationItems.id, claimed.id));
    return { done: false, retryLater: true, reason: describeError(err).message };
  }
}

export { docNumberOf };

/** Durable recovery intent for missing Stripe transactions (the recovery job reconstructs and executes them). */
export async function requestLedgerlyRecovery(
  db: Db,
  p: { runId: string; sourceIds: string[]; principalId: string; requestId: string; reason: string },
) {
  const out: (
    | { sourceId: string; accepted: true; itemId: string; deliveryId: string | null; mode: 'new' | 'retry' }
    | { sourceId: string; accepted: false; reason: string }
  )[] = [];
  for (const sourceId of p.sourceIds) {
    out.push(
      await db.transaction(async (tx) => {
        const [item] = await tx
          .select()
          .from(reconciliationItems)
          .where(and(eq(reconciliationItems.runId, p.runId), eq(reconciliationItems.sourceOrderId, sourceId)))
          .for('update');
        if (!item)
          return { sourceId, accepted: false as const, reason: 'Not part of this reconciliation run' };
        if (item.classification !== 'missing_delivery')
          return {
            sourceId,
            accepted: false as const,
            reason: `Classified ${item.classification}; only missing transactions are recovered`,
          };
        if (!['none', 'failed'].includes(item.recoveryState))
          return { sourceId, accepted: false as const, reason: `Recovery already ${item.recoveryState}` };
        await tx
          .update(reconciliationItems)
          .set({
            recoveryState: 'requested',
            recoveryRequestedBy: p.principalId,
            recoveryRequestId: p.requestId,
            recoveryReason: p.reason,
            recoveryRequestedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(reconciliationItems.id, item.id));
        return {
          sourceId,
          accepted: true as const,
          itemId: item.id,
          deliveryId: item.deliveryId,
          mode: item.recoveryState === 'failed' ? ('retry' as const) : ('new' as const),
        };
      }),
    );
  }
  return out;
}
