/**
 * Onboarding for Stripe → QuickBooks (integration-specific discovery and activation steps; the state
 * machine, confirmation and managed transition are @mi/managed).
 *
 * Discovery reads only what the customer authorized:
 *  - Stripe Events API: recent managed events (30 days, ≤100, excluding the last 10 minutes);
 *  - QuickBooks: journal entries by DocNumber.
 * ledgerly's destination signature is written by its own exporter: DocNumber = the last 21 characters of the
 * Stripe event id, PrivateNote = its memo ("Stripe charge ch_… (customer …)"). Entries with that signature are
 * evidence of ledgerly running; entries whose DocNumber is the Stripe OBJECT id are evidence of another
 * integration (the only foreign scheme we can recognise from QuickBooks). Which QuickBooks accounts their
 * deployment posts to is read from those entries, so the customer is not asked to map accounts again.
 */
import { and, eq } from 'drizzle-orm';
import { deliveries, integrations, reconciliationItems, reconciliationRuns, type Db } from '@mi/database';
import type { CredentialCipher, ProviderEndpointConfig } from '@mi/integration-shopify-netsuite';
import {
  confidenceOf,
  discoveryOutcome,
  type ActivationStep,
  type Candidate,
  type Discovery,
  type OnboardingImplementation,
  type StepContext,
  type StepResult,
} from '@mi/managed';
import { describeError } from '@mi/observability';
import { loadLedgerly, type LedgerlyEntry, type QboAccountMap } from './artifact.ts';
import {
  LEDGERLY_CONTRACT,
  LEDGERLY_FLOW_TYPE,
  LedgerlyConfigSchema,
  MANAGED_EVENT_TYPES,
  registerLedgerlyReferenceData,
  webhookSecretAad,
} from './contract.ts';
import { STRIPE_QUICKBOOKS } from './descriptor.ts';
import { labelOf } from './ingest.ts';
import {
  accountsByName,
  docNumberOf,
  journalEntriesByDocNumber,
  QuickBooksAccess,
  STRIPE_API_VERSION,
  stripeFor,
  type QboEntryRecord,
} from './providers.ts';
import { LedgerlyReconciliationBusy, startLedgerlyReconciliation } from './reconcile.ts';

const DISCOVERY_DAYS = 30;
const GRACE_MS = 10 * 60_000;
const SAMPLE_LIMIT = 100;
/** Accounts every managed transaction type needs (charges, invoices, refunds, payouts). */
const CORE_CODES = ['1000', '1010', '4000', '4900', '6000'];

export interface LedgerlyOnboardingDeps {
  cipher: CredentialCipher;
  endpoints: ProviderEndpointConfig;
  webhookBaseUrl: string;
  enqueueReconciliation: (runId: string) => Promise<void>;
}

/** Infers ledgerly code → QuickBooks account from entries ledgerly wrote (pairs lines by side and amount). */
function inferAccounts(pairs: { entry: LedgerlyEntry; book: QboEntryRecord }[]): QboAccountMap {
  const map: QboAccountMap = {};
  for (const { entry, book } of pairs) {
    const used = new Set<number>();
    for (const l of entry.lines) {
      const i = book.Line.findIndex(
        (b, idx) =>
          !used.has(idx) &&
          b.JournalEntryLineDetail.PostingType.toLowerCase() === l.side &&
          Math.round(b.Amount * 100) === l.amount &&
          (b.Description ?? '') === (l.memo ?? ''),
      );
      if (i < 0) continue;
      used.add(i);
      const ref = book.Line[i]!.JournalEntryLineDetail.AccountRef;
      map[l.accountCode] ??= { qboId: ref.value, name: ref.name ?? ref.value };
    }
  }
  return map;
}

