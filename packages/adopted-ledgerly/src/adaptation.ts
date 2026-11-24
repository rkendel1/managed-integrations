/**
 * Corrections for Stripe → QuickBooks (integration-specific parts; the lifecycle is @mi/managed).
 *
 * Supported here: reviewed PATCHES to ledgerly (patches/*.json), operator-activated. There are no adapters for
 * this integration yet: no provider change has required one (the Stripe 2025-03-31 invoice change is already
 * handled by upstream, which retrieves invoices at its pinned API version).
 *
 * Validation of a patch (separate from activation):
 *  1. applies to the adopted artifact (commit, base hash of the pinned file);
 *  2. original adopted code unchanged; 3. patch reproduces the reviewed change exactly;
 *  4. regression: stored Stripe events map to identical journal entries and QuickBooks payloads;
 *  5. destination request: only the reviewed difference (e.g. the minorversion parameter) changes —
 *     captured by running upstream's dispatcher against a recording fetch (nothing is sent);
 *  6. business data preserved (QuickBooks): entries already in the books equal what the patched artifact
 *     produces for their Stripe events;
 *  7. rollback target available.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { deliveries, integrations, type Db } from '@mi/database';
import type { CredentialCipher, ProviderEndpointConfig } from '@mi/integration-shopify-netsuite';
import {
  activateAdaptation as activateGeneric,
  activeAdaptations,
  adaptationsOf,
  AdaptationError,
  CheckList,
  pinnedDrift,
  recordAdaptation,
  recordValidation,
  rejectAdaptation as rejectGeneric,
  rollbackAdaptation as rollbackGeneric,
  startValidation,
  type AdaptationRow,
  type RunningCode,
  type RuntimeHooks,
} from '@mi/managed';
import { describeError } from '@mi/observability';
import {
  loadLedgerly,
  patchCatalog,
  pinnedSource,
  upstreamDir,
  type LedgerlyArtifact,
  type LedgerlyPatch,
  type QboAccountMap,
} from './artifact.ts';
import { LedgerlyConfigSchema } from './contract.ts';
import { payloadOfReceipt } from './execute.ts';
import { journalEntriesByDocNumber, QuickBooksAccess, stripeFor } from './providers.ts';
import { LEDGERLY } from './provenance.ts';

export const BASE_ARTIFACT = {
  repository: LEDGERLY.repository,
  commit: LEDGERLY.commit,
  package: LEDGERLY.packageName,
};

function patchOf(row: AdaptationRow): LedgerlyPatch {
  const id = (row.spec as { patchId: string }).patchId;
  const p = patchCatalog().find((x) => x.id === id);
  if (!p) throw new Error(`Patch ${id} (adaptation ${row.id}) is not in the reviewed catalog`);
  return p;
}

export interface LedgerlyRuntime {
  artifact: LedgerlyArtifact;
  adaptationIds: string[];
}
export async function selectRuntime(rows: AdaptationRow[]): Promise<LedgerlyRuntime> {
  if (rows.some((r) => r.kind !== 'patch'))
    throw new Error('Only reviewed patches can change this integration');
  return { artifact: await loadLedgerly(rows.map(patchOf)), adaptationIds: rows.map((r) => r.id) };
}
export async function runtimeFor(db: Db, integrationId: string) {
  return selectRuntime(await activeAdaptations(db, integrationId));
}

export const RUNTIME_HOOKS: RuntimeHooks = {
  scopeKey: (r) => `p:${patchOf(r).file}`,
  loadRuntime: (rows) => selectRuntime(rows),
};

export async function proposePatch(
  db: Db,
  p: {
    integrationId: string;
    patchId: string;
    actor: string;
    reason: string;
    maintenanceEventId?: string | null;
  },
) {
  const patch = patchCatalog().find((x) => x.id === p.patchId);
  if (!patch) throw new AdaptationError('INVALID', 'Only reviewed patches from the catalog can be proposed');
  return recordAdaptation(db, {
    integrationId: p.integrationId,
    maintenanceEventId: p.maintenanceEventId ?? null,
    kind: 'patch',
    artifact: BASE_ARTIFACT,
    dependency: patch.addresses,
    codePath: { file: patch.file, originalBehavior: patch.originalBehavior },
    spec: {
      patchId: patch.id,
      file: patch.file,
      baseSha256: patch.baseSha256,
      resultSha256: patch.resultSha256,
      find: patch.find,
      replace: patch.replace,
    },
    rationale: `${patch.reason} — proposed by ${p.actor.startsWith('system') ? 'maintenance' : 'operator'}: ${p.reason}`,
    evidence: {
      providerEvidence: patch.providerEvidence,
      assumptions: patch.assumptions,
      rollback: patch.rollback,
    },
    actor: p.actor,
  });
}

/** Stored, delivered Stripe events (newest first), the regression corpus. */
async function storedEvents(db: Db, cipher: CredentialCipher, integrationId: string, limit = 25) {
  const rows = await db
    .select({ receiptId: deliveries.receiptId, sourceId: deliveries.sourceId })
    .from(deliveries)
    .where(and(eq(deliveries.integrationId, integrationId), eq(deliveries.outcome, 'delivered')))
    .orderBy(desc(deliveries.deliveredAt))
    .limit(limit);
  const out = [];
  for (const r of rows)
    if (r.receiptId) out.push({ sourceId: r.sourceId, ...(await payloadOfReceipt(db, cipher, r.receiptId)) });
  return out;
}