export async function discoverLedgerly(
  db: Db,
  deps: LedgerlyOnboardingDeps,
  tenantId: string,
  opts: { now?: Date } = {},
): Promise<Discovery> {
  const now = opts.now ?? new Date();
  const window = {
    from: new Date(now.getTime() - DISCOVERY_DAYS * 86_400_000),
    to: new Date(now.getTime() - GRACE_MS),
  };
  const base = {
    at: now.toISOString(),
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
  };
  const managed = await db
    .select()
    .from(integrations)
    .where(
      and(
        eq(integrations.tenantId, tenantId),
        eq(integrations.flowType, LEDGERLY_FLOW_TYPE),
        eq(integrations.lifecycle, 'active'),
      ),
    );
  if (managed.length) return { ...base, outcome: 'already_managed', sampled: 0, candidates: [] };

  const stripe = await stripeFor(db, deps.cipher, deps.endpoints, tenantId);
  const qbo = new QuickBooksAccess(db, deps.cipher, deps.endpoints, tenantId);
  const { modules: m } = await loadLedgerly();
  // 1. Stripe: recent managed events, and what ledgerly would book for each.
  const sample: { id: string; label: string; at: string; entries: LedgerlyEntry[]; objectId: string }[] = [];
  for await (const e of stripe.sdk.events.list({
    created: { gte: Math.floor(window.from.getTime() / 1000), lte: Math.floor(window.to.getTime() / 1000) },
    types: [...MANAGED_EVENT_TYPES],
    limit: 100,
  })) {
    if (sample.length >= SAMPLE_LIMIT) break;
    try {
      const r = m.mapEvent(await m.expandEvent(stripe.sdk, e));
      if (!r.entries.length || r.schedule) continue; // nothing to find in the books for it
      sample.push({
        id: e.id,
        label: labelOf(e as never),
        at: new Date(e.created * 1000).toISOString(),
        entries: [...r.entries],
        objectId: (e.data.object as { id: string }).id,
      });
    } catch {
      // events upstream refuses are not evidence either way
    }
  }
  const accountsFromNames = async () => {
    const found = await accountsByName(
      qbo,
      Object.values(m.ACCOUNTS).map((a) => a.name),
    );
    const map: QboAccountMap = {};
    for (const a of Object.values(m.ACCOUNTS)) {
      const hit = found.find((f) => f.Name === a.name);
      if (hit) map[a.code] = { qboId: hit.Id, name: hit.Name };
    }
    return map;
  };
  const newCandidate = async (): Promise<Candidate[]> => {
    const map = await accountsFromNames();
    const missing = CORE_CODES.filter((c) => !map[c]).map((c) => m.ACCOUNTS[c]!.name);
    if (missing.length) return [];
    return [
      {
        id: 'new.stripe_quickbooks',
        kind: 'new',
        title: 'Stripe payments → QuickBooks journal entries',
        summary:
          'We run a managed Stripe → QuickBooks integration for you, starting now, posting to the accounts with the standard names in your books.',
        implementation: 'ledgerly',
        confidence: null,
        evidence: { accountMap: map, accountMapSource: 'account_names' },
      },
    ];
  };
  if (!sample.length)
    return { ...base, outcome: 'insufficient_evidence', sampled: 0, candidates: await newCandidate() };

  // 2. QuickBooks: entries with ledgerly's signature, and entries keyed by the Stripe object id (another integration).
  const expectedDocs = sample.flatMap((s) => s.entries.map((e) => docNumberOf(e.sourceEventId)));
  const books = await journalEntriesByDocNumber(qbo, expectedDocs);
  const foreign = await journalEntriesByDocNumber(
    qbo,
    sample.map((s) => docNumberOf(s.objectId)),
  );
  const signature: typeof sample = [];
  const pairs: { entry: LedgerlyEntry; book: QboEntryRecord }[] = [];
  const other: typeof sample = [];
  for (const s of sample) {
    const hits = s.entries.map((e) =>
      books.find((b) => b.DocNumber === docNumberOf(e.sourceEventId) && b.PrivateNote === e.memo),
    );
    if (hits.every(Boolean)) {
      signature.push(s);
      s.entries.forEach((e, i) => pairs.push({ entry: e, book: hits[i]! }));
    } else if (foreign.some((f) => f.DocNumber === docNumberOf(s.objectId))) other.push(s);
  }
  const candidates: Candidate[] = [];
  if (signature.length) {
    const inferred = inferAccounts(pairs);
    const named = await accountsFromNames();
    const accountMap = { ...named, ...inferred }; // what their books show wins over names
    candidates.push({
      id: 'adopted.ledgerly',
      kind: 'adoptable',
      title: 'Stripe payments → QuickBooks journal entries',
      summary: `${signature.length} of your last ${sample.length} Stripe transactions are in QuickBooks, written the way the ledgerly integration writes them.`,
      implementation: 'ledgerly',
      confidence: confidenceOf(signature.length, sample.length),
      evidence: {
        signature: 'DocNumber = last 21 characters of the Stripe event id, memo "Stripe <object> <id> …"',
        matched: signature.length,
        sampled: sample.length,
        firstSeen: signature.map((x) => x.at).sort()[0],
        lastSeen: signature
          .map((x) => x.at)
          .sort()
          .pop(),
        examples: signature.slice(-3).map((x) => x.label),
        accountMap,
        accountMapSource: 'history',
        accountsFromHistory: Object.keys(inferred).sort(),
      },
    });
  }
  if (other.length)
    candidates.push({
      id: 'unrecognized:object-id-docnumber',
      kind: 'unsupported',
      title: 'Stripe payments → QuickBooks (another integration)',
      summary: `${other.length} of your last ${sample.length} Stripe transactions are in QuickBooks, written by an integration we do not recognise.`,
      implementation: null,
      confidence: null,
      evidence: {
        pattern: 'DocNumber = Stripe object id',
        matched: other.length,
        sampled: sample.length,
        examples: other.slice(-3).map((x) => x.label),
      },
    });
  const outcome = discoveryOutcome(candidates);
  return {
    ...base,
    outcome,
    sampled: sample.length,
    candidates: outcome === 'found' ? candidates : [...candidates, ...(await newCandidate())],
  };
}