/** Runs upstream's dispatcher against a recording fetch: the exact request it would send (nothing is sent). */
async function recordedRequest(
  rt: LedgerlyRuntime,
  entry: Parameters<LedgerlyArtifact['modules']['toQbo']>[0],
  accountMap: QboAccountMap,
) {
  let captured: { url: URL; method: string; body: string } | null = null;
  const fake = (async (url: string, init: RequestInit) => {
    captured = { url: new URL(url), method: init.method ?? 'GET', body: String(init.body) };
    return new Response(JSON.stringify({ JournalEntry: { Id: 'recorded' } }), { status: 200 });
  }) as typeof fetch;
  await rt.artifact.modules.qboDispatcher({
    accessToken: 'x',
    realmId: 'r',
    accountMap,
    apiBase: 'http://recorded.invalid',
    fetch: fake,
    log: { info() {}, warn() {}, error() {} },
  })({
    id: 'v',
    entry,
    subscriptionId: null,
  });
  return captured!;
}

export async function validateLedgerlyAdaptation(
  db: Db,
  cipher: CredentialCipher,
  endpoints: ProviderEndpointConfig,
  adaptationId: string,
): Promise<AdaptationRow> {
  const row0 = await startValidation(db, adaptationId);
  const list = new CheckList();
  const add = (n: string, ok: boolean | null, d: string) => list.add(n, ok, d);
  let artifactIds = { before: '', after: '' };
  try {
    if (row0.kind !== 'patch') throw new Error('Only reviewed patches are supported for this integration');
    const p = patchOf(row0);
    const [integ] = await db.select().from(integrations).where(eq(integrations.id, row0.integrationId));
    const config = LedgerlyConfigSchema.parse(integ!.config);
    const accountMap = config.accountMap as QboAccountMap;
    const current = (await activeAdaptations(db, row0.integrationId)).filter((r) => r.id !== row0.id);
    const before = await selectRuntime(current);
    const after = await selectRuntime([...current, row0]);
    artifactIds = { before: before.artifact.id, after: after.artifact.id };

    // 1–3. the artifact
    add(
      'applies to the adopted artifact',
      p.artifact.commit === LEDGERLY.commit && p.baseSha256 === LEDGERLY.fileSha256[p.file],
      `${p.file} at ${p.artifact.commit.slice(0, 12)}; base sha256 ${p.baseSha256.slice(0, 12)}`,
    );
    const drift = pinnedDrift(pinnedSource());
    add(
      'original adopted code unchanged',
      drift.length === 0,
      drift.length
        ? `changed: ${drift.map((d) => d.file).join(', ')}`
        : `${Object.keys(LEDGERLY.fileSha256).length} files match ${LEDGERLY.commit.slice(0, 12)}`,
    );
    const others = Object.entries(after.artifact.files).filter(
      ([f, h]) => f !== p.file && h !== LEDGERLY.fileSha256[f],
    );
    add(
      'patch reproduces the reviewed change exactly',
      after.artifact.files[p.file] === p.resultSha256 && others.length === 0,
      `${p.file} sha256 ${after.artifact.files[p.file]?.slice(0, 12)} (reviewed ${p.resultSha256.slice(0, 12)}); other files unchanged: ${others.length === 0}`,
    );

    // 4–6. behaviour, on stored Stripe events
    const stripe = await stripeFor(db, cipher, endpoints, integ!.tenantId);
    const corpus = await storedEvents(db, cipher, row0.integrationId);
    let same = 0;
    let onlyReviewedDiff = 0;
    let requestsCompared = 0;
    const differ: string[] = [];
    const expectedBooks = new Map<string, ReturnType<LedgerlyArtifact['modules']['toQbo']>>();
    for (const c of corpus) {
      const expanded = await before.artifact.modules.expandEvent(stripe.sdk, c.event);
      const x = before.artifact.modules.mapEvent(expanded);
      const y = after.artifact.modules.mapEvent(
        await after.artifact.modules.expandEvent(stripe.sdk, c.event),
      );
      const qx = x.entries.map((e) => before.artifact.modules.toQbo(e, accountMap));
      const qy = y.entries.map((e) => after.artifact.modules.toQbo(e, accountMap));
      if (JSON.stringify(qx) === JSON.stringify(qy)) same++;
      else differ.push(c.sourceId);
      for (const q of qy) if (q.DocNumber) expectedBooks.set(q.DocNumber, q);
      for (const e of y.entries) {
        const [ra, rb] = [
          await recordedRequest(before, e, accountMap),
          await recordedRequest(after, e, accountMap),
        ];
        requestsCompared++;
        const strip = (u: URL) => {
          const v = new URL(u);
          v.searchParams.delete('minorversion');
          return v.toString();
        };
        if (ra.method === rb.method && ra.body === rb.body && strip(ra.url) === strip(rb.url))
          onlyReviewedDiff++;
      }
    }
    add(
      'regression: stored transactions unchanged',
      corpus.length ? differ.length === 0 : null,
      corpus.length
        ? `${same}/${corpus.length} stored Stripe events map to identical QuickBooks entries${differ.length ? `; differ: ${differ.join(', ')}` : ''}`
        : 'no stored transactions to replay',
    );
    add(
      'destination request changes only as reviewed',
      requestsCompared ? onlyReviewedDiff === requestsCompared : null,
      requestsCompared
        ? `${onlyReviewedDiff}/${requestsCompared} QuickBooks requests identical apart from the minorversion parameter`
        : 'no requests to compare',
    );
    const qbo = new QuickBooksAccess(db, cipher, endpoints, integ!.tenantId);
    const books = await journalEntriesByDocNumber(qbo, [...expectedBooks.keys()]);
    const lines = (q: {
      Line: {
        Amount: number;
        JournalEntryLineDetail: { PostingType: string; AccountRef: { value: string } };
      }[];
    }) =>
      JSON.stringify(
        q.Line.map((l) => [
          l.JournalEntryLineDetail.PostingType,
          l.JournalEntryLineDetail.AccountRef.value,
          l.Amount,
        ]).sort(),
      );
    const matching = books.filter((b) => {
      const e = expectedBooks.get(b.DocNumber ?? '');
      return e && lines(e) === lines(b) && e.TxnDate === b.TxnDate;
    }).length;
    add(
      'business data preserved (QuickBooks)',
      expectedBooks.size ? matching === expectedBooks.size && books.length === expectedBooks.size : null,
      expectedBooks.size
        ? `${matching}/${expectedBooks.size} entries in QuickBooks equal what the patched code produces for their Stripe events`
        : 'no entries to compare',
    );
    // 7. rollback target
    add('rollback target available', true, `rolling back selects ${before.artifact.id}`);
  } catch (err) {
    add('validation ran', false, describeError(err).message);
  }
  return recordValidation(db, adaptationId, list.checks, artifactIds);
}