/* ================================================================== activation */

async function startCheck(
  ctx: StepContext,
  window: { from: Date; to: Date },
  deps: LedgerlyOnboardingDeps,
): Promise<StepResult> {
  try {
    const s = await startLedgerlyReconciliation(ctx.db, {
      integrationId: ctx.integrationId,
      trigger: 'manual',
      requestedBy: 'system:onboarding',
      window,
    });
    await ctx.save({
      runId: s.runId,
      at: new Date().toISOString(),
      attempts: ((ctx.record?.['attempts'] as number) ?? 0) + 1,
    });
    await deps.enqueueReconciliation(s.runId);
    return { state: 'continue', detail: 'check started' };
  } catch (err) {
    if (err instanceof LedgerlyReconciliationBusy)
      return { state: 'wait', detail: 'another reconciliation is running' };
    throw err;
  }
}
async function awaitCheck(
  ctx: StepContext,
  name: string,
): Promise<StepResult | typeof reconciliationRuns.$inferSelect> {
  const [run] = await ctx.db
    .select()
    .from(reconciliationRuns)
    .where(eq(reconciliationRuns.id, String(ctx.record!['runId'])));
  if (!run || run.status === 'running') return { state: 'wait', detail: `${name} running` };
  if (run.outcome === 'partial') {
    if (((ctx.record!['attempts'] as number) ?? 1) >= 3)
      return {
        state: 'blocked',
        detail: `${name} incomplete`,
        problem:
          'We could not complete the first full check of your Stripe transactions. We are looking into it.',
      };
    await ctx.save({ attempts: ctx.record!['attempts'] });
    return { state: 'wait', detail: `${name} incomplete; retrying` };
  }
  return run;
}