export const activateLedgerlyAdaptation = (
  db: Db,
  id: string,
  actor: string,
  note: string,
  opts?: { acceptLimitations?: boolean },
) => activateGeneric(db, id, actor, note, RUNTIME_HOOKS, opts);
export const rollbackLedgerlyAdaptation = (db: Db, id: string, actor: string, reason: string) =>
  rollbackGeneric(db, id, actor, reason, RUNTIME_HOOKS);
export const rejectLedgerlyAdaptation = (db: Db, id: string, actor: string, reason: string) =>
  rejectGeneric(db, id, actor, reason);

/* ================================================================== dependency contract */

export interface DependencyRead {
  path: string;
  label: string;
  expected: string;
  effect: string;
  file: string;
  pattern: RegExp;
}

/** What the adopted code depends on, and where it reads it (located in the running artifact's files). */
export const DEPENDENCIES: DependencyRead[] = [
  {
    path: 'quickbooks.minorversion',
    label: 'QuickBooks API minor version',
    expected: '≥ 75 (Intuit serves 75 since 2025-08-01)',
    effect: 'every JournalEntry create request',
    file: 'src/server/dispatchers/qbo.ts',
    pattern: /const QBO_MINOR_VERSION = '(\d+)';/,
  },
  {
    path: 'stripe.version.invoices',
    label: 'Stripe API version for invoices',
    expected: '2024-06-20 (invoice.charge present)',
    effect: 'invoice.payment_succeeded mapping',
    file: 'src/server/expand.ts',
    pattern: /const INVOICE_API_VERSION = '([^']+)';/,
  },
  {
    path: 'charge.balance_transaction',
    label: 'charge balance transaction (expanded)',
    expected: 'expanded object',
    effect: 'gross, fee and net of charge entries',
    file: 'src/events/charges/chargeSucceeded.ts',
    pattern: /'charge\.balance_transaction'/,
  },
  {
    path: 'invoice.charge',
    label: 'invoice charge (expanded)',
    expected: 'expanded object (or null for credit-balance payments)',
    effect: 'invoice payment entries',
    file: 'src/events/invoices/invoicePaymentSucceeded.ts',
    pattern: /'invoice\.charge'/,
  },
  {
    path: 'refund.balance_transaction',
    label: 'refund balance transaction (expanded)',
    expected: 'expanded object',
    effect: 'refund entries',
    file: 'src/events/charges/chargeRefunded.ts',
    pattern: /refund\.balance_transaction,/,
  },
  {
    path: 'payout.amount',
    label: 'payout amount and arrival date',
    expected: 'integer (minor units)',
    effect: 'bank transfer entries',
    file: 'src/events/payouts/payoutPaid.ts',
    pattern: /cents\(payout\.amount\)/,
  },
];

export function locate(dir: string, d: DependencyRead) {
  const text = readFileSync(join(dir, d.file), 'utf8').split('\n');
  return text.flatMap((code, i) =>
    d.pattern.test(code)
      ? [{ file: d.file, line: i + 1, code: code.trim(), match: d.pattern.exec(code)?.[1] ?? null }]
      : [],
  );
}

/** The QuickBooks minor version the running artifact requests (null if not found). */
export function requestedMinorVersion(rt: LedgerlyRuntime): number | null {
  const dep = DEPENDENCIES[0]!;
  let text = readFileSync(join(upstreamDir(), dep.file), 'utf8');
  for (const a of rt.artifact.patches.filter((x) => x.file === dep.file)) {
    const p = patchCatalog().find((x) => x.id === a.id);
    if (p) text = text.replace(p.find, p.replace);
  }
  const m = dep.pattern.exec(text);
  return m ? Number(m[1]) : null;
}

export async function ledgerlyRunningCode(db: Db, integrationId: string): Promise<RunningCode> {
  const rows = await adaptationsOf(db, integrationId);
  let running: RunningCode['running'] = null;
  let problem: string | null = null;
  try {
    const rt = await selectRuntime(rows.filter((r) => r.status === 'active'));
    running = { id: rt.artifact.id, patches: rt.artifact.patches, files: rt.artifact.files };
  } catch (err) {
    problem = describeError(err).message;
  }
  const dir = upstreamDir();
  const drift = new Map(pinnedDrift(pinnedSource()).map((d) => [d.file, d.actual]));
  return {
    adopted: {
      repository: LEDGERLY.repository,
      commit: LEDGERLY.commit,
      license: LEDGERLY.license,
      package: LEDGERLY.packageName,
    },
    pinnedFiles: Object.entries(LEDGERLY.fileSha256).map(([file, expected]) => ({
      file,
      expected,
      actual: drift.get(file) ?? expected,
      matches: !drift.has(file),
    })),
    running,
    problem,
    contracts: DEPENDENCIES.map((d) => ({
      path: d.path,
      label: d.label,
      expected: d.expected,
      effect: d.effect,
      reads: locate(dir, d).map((r) => ({
        file: r.file,
        line: r.line,
        code: r.code,
        matchesPinnedCommit: !drift.has(r.file),
      })),
    })),
    adaptations: rows,
    catalog: patchCatalog().map((p) => ({ id: p.id, title: p.title, file: p.file })),
  };
}