export function ledgerlyActivationSteps(deps: LedgerlyOnboardingDeps): ActivationStep[] {
  return [
    {
      key: 'webhook',
      label: 'New Stripe transactions come to us',
      // Our own Stripe webhook endpoint, pinned to the API version the adopted code is written for.
      async run(ctx) {
        const [integ] = await ctx.db
          .select()
          .from(integrations)
          .where(eq(integrations.id, ctx.integrationId));
        const config = LedgerlyConfigSchema.parse(integ!.config);
        if (config.webhook)
          return {
            state: 'done',
            detail: 'webhook already registered',
            record: { endpointId: config.webhook.endpointId, existing: true },
          };
        const stripe = await stripeFor(ctx.db, deps.cipher, deps.endpoints, ctx.tenantId);
        const url = `${deps.webhookBaseUrl.replace(/\/$/, '')}/webhooks/stripe/${ctx.integrationId}`;
        try {
          const ep = await stripe.sdk.webhookEndpoints.create({
            url,
            enabled_events: [...MANAGED_EVENT_TYPES],
            api_version: STRIPE_API_VERSION as never,
            description: 'Managed Integrations (Stripe → QuickBooks)',
          });
          const webhook = {
            endpointId: ep.id,
            url,
            apiVersion: ep.api_version ?? STRIPE_API_VERSION,
            secretCiphertext: deps.cipher.encrypt(ep.secret!, webhookSecretAad(ctx.integrationId)),
          };
          await ctx.db
            .update(integrations)
            .set({ config: { ...config, webhook }, updatedAt: new Date() })
            .where(eq(integrations.id, ctx.integrationId));
          return {
            state: 'done',
            detail: 'webhook endpoint registered',
            record: { endpointId: ep.id, url, apiVersion: webhook.apiVersion, at: new Date().toISOString() },
          };
        } catch (err) {
          return {
            state: 'blocked',
            detail: 'webhook endpoint refused',
            problem: `Stripe did not accept our notification endpoint: ${describeError(err).message}`,
          };
        }
      },
    },
    {
      key: 'baseline',
      label: 'Every recent Stripe transaction checked against QuickBooks',
      async run(ctx) {
        if (!ctx.record?.['runId']) {
          const from = new Date(ctx.confirmation.coverFrom);
          return startCheck(
            ctx,
            { from, to: new Date(Math.max(from.getTime(), Date.now() - GRACE_MS)) },
            deps,
          );
        }
        const run = await awaitCheck(ctx, 'baseline');
        return 'state' in run
          ? run
          : { state: 'done', detail: 'baseline complete', record: { ...ctx.record } };
      },
    },
    {
      key: 'history',
      label: 'Earlier transactions recorded as history',
      // Entries their own deployment wrote (signature verified) become delivered history with provenance.
      async run(ctx) {
        const runId = String(ctx.records['baseline']!['runId']);
        const [integNow] = await ctx.db.select().from(integrations).where(eq(integrations.id, ctx.integrationId));
        const accountMapNow = LedgerlyConfigSchema.parse(integNow!.config).accountMap;
        const items = await ctx.db
          .select()
          .from(reconciliationItems)
          .where(
            and(
              eq(reconciliationItems.runId, runId),
              eq(reconciliationItems.classification, 'destination_exists_untracked'),
            ),
          );
        let adopted = 0;
        for (const it of items) {
          const inserted = await ctx.db
            .insert(deliveries)
            .values({
              integrationId: ctx.integrationId,
              idempotencyKey: `${ctx.integrationId}:${it.sourceOrderId}`,
              sourceId: it.sourceOrderId,
              sourceLegacyId: it.sourceLegacyId,
              sourceName: it.orderName,
              sourceCreatedAt: it.sourceCreatedAt,
              sourceUpdatedAt: it.sourceCreatedAt,
              latestSourceUpdatedAt: it.sourceCreatedAt,
              externalId: docNumberOf(it.sourceOrderId),
              destinationId: it.destinationIds?.[0] ?? null,
              outcome: 'delivered',
              attempts: 0,
              // Posted by their deployment with the mapping discovery read from their books.
              summary: { accounts: Object.fromEntries(Object.entries(accountMapNow).map(([k, v]) => [k, v.qboId])) },
              validation: {
                origin: 'baseline',
                note: 'Written by the customer’s existing deployment before we took over',
                runId,
              },
            })
            .onConflictDoNothing()
            .returning({ id: deliveries.id });
          adopted += inserted.length;
        }
        return {
          state: 'done',
          detail: `${adopted} earlier transaction(s) recorded as history`,
          record: { adopted, at: new Date().toISOString() },
        };
      },
    },
    {
      key: 'verify',
      label: 'Independent second check',
      async run(ctx) {
        if (!ctx.record?.['runId']) {
          const [run] = await ctx.db
            .select()
            .from(reconciliationRuns)
            .where(eq(reconciliationRuns.id, String(ctx.records['baseline']!['runId'])));
          return startCheck(ctx, { from: run!.windowFrom, to: run!.windowTo }, deps);
        }
        const run = await awaitCheck(ctx, 'verification check');
        return 'state' in run ? run : { state: 'done', detail: 'verified', record: { ...ctx.record } };
      },
    },
  ];
}

export function ledgerlyOnboarding(deps: LedgerlyOnboardingDeps): OnboardingImplementation {
  return {
    descriptor: STRIPE_QUICKBOOKS,
    discover: (db, tenantId, opts) => discoverLedgerly(db, deps, tenantId, opts),
    ensureContract: registerLedgerlyReferenceData,
    integrationValues: (c, coverFrom) => ({
      displayName: STRIPE_QUICKBOOKS.name,
      contractVersion: LEDGERLY_CONTRACT.version,
      config: {
        accountMap: (c.evidence['accountMap'] ?? {}) as QboAccountMap,
        accountMapSource:
          (c.evidence['accountMapSource'] as 'history' | 'account_names' | undefined) ?? 'account_names',
        coverFrom,
        reconcileGraceMinutes: 10,
      },
    }),
    steps: ledgerlyActivationSteps(deps),
    async baselineResult(db, records) {
      const [check] = await db
        .select()
        .from(reconciliationRuns)
        .where(eq(reconciliationRuns.id, String(records['verify']!['runId'])));
      return {
        checked: check!.expectedCount,
        accountedFor: check!.matchedCount,
        previouslyDelivered: (records['history']?.['adopted'] as number | undefined) ?? 0,
        missing: (check!.missing as unknown[]).length,
        unresolved: (check!.unresolved as unknown[]).length,
        outcome: check!.outcome,
        verifyRunId: check!.id,
      };
    },
  };
}
