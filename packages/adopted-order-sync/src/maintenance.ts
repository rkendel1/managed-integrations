/**
 * Maintenance lifecycle for the ADOPTED flow (slice 4): one real scenario, end to end.
 *
 * A provider input stops satisfying what the adopted code reads (detected by the input-contract guard in
 * execute.ts, which holds the order instead of writing it). This module takes responsibility from there:
 *
 *   investigate → derive a correction → validate it (separately) → activate it at the adoption boundary →
 *   release held orders through the normal execution path → reconcile the affected window and recover
 *   missing orders through the slice-3 recovery path → verify independently (second reconciliation run and
 *   line-level NetSuite checks against Shopify) → account for every transaction → resolve only if the
 *   persisted evidence allows it (enforced again in transitionIncident).
 *
 * The maintenance event IS the incident row (kind `input_contract_change`): its status is the lifecycle
 * state, its fact columns (finding, investigation, correction, validation, accounting) are the evidence,
 * incident_events is the timeline. No AI: every step is deterministic. Each step is idempotent, so the
 * driving job can be re-run after a crash.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@mi/database';
import {
  adaptations,
  deliveries,
  deliveryAttempts,
  incidentEvents,
  incidents,
  integrations,
  reconciliationItems,
  reconciliationRuns,
  webhookReceipts,
} from '@mi/database';
import {
  DEFAULT_RETRY,
  withRetry,
  type CredentialCipher,
  type RetryPolicy,
} from '@mi/integration-shopify-netsuite';
import { describeError } from '@mi/observability';
import {
  accountTransactions,
  blockingEvents,
  escalate,
  MAINTENANCE_ACTOR,
  note,
  recordPostActivation,
  setFacts,
  setProgress as setProgressGeneric,
  type TransactionAccounting,
} from '@mi/managed';
import {
  openIncident,
  readDestination,
  resolutionBlockers,
  transitionIncident,
  type IncidentRow,
  type SourceIdentity,
} from '@mi/reliability';
import { AdoptedConfigSchema, ADOPTED_FLOW_TYPE } from './contract.ts';
import type { ExecutionTrigger } from './execute.ts';
import {
  locateUpstreamRead,
  shapeOf,
  UPSTREAM_INPUT_CONTRACT,
  type ContractViolation,
} from './input-contract.ts';
import {
  activateAdaptation,
  baselineReceipts,
  evaluateInput,
  payloadOf,
  previouslyRolledBack,
  proposeAdaptation,
  runtimeFor,
  validateAdaptation,
  type AdaptationValidation,
} from './adaptation.ts';
import { patchCatalog } from './artifact.ts';
import { ADOPTED } from './provenance.ts';
import {
  ReconciliationBusy,
  requestRecovery,
  startReconciliation,
  type AdoptedClients,
} from './reconcile.ts';
import { RECOVERY_ORDER_QUERY, type RecoveryOrder } from './source.ts';

export const MAINTENANCE_KIND = 'input_contract_change' as const;
export { MAINTENANCE_ACTOR };

const docsDir = () =>
  process.env.PROVIDER_DOCS_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'provider-docs');
export const PROVIDER_CHANGELOG = 'shopify/FIXTURE-webhook-changelog.md';

/* ================================================================== types of the facts */

export interface Finding {
  provider: 'shopify';
  topic: string;
  dependency: { integrationId: string; flowType: string; upstream: { repository: string; commit: string } };
  expected: {
    contract: { path: string; expected: string; upstreamExpression: string; effect: string }[];
    baseline: { receiptId: string; apiVersion: string | null; receivedAt: string; shape: string[] } | null;
  };
  observed: {
    receiptId: string;
    deliveryId: string;
    apiVersion: string | null;
    receivedAt: string;
    violations: ContractViolation[];
    shape: string[];
  };
  shapeDiff: { removed: string[]; added: string[] } | null;
  relevance: string;
  /** Orders created after this may have arrived under the changed contract. */
  windowFrom: string;
  detectedAt: string;
}

/** Transaction accounting (the generic rule in @mi/managed, applied to this integration's population). */
export type Accounting = TransactionAccounting;

/** The incident's `correction` fact: which registry entry corrects this event. */
export interface CorrectionFact {
  adaptationId?: string;
  kind: 'adapter' | 'patch' | 'unsupported';
  derivable: boolean;
  rules?: { target: string; source: string; evidence: Record<string, unknown> }[];
  patchId?: string;
  reason?: string;
  boundary: string;
  upstreamModified: false;
  derivedAt: string;
  activatedAt?: string;
}

interface Progress {
  phase?:
    | 'release'
    | 'await_release'
    | 'reconcile'
    | 'await_reconcile'
    | 'await_recovery'
    | 'verify_reconcile'
    | 'await_verify';
  released?: string[];
  reconcileRunId?: string;
  verifyRunId?: string;
  window?: { from: string; to: string };
  reconcileAttempts?: number;
  /** A validated patch (or a validation with limitations) is waiting for an operator. */
  awaitingDecision?: boolean;
  escalated?: string;
}

/* ================================================================== detection */

/**
 * Start of the affected window, by order CREATION time (what reconciliation selects on): the creation
 * time of the last order known to be delivered under the old contract, or of the affected order if that
 * is earlier. Without a baseline order, 24 hours before the affected order.
 */
function affectedWindowFrom(baselinePayload: unknown, affectedCreatedAt: Date): Date {
  const b = Date.parse(String((baselinePayload as { created_at?: string } | undefined)?.created_at ?? ''));
  const a = affectedCreatedAt.getTime();
  return new Date(Number.isFinite(b) ? Math.min(b, a) : a - 24 * 3600_000);
}

/**
 * Records what the guard observed as a maintenance event (opens one, or attaches to the open one).
 * Idempotent. Returns null if the delivery's input no longer violates the contract.
 */
export async function recordInputContractFinding(
  db: Db,
  cipher: CredentialCipher,
  deliveryId: string,
): Promise<{ incidentId: string; created: boolean } | null> {
  const [d] = await db.select().from(deliveries).where(eq(deliveries.id, deliveryId));
  if (!d?.receiptId || d.outcome !== 'held') return null;
  const [receipt] = await db.select().from(webhookReceipts).where(eq(webhookReceipts.id, d.receiptId));
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, d.integrationId));
  if (!receipt || !integ || integ.flowType !== ADOPTED_FLOW_TYPE) return null;
  const payload = await payloadOf(cipher, receipt);
  const violations = evaluateInput(payload, await runtimeFor(db, integ.id)).violations;
  if (!violations.length) return null;

  const [base] = await baselineReceipts(db, cipher, integ.id, receipt.receivedAt, 1);
  const observedShape = shapeOf(payload);
  const baselineShape = base ? shapeOf(base.payload) : null;
  const fields = UPSTREAM_INPUT_CONTRACT.filter((f) => violations.some((v) => v.path === f.path));
  const finding: Finding = {
    provider: 'shopify',
    topic: receipt.topic,
    dependency: {
      integrationId: integ.id,
      flowType: integ.flowType,
      upstream: { repository: ADOPTED.repository, commit: ADOPTED.commit },
    },
    expected: {
      contract: fields.map((f) => ({
        path: f.path,
        expected: violations.find((v) => v.path === f.path)!.expected,
        upstreamExpression: `${f.upstream.file}: ${f.upstream.expression}`,
        effect: f.upstream.effect,
      })),
      baseline: base
        ? {
            receiptId: base.receipt.id,
            apiVersion: base.receipt.apiVersion,
            receivedAt: base.receipt.receivedAt.toISOString(),
            shape: baselineShape!,
          }
        : null,
    },
    observed: {
      receiptId: receipt.id,
      deliveryId: d.id,
      apiVersion: receipt.apiVersion,
      receivedAt: receipt.receivedAt.toISOString(),
      violations,
      shape: observedShape,
    },
    shapeDiff: baselineShape
      ? {
          removed: baselineShape.filter((p) => !observedShape.includes(p)),
          added: observedShape.filter((p) => !baselineShape.includes(p)),
        }
      : null,
    relevance: fields.map((f) => `${f.path} feeds ${f.upstream.effect}`).join('; '),
    windowFrom: affectedWindowFrom(base?.payload, d.sourceCreatedAt).toISOString(),
    detectedAt: new Date().toISOString(),
  };
  const [inc, created] = await openIncident(db, {
    tenantId: integ.tenantId,
    integrationId: integ.id,
    kind: MAINTENANCE_KIND,
    severity: 'high',
    title: 'Shopify order data changed shape',
    reason: `Order webhook (API version ${receipt.apiVersion ?? 'unknown'}) no longer satisfies what the adopted code reads: ${violations
      .map((v) => `${v.path} ${v.observed}`)
      .join(', ')}`,
    customerSummary:
      'A change in the order data Shopify sends could affect order processing. Orders are held safely while we take care of it.',
    classifyAs: 'investigating',
    classificationNote:
      'Input contract violated; affected orders are held (nothing written) and maintenance has started.',
    evidence: { detector: 'adopted input contract (execute.ts)', firstReceiptId: receipt.id },
  });
  // slice 7: the component that changed — Shopify, the pipeline's source provider.
  await db
    .update(incidents)
    .set({ boundary: sql`coalesce(${incidents.boundary}, 'source')`, provider: sql`coalesce(${incidents.provider}, 'shopify')` })
    .where(eq(incidents.id, inc.id));
  if (created) {
    // The generic open writes technical transition notes; they are for operators. The customer gets one plain note.
    await db
      .update(incidentEvents)
      .set({ customerVisible: false })
      .where(eq(incidentEvents.incidentId, inc.id));
    await db.insert(incidentEvents).values({
      incidentId: inc.id,
      fromStatus: inc.status,
      toStatus: inc.status,
      actor: MAINTENANCE_ACTOR,
      note: violations.every((v) => v.observed === 'precision')
        ? `We noticed Shopify orders where ${affectedLabels(finding)} has more decimal places than your integration keeps. Affected orders are held safely; nothing incorrect was written.`
        : `We noticed that Shopify changed the format of the order data it sends (${affectedLabels(finding)}). Affected orders are held safely; nothing incorrect was written.`,
      customerVisible: true,
      evidence: { step: 'noticed', receiptId: receipt.id, apiVersion: receipt.apiVersion },
    });
  }
  // The first observation is the finding; later held orders attach to the same event.
  await db
    .update(incidents)
    .set({
      finding: sql`coalesce(${incidents.finding}, ${JSON.stringify(finding)}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(eq(incidents.id, inc.id));
  return { incidentId: inc.id, created };
}

/** Held deliveries whose event is missing (crash between hold and recording): for the worker's sweep. */
export async function heldWithoutEvent(db: Db): Promise<string[]> {
  const held = await db
    .select({ id: deliveries.id, integrationId: deliveries.integrationId })
    .from(deliveries)
    .where(eq(deliveries.outcome, 'held'));
  const out: string[] = [];
  for (const h of held) {
    const [open] = await db
      .select({ id: incidents.id })
      .from(incidents)
      .where(
        and(
          eq(incidents.integrationId, h.integrationId),
          eq(incidents.kind, MAINTENANCE_KIND),
          sql`${incidents.status} <> 'resolved'`,
        ),
      );
    if (!open) out.push(h.id);
  }
  return out;
}

/** Open maintenance events (for the worker's sweep: an event whose job was lost is driven again). */
export async function openMaintenanceEvents(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: incidents.id, evidence: incidents.evidence })
    .from(incidents)
    .where(and(eq(incidents.kind, MAINTENANCE_KIND), sql`${incidents.status} <> 'resolved'`));
  return rows
    .filter((r) => !(r.evidence as { maintenance?: Progress }).maintenance?.escalated)
    .map((r) => r.id);
}

/** Plain-language names of the affected fields (from the contract), for customer-visible notes. */
const affectedLabels = (f: Finding) =>
  f.observed.violations
    .map((v) => UPSTREAM_INPUT_CONTRACT.find((c) => c.path === v.path)?.label ?? 'order data')
    .join(' and ');
const orders = (n: number) => `${n} order${n === 1 ? '' : 's'}`;

/* ================================================================== investigation */

/** Which code path the change reaches, and what the real upstream code does with the changed input. */
export async function investigate(db: Db, cipher: CredentialCipher, inc: IncidentRow) {
  const finding = inc.finding as Finding;
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, inc.integrationId!));
  const config = AdoptedConfigSchema.parse(integ!.config);
  const codePaths = finding.observed.violations.map((v) => {
    const field = UPSTREAM_INPUT_CONTRACT.find((f) => f.path === v.path)!;
    return {
      path: v.path,
      expression: field.upstream.expression,
      effect: field.upstream.effect,
      reads: locateUpstreamRead(field),
    };
  });
  // Dry run of the REAL upstream mapping on the held input: what would have been sent to NetSuite.
  const [receipt] = await db
    .select()
    .from(webhookReceipts)
    .where(eq(webhookReceipts.id, finding.observed.receiptId));
  const payload = await payloadOf(cipher, receipt!);
  // The code that runs for this integration right now (pinned artifact + active corrections).
  const rt = await runtimeFor(db, inc.integrationId!);
  const input = evaluateInput(payload, rt).payload as { line_items?: { sku?: string; price?: unknown }[] };
  const sentPrices = (input.line_items ?? []).filter((l) => l.sku).map((l) => Number(l.price));
  let dryRun: Record<string, unknown>;
  try {
    const order = rt.artifact.modules.toCanonicalOrder(input, {
      customerByEmail: config.customerByEmail,
      defaultCustomer: config.defaultCustomer,
    });
    const sent = JSON.parse(JSON.stringify(order.lines)) as {
      sku: string;
      qty: unknown;
      unitPrice: unknown;
    }[];
    dryRun = {
      upstreamFunction: 'src/mapping.js#toCanonicalOrder',
      artifact: rt.artifact.id,
      lines: sent.map((l, i) => ({
        sku: l.sku,
        qty: l.qty,
        priceFromShopify: sentPrices[i] ?? null,
        unitPriceAsSentToNetSuite: l.unitPrice,
      })),
      wouldSendInvalidRate: sent.filter((l) => typeof l.unitPrice !== 'number').length,
      wouldChangeAmount: sent.filter(
        (l, i) =>
          typeof l.unitPrice === 'number' && Number.isFinite(sentPrices[i]) && l.unitPrice !== sentPrices[i],
      ).length,
    };
  } catch (err) {
    dryRun = { upstreamFunction: 'src/mapping.js#toCanonicalOrder', threw: describeError(err).message };
  }
  const heldCount = (
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(deliveries)
      .where(and(eq(deliveries.integrationId, integ!.id), eq(deliveries.outcome, 'held')))
  )[0]!.n;
  const risk =
    typeof dryRun['wouldSendInvalidRate'] === 'number' && (dryRun['wouldSendInvalidRate'] as number) > 0
      ? `Without the guard, upstream would send ${dryRun['wouldSendInvalidRate']} line(s) with a null rate to NetSuite (rejected, or priced by NetSuite instead of Shopify).`
      : typeof dryRun['wouldChangeAmount'] === 'number' && (dryRun['wouldChangeAmount'] as number) > 0
        ? `Without the guard, upstream would write ${dryRun['wouldChangeAmount']} line(s) to NetSuite with a different price than Shopify's (rounded).`
        : 'Upstream cannot map the changed input correctly.';
  return { codePaths, dryRun, risk, heldOrders: heldCount, investigatedAt: new Date().toISOString() };
}

/* ================================================================== correction */

export interface ChangelogEntry {
  topic: string;
  version: string;
  removed: string;
  replacement: string;
}

/** Parses `| Topic | Version | Removed field | Replacement field | Notes |` tables. */
export function parseWebhookChangelog(doc: string): ChangelogEntry[] {
  const out: ChangelogEntry[] = [];
  for (const line of doc.split('\n')) {
    const c = line.split('|').map((x) => x.trim());
    if (c.length < 6) continue;
    const [, topic, version, removed, replacement] = c;
    if (!topic || !version || !removed || !replacement || topic === 'Topic' || /^-+$/.test(topic)) continue;
    out.push({ topic, version, removed, replacement });
  }
  return out;
}

const num = (v: unknown) => (v == null || v === '' ? NaN : Number(v));
const at = (o: unknown, path: string) =>
  path
    .split('.')
    .reduce<unknown>(
      (v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined),
      o,
    );

/** A proposed correction, before it is written to the registry. */
export type CorrectionProposal =
  | {
      kind: 'adapter' | 'patch';
      spec: Record<string, unknown>;
      rationale: string;
      dependency: Record<string, unknown>;
      codePath: Record<string, unknown>;
      evidence: Record<string, unknown>;
    }
  | {
      kind: 'unsupported';
      reason: string;
      dependency: Record<string, unknown>;
      codePath: Record<string, unknown>;
      evidence: Record<string, unknown>;
    };

/**
 * Derives a correction from the finding — deterministically, never by guessing:
 *  - a field went missing  → a field-moved ADAPTER, only if the provider documents the replacement AND stored
 *    orders show the two fields always carried the same value;
 *  - precision would be lost → a reviewed PATCH from the catalog that addresses exactly this, for this artifact;
 *  - anything else (conflicting values, wrong type, several fields at once, or a correction rolled back before)
 *    → UNSUPPORTED, with the reason. A person decides.
 */
export async function deriveCorrection(
  db: Db,
  cipher: CredentialCipher,
  inc: IncidentRow,
): Promise<CorrectionProposal> {
  const finding = inc.finding as Finding;
  const inv = inc.investigation as { codePaths?: Record<string, unknown>[] } | null;
  const codePath = (inv?.codePaths?.[0] ?? {}) as Record<string, unknown>;
  const dependency = {
    provider: finding.provider,
    topic: finding.topic,
    baselineVersion: finding.expected.baseline?.apiVersion ?? null,
    observedVersion: finding.observed.apiVersion,
    fields: finding.observed.violations.map((v) => ({ path: v.path, observed: v.observed })),
  };
  const unsupported = (reason: string, evidence: Record<string, unknown> = {}): CorrectionProposal => ({
    kind: 'unsupported',
    reason,
    dependency,
    codePath,
    evidence,
  });
  const vs = finding.observed.violations;
  if (vs.some((v) => v.observed === 'conflict'))
    return unsupported(
      'A field and its documented replacement carry different values; which one is right is a business decision.',
    );
  if (new Set(vs.map((v) => v.path)).size !== 1)
    return unsupported(
      `More than one field changed at once (${vs.map((v) => v.path).join(', ')}); no single reviewed correction covers it.`,
    );
  const v = vs[0]!;
  let proposal: CorrectionProposal;
  if (v.observed === 'precision') {
    const patch = patchCatalog().find(
      (p) =>
        'path' in p.addresses &&
        p.addresses.path === v.path &&
        p.addresses.observed === 'precision' &&
        p.artifact.commit === ADOPTED.commit &&
        p.baseSha256 === ADOPTED.fileSha256[p.file as keyof typeof ADOPTED.fileSha256],
    );
    if (!patch)
      return unsupported(
        `No reviewed patch preserves the precision of ${v.path} for ${ADOPTED.commit.slice(0, 12)}.`,
      );
    proposal = {
      kind: 'patch',
      spec: {
        patchId: patch.id,
        file: patch.file,
        baseSha256: patch.baseSha256,
        resultSha256: patch.resultSha256,
        find: patch.find,
        replace: patch.replace,
      },
      rationale: patch.reason,
      dependency,
      codePath,
      evidence: {
        patch: {
          id: patch.id,
          title: patch.title,
          originalBehavior: patch.originalBehavior,
          replacementBehavior: patch.replacementBehavior,
        },
        providerEvidence: patch.providerEvidence,
        assumptions: patch.assumptions,
        rollback: patch.rollback,
      },
    };
  } else if (v.observed === 'absent' || v.observed === 'null') {
    let entries: ChangelogEntry[];
    let changelogSha256: string;
    try {
      const doc = readFileSync(join(docsDir(), PROVIDER_CHANGELOG));
      changelogSha256 = createHash('sha256').update(doc).digest('hex');
      entries = parseWebhookChangelog(doc.toString('utf8'));
    } catch (err) {
      return unsupported(`Provider changelog unavailable: ${describeError(err).message}`);
    }
    const entry = entries.find(
      (e) =>
        e.topic === finding.topic &&
        e.removed === v.path &&
        (!finding.observed.apiVersion || e.version === finding.observed.apiVersion),
    );
    if (!entry)
      return unsupported(`No documented replacement for ${v.path} (${finding.observed.apiVersion})`);
    const [tHead, tKey] = v.path.split('[].') as [string, string | undefined];
    const [sHead, sRest] = entry.replacement.split('[].') as [string, string | undefined];
    if ((tKey === undefined) !== (sRest === undefined) || (tKey && tHead !== sHead))
      return unsupported(`Replacement ${entry.replacement} is not at the level of ${v.path}`);
    // Baseline equivalence: in orders received before the change, both fields were present and equal.
    const baseline = await baselineReceipts(
      db,
      cipher,
      inc.integrationId!,
      new Date(finding.observed.receivedAt),
    );
    let compared = 0;
    let mismatches = 0;
    for (const b of baseline) {
      const lines = tKey ? (((b.payload as Record<string, unknown>)[tHead] as unknown[]) ?? []) : [b.payload];
      for (const l of lines) {
        const t = tKey ? (l as Record<string, unknown>)[tKey] : at(l, v.path);
        const sv = at(l, sRest ?? entry.replacement);
        if (t === undefined || sv === undefined) continue;
        compared++;
        if (num(t) !== num(sv)) mismatches++;
      }
    }
    if (compared === 0 || mismatches > 0)
      return unsupported(
        compared === 0
          ? `Stored orders never carried both ${v.path} and ${entry.replacement}; equivalence cannot be shown`
          : `${mismatches} of ${compared} stored lines disagree between ${v.path} and ${entry.replacement}`,
      );
    proposal = {
      kind: 'adapter',
      spec: { type: 'field_moved', target: v.path, source: entry.replacement },
      rationale: `${finding.provider} no longer sends ${v.path} (version ${finding.observed.apiVersion}); its documented replacement ${entry.replacement} carried the same value in every stored order.`,
      dependency,
      codePath,
      evidence: {
        changelog: { file: `docs/provider-docs/${PROVIDER_CHANGELOG}`, sha256: changelogSha256, entry },
        baselineEquivalence: { receipts: baseline.length, linesCompared: compared, mismatches },
      },
    };
  } else {
    return unsupported(
      `${v.path} changed representation (${v.observed}); no reviewed correction preserves its meaning.`,
    );
  }
  const before = await previouslyRolledBack(db, inc.integrationId!, proposal.spec);
  if (before)
    return unsupported(
      `This correction was rolled back before (adaptation ${before.id}); re-applying it needs an operator decision.`,
      {
        rolledBack: before.id,
      },
    );
  return proposal;
}

/* ================================================================== verification and accounting */

const sqlLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Line-level destination verification of every order in a completed reconciliation run, against
 * Shopify's own order record: exactly one NetSuite sales order, same items, quantities and prices.
 */
export async function verifyDestinations(
  db: Db,
  runId: string,
  clients: AdoptedClients,
  retry: RetryPolicy = DEFAULT_RETRY,
) {
  const items = await db.select().from(reconciliationItems).where(eq(reconciliationItems.runId, runId));
  const relevant = items.filter((i) => i.classification !== 'excluded');
  const orders = new Map<string, RecoveryOrder>();
  for (const i of relevant) {
    const res = await withRetry(
      () => clients.shopify.graphql(RECOVERY_ORDER_QUERY, { id: i.sourceOrderId }),
      retry,
    );
    const o = (res.data as { order?: RecoveryOrder | null }).order;
    if (o) orders.set(i.sourceOrderId, o);
  }
  const skus = [
    ...new Set(
      [...orders.values()].flatMap((o) =>
        o.lineItems.nodes.map((l) => l.sku).filter((s): s is string => !!s),
      ),
    ),
  ];
  const itemIds = new Map<string, string>();
  if (skus.length) {
    const page = await withRetry(
      () =>
        clients.netsuite.suiteqlPage<{ id: string; itemid: string }>(
          `SELECT id, itemid FROM item WHERE itemid IN (${skus.map(sqlLiteral).join(', ')})`,
          [],
          1000,
          0,
        ),
      retry,
    );
    for (const r of page.items) itemIds.set(r.itemid, String(r.id));
  }
  const identities: SourceIdentity[] = [...orders.values()].map((o) => ({
    sourceId: o.id,
    legacyId: o.legacyResourceId,
    name: o.name,
    updatedAt: o.updatedAt,
    cancelledAt: o.cancelledAt,
    lines: o.lineItems.nodes.map((l) => ({ sku: l.sku, quantity: l.quantity })),
  }));
  const dest = identities.length ? await readDestination(clients.netsuite, identities, retry) : [];
  return relevant.map((i) => {
    const o = orders.get(i.sourceOrderId);
    if (!o)
      return {
        sourceOrderId: i.sourceOrderId,
        order: i.orderName,
        legacyId: i.sourceLegacyId,
        verified: false,
        records: 0,
        detail: 'Shopify order not readable',
      };
    const matches = dest.filter(
      (d) => d.externalId === `shopify-${o.legacyResourceId}` || d.otherRefNum === o.name,
    );
    if (matches.length !== 1)
      return {
        sourceOrderId: i.sourceOrderId,
        order: o.name,
        legacyId: o.legacyResourceId,
        verified: false,
        records: matches.length,
        detail: `${matches.length} NetSuite sales orders`,
      };
    const expected = o.lineItems.nodes
      .filter((l) => !!l.sku)
      .map((l) => ({
        itemId: itemIds.get(l.sku!) ?? '?',
        quantity: l.quantity,
        // exact: Shopify's decimal amount vs the rate NetSuite holds (catches rounding, not just minor units)
        rate: Number(l.originalUnitPriceSet.shopMoney.amount),
      }));
    const actual = matches[0]!.lines.map((l) => ({
      itemId: String(l.itemId),
      quantity: Math.abs(l.quantity),
      rate: l.rate ?? l.rateMinor / 100,
    }));
    const ok = JSON.stringify(expected) === JSON.stringify(actual);
    return {
      sourceOrderId: i.sourceOrderId,
      order: o.name,
      legacyId: o.legacyResourceId,
      verified: ok,
      records: 1,
      destinationId: matches[0]!.id,
      detail: ok
        ? `NetSuite ${matches[0]!.id}: ${expected.length} line(s), items, quantities and prices match Shopify`
        : 'NetSuite lines differ from Shopify',
    };
  });
}

/** Accounts for every order in the affected window from durable facts (pure apart from reads). */
export async function computeAccounting(
  db: Db,
  inc: IncidentRow,
  p: {
    reconcileRunId: string;
    verifyRunId: string;
    verification: Awaited<ReturnType<typeof verifyDestinations>>;
    /** Source ids of the orders this event held: all of them must be in the population. */
    affectedSourceIds: string[];
  },
): Promise<Accounting> {
  const finding = inc.finding as Finding;
  const detectedAt = new Date(finding.observed.receivedAt);
  const [run] = await db.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, p.verifyRunId));
  const items = await db
    .select()
    .from(reconciliationItems)
    .where(eq(reconciliationItems.runId, p.verifyRunId));
  const first = await db
    .select()
    .from(reconciliationItems)
    .where(eq(reconciliationItems.runId, p.reconcileRunId));
  const discovered = new Set(
    first.filter((i) => i.classification === 'missing_delivery').map((i) => i.sourceOrderId),
  );
  const dels = items.length
    ? await db
        .select()
        .from(deliveries)
        .where(
          and(
            eq(deliveries.integrationId, inc.integrationId!),
            inArray(
              deliveries.sourceId,
              items.map((i) => i.sourceOrderId),
            ),
          ),
        )
    : [];
  const attempts = dels.length
    ? await db
        .select()
        .from(deliveryAttempts)
        .where(
          inArray(
            deliveryAttempts.deliveryId,
            dels.map((d) => d.id),
          ),
        )
    : [];
  const verifiedBy = new Map(p.verification.map((v) => [v.sourceOrderId, v]));
  return accountTransactions({
    window: { from: run!.windowFrom, to: run!.windowTo },
    sourceRunId: p.verifyRunId,
    readCompletely: run?.status === 'completed' && run.outcome !== 'partial',
    detectedAt,
    affectedSourceIds: p.affectedSourceIds,
    items: items.map((i) => {
      const d = dels.find((x) => x.sourceId === i.sourceOrderId);
      const v = verifiedBy.get(i.sourceOrderId);
      return {
        sourceId: i.sourceOrderId,
        label: i.orderName,
        reference: i.sourceLegacyId,
        excluded: i.classification === 'excluded' ? (i.reason ?? 'excluded') : null,
        delivered: i.classification === 'delivered',
        discovered: discovered.has(i.sourceOrderId),
        attemptOutcomes: d ? attempts.filter((a) => a.deliveryId === d.id).map((a) => a.outcome) : [],
        deliveredAt: d?.deliveredAt ?? null,
        verification: v ? { verified: v.verified, records: v.records, detail: v.detail } : null,
      };
    }),
  });
}

/* ================================================================== the driver */

export interface AdvanceParams {
  db: Db;
  cipher: CredentialCipher;
  incidentId: string;
  clients: AdoptedClients;
  enqueueExecution: (deliveryId: string, trigger: ExecutionTrigger) => Promise<void>;
  enqueueReconciliation: (runId: string) => Promise<void>;
  enqueueRecovery: (itemId: string) => Promise<void>;
  retry?: RetryPolicy;
}
export type AdvanceResult = {
  state: 'continue' | 'wait' | 'escalated' | 'resolved' | 'noop';
  detail: string;
};

async function setProgress(db: Db, id: string, progress: Progress) {
  await setProgressGeneric(db, id, progress as Record<string, unknown>);
}

/** Advances a maintenance event by one step. Safe to call repeatedly and after crashes. */
export async function advanceMaintenance(p: AdvanceParams): Promise<AdvanceResult> {
  const { db } = p;
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, p.incidentId));
  if (!inc || inc.kind !== MAINTENANCE_KIND || inc.status === 'resolved')
    return { state: 'noop', detail: 'nothing to do' };
  const prog = ((inc.evidence as { maintenance?: Progress }).maintenance ?? {}) as Progress;
  if (prog.escalated) return { state: 'escalated', detail: prog.escalated };
  if (!inc.finding) return { state: 'wait', detail: 'finding not recorded yet' };

  if (inc.status === 'investigating') {
    if (!inc.investigation) {
      const investigation = await investigate(db, p.cipher, inc);
      await setFacts(db, inc.id, { investigation });
      await note(
        db,
        inc,
        `We traced the change to the part of your integration that reads ${affectedLabels(inc.finding as Finding)} and confirmed that, left alone, it would have produced incorrect sales orders.`,
        true,
        {
          step: 'investigated',
          heldOrders: investigation.heldOrders,
          risk: investigation.risk,
          codePaths: investigation.codePaths,
        },
      );
      return { state: 'continue', detail: 'investigated' };
    }
    let correction = inc.correction as CorrectionFact | null;
    if (!correction) {
      const proposal = await deriveCorrection(db, p.cipher, inc);
      const row = await proposeAdaptation(db, {
        integrationId: inc.integrationId!,
        maintenanceEventId: inc.id,
        kind: proposal.kind,
        dependency: proposal.dependency,
        codePath: proposal.codePath,
        spec: proposal.kind === 'unsupported' ? { reason: proposal.reason } : proposal.spec,
        rationale: proposal.kind === 'unsupported' ? proposal.reason : proposal.rationale,
        evidence: proposal.evidence,
        actor: MAINTENANCE_ACTOR,
      });
      correction = {
        adaptationId: row.id,
        kind: proposal.kind,
        derivable: proposal.kind !== 'unsupported',
        ...(proposal.kind === 'adapter'
          ? {
              rules: [
                {
                  target: String(proposal.spec['target']),
                  source: String(proposal.spec['source']),
                  evidence: proposal.evidence,
                },
              ],
            }
          : {}),
        ...(proposal.kind === 'patch' ? { patchId: String(proposal.spec['patchId']) } : {}),
        ...(proposal.kind === 'unsupported' ? { reason: proposal.reason } : {}),
        boundary:
          proposal.kind === 'patch'
            ? 'reviewed patch applied to a content-addressed copy of the pinned upstream package'
            : 'adoption boundary: adapter applied before the adopted code runs',
        upstreamModified: false,
        derivedAt: new Date().toISOString(),
      };
      await setFacts(db, inc.id, { correction });
      if (proposal.kind === 'unsupported') return escalate(db, inc, proposal.reason);
      return { state: 'continue', detail: `${proposal.kind} proposed` };
    }
    if (!correction.adaptationId) return escalate(db, inc, correction.reason ?? 'no correction');
    const [row] = await db.select().from(adaptations).where(eq(adaptations.id, correction.adaptationId));
    if (!row) return escalate(db, inc, 'correction record missing');
    if (['unsupported', 'rejected', 'rolled_back'].includes(row.status))
      return escalate(db, inc, `correction ${row.status}: ${row.rationale}`);
    if (row.status === 'proposed' || row.status === 'validating') {
      const validated = await validateAdaptation(db, p.cipher, row.id, p.clients, p.retry);
      const validation = validated.validation as AdaptationValidation;
      await setFacts(db, inc.id, { validation });
      if (validated.status !== 'validated')
        return escalate(
          db,
          inc,
          `validation failed: ${validation.checks
            .filter((c) => c.status === 'failed')
            .map((c) => c.name)
            .join(', ')}`,
        );
      await note(
        db,
        inc,
        'We tested the fix against earlier orders and against Shopify’s own records of the affected orders before switching it on.',
        true,
        { step: 'tested', checks: validation.checks },
      );
      return { state: 'continue', detail: 'validated' };
    }
    if (row.status === 'validated') {
      const v = row.validation as AdaptationValidation;
      if (row.kind === 'adapter' && !v.requiresDecision) {
        await activateAdaptation(db, row.id, MAINTENANCE_ACTOR, `Activated by maintenance event ${inc.id}`);
        return { state: 'continue', detail: 'adapter activated' };
      }
      // Patches (and validations with limitations) are switched on by a person.
      if (!prog.awaitingDecision) {
        await setProgress(db, inc.id, { awaitingDecision: true });
        await note(
          db,
          inc,
          'We prepared and tested a fix. An engineer is reviewing it before we switch it on.',
          true,
          {
            step: 'reviewing',
            adaptationId: row.id,
            kind: row.kind,
          },
        );
      }
      return { state: 'escalated', detail: 'awaiting operator activation' };
    }
    // active
    const activatedAt = row.activatedAt!.toISOString();
    await db
      .update(incidents)
      .set({ correction: { ...correction, activatedAt }, updatedAt: new Date() })
      .where(eq(incidents.id, inc.id));
    const rt = await runtimeFor(db, inc.integrationId!);
    await transitionIncident(db, inc.id, 'recovery', {
      actor: MAINTENANCE_ACTOR,
      note: 'We switched the fix on.',
      // Technical detail for operators lives in the evidence of this timeline entry.
      evidence: {
        step: 'switched_on',
        adaptationId: row.id,
        kind: row.kind,
        artifact: rt.artifact.id,
        upstreamModified: false,
      },
    });
    await setProgress(db, inc.id, { phase: 'release' });
    return { state: 'continue', detail: 'correction active' };
  }

  if (inc.status === 'recovery') {
    const phase = prog.phase ?? 'release';
    if (phase === 'release') {
      // slice 7: whole path or nothing — another change of this integration still awaiting its correction
      // (e.g. NetSuite now requires a field) blocks release; orders are released once, when all are corrected.
      const blocking = await blockingEvents(db, inc.integrationId!, inc.id);
      if (blocking.length) return { state: 'wait', detail: `waiting for ${blocking.map((b) => b.kind).join(', ')}` };
      const held = await db
        .update(deliveries)
        .set({ outcome: 'pending', updatedAt: new Date() })
        .where(and(eq(deliveries.integrationId, inc.integrationId!), eq(deliveries.outcome, 'held')))
        .returning({ id: deliveries.id });
      const released = [...new Set([...(prog.released ?? []), ...held.map((h) => h.id)])];
      await setProgress(db, inc.id, { phase: 'await_release', released });
      for (const h of held)
        await p.enqueueExecution(h.id, {
          kind: 'maintenance_recovery',
          maintenanceEventId: inc.id,
          reason: 'Released after correction',
        });
      return { state: 'continue', detail: `released ${held.length} held order(s)` };
    }
    if (phase === 'await_release') {
      const ids = prog.released ?? [];
      const rows = ids.length ? await db.select().from(deliveries).where(inArray(deliveries.id, ids)) : [];
      if (rows.some((r) => r.outcome === 'pending' || r.outcome === 'running'))
        return { state: 'wait', detail: 'held orders executing' };
      if (rows.some((r) => r.outcome === 'held'))
        return escalate(db, inc, 'orders still held after the correction');
      const delivered = rows.filter((r) => r.outcome === 'delivered').length;
      await note(
        db,
        inc,
        `The ${orders(rows.length)} we held ${rows.length === 1 ? 'was' : 'were'} delivered to NetSuite (${delivered} of ${rows.length}).`,
        true,
        {
          step: 'delivered',
          delivered,
          held: rows.length,
          released: ids,
          path: 'normal execution path (maintenance_recovery)',
        },
      );
      await setProgress(db, inc.id, { phase: 'reconcile' });
      return { state: 'continue', detail: 'released orders finished' };
    }
    if (phase === 'reconcile') {
      const finding = inc.finding as Finding;
      const window = prog.window ?? { from: finding.windowFrom, to: new Date().toISOString() };
      try {
        const s = await startReconciliation(db, {
          integrationId: inc.integrationId!,
          trigger: 'maintenance',
          requestedBy: MAINTENANCE_ACTOR,
          window: { from: new Date(window.from), to: new Date(window.to) },
        });
        await setProgress(db, inc.id, {
          phase: 'await_reconcile',
          reconcileRunId: s.runId,
          window,
          reconcileAttempts: (prog.reconcileAttempts ?? 0) + 1,
        });
        await p.enqueueReconciliation(s.runId);
        return { state: 'continue', detail: 'reconciliation started' };
      } catch (err) {
        if (err instanceof ReconciliationBusy)
          return { state: 'wait', detail: 'another reconciliation is running' };
        throw err;
      }
    }
    if (phase === 'await_reconcile') {
      const [run] = await db
        .select()
        .from(reconciliationRuns)
        .where(eq(reconciliationRuns.id, prog.reconcileRunId!));
      if (run!.status === 'running') return { state: 'wait', detail: 'reconciliation running' };
      if (run!.status !== 'completed' || run!.outcome === 'partial') {
        if ((prog.reconcileAttempts ?? 0) >= 3)
          return escalate(db, inc, 'reconciliation of the affected window did not complete');
        await setProgress(db, inc.id, { phase: 'reconcile' });
        return { state: 'wait', detail: 'reconciliation incomplete; retrying' };
      }
      const missing = await db
        .select()
        .from(reconciliationItems)
        .where(
          and(
            eq(reconciliationItems.runId, run!.id),
            eq(reconciliationItems.classification, 'missing_delivery'),
          ),
        );
      const decisions = missing.length
        ? await requestRecovery(db, {
            runId: run!.id,
            sourceOrderIds: missing.map((m) => m.sourceOrderId),
            principalId: MAINTENANCE_ACTOR,
            requestId: inc.id,
            reason: 'Maintenance: order missing from the affected window',
          })
        : [];
      for (const d of decisions) if (d.accepted) await p.enqueueRecovery(d.itemId);
      await note(
        db,
        inc,
        `We checked all ${orders(run!.sourceCount ?? 0)} Shopify has for the affected period. ${
          missing.length
            ? `${missing.length === 1 ? 'One had' : `${missing.length} had`} never reached us; we are recovering ${missing.length === 1 ? 'it' : 'them'}.`
            : 'None were missing.'
        }`,
        true,
        { step: 'checked', checked: run!.sourceCount ?? 0, missing: missing.length, runId: run!.id },
      );
      await setProgress(db, inc.id, { phase: 'await_recovery' });
      return { state: 'continue', detail: `recovery requested for ${missing.length}` };
    }
    if (phase === 'await_recovery') {
      const pending = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(reconciliationItems)
        .where(
          and(
            eq(reconciliationItems.runId, prog.reconcileRunId!),
            inArray(reconciliationItems.recoveryState, ['requested', 'executing']),
          ),
        );
      if (pending[0]!.n > 0) return { state: 'wait', detail: 'recovering missing orders' };
      await transitionIncident(db, inc.id, 'verification', {
        actor: MAINTENANCE_ACTOR,
        note: 'Recovery finished. We are now checking every order from the affected period in NetSuite.',
        evidence: { step: 'verifying' },
      });
      await setProgress(db, inc.id, { phase: 'verify_reconcile' });
      return { state: 'continue', detail: 'to verification' };
    }
  }

  if (inc.status === 'verification') {
    const phase = prog.phase ?? 'verify_reconcile';
    if (phase === 'verify_reconcile') {
      try {
        const s = await startReconciliation(db, {
          integrationId: inc.integrationId!,
          trigger: 'maintenance',
          requestedBy: MAINTENANCE_ACTOR,
          window: { from: new Date(prog.window!.from), to: new Date(prog.window!.to) },
        });
        await setProgress(db, inc.id, { phase: 'await_verify', verifyRunId: s.runId });
        await p.enqueueReconciliation(s.runId);
        return { state: 'continue', detail: 'verification run started' };
      } catch (err) {
        if (err instanceof ReconciliationBusy)
          return { state: 'wait', detail: 'another reconciliation is running' };
        throw err;
      }
    }
    if (phase === 'await_verify') {
      const [run] = await db
        .select()
        .from(reconciliationRuns)
        .where(eq(reconciliationRuns.id, prog.verifyRunId!));
      if (run!.status === 'running') return { state: 'wait', detail: 'verification run running' };
      const verification = await verifyDestinations(db, run!.id, p.clients, p.retry);
      const released = prog.released?.length
        ? await db
            .select({ sourceId: deliveries.sourceId })
            .from(deliveries)
            .where(inArray(deliveries.id, prog.released))
        : [];
      const accounting = await computeAccounting(db, inc, {
        reconcileRunId: prog.reconcileRunId!,
        verifyRunId: run!.id,
        verification,
        affectedSourceIds: released.map((r) => r.sourceId),
      });
      await setFacts(db, inc.id, { accounting });
      const evidence = {
        passed: accounting.zeroLoss,
        verifyRunId: run!.id,
        runOutcome: run!.outcome,
        ordersVerified: accounting.verified,
        population: accounting.population,
        duplicates: accounting.duplicates,
        method: 'second reconciliation run + line-level NetSuite comparison with Shopify Admin API',
      };
      const [fresh] = await db.select().from(incidents).where(eq(incidents.id, inc.id));
      const blockers = resolutionBlockers(fresh!, evidence);
      if (blockers.length) return escalate(db, fresh!, `not resolved: ${blockers.join('; ')}`);
      await transitionIncident(db, inc.id, 'resolved', {
        actor: MAINTENANCE_ACTOR,
        note: `All ${orders(accounting.verified)} from the affected period are in NetSuite exactly once, with the right items, quantities and prices.`,
        resolution:
          'Compatibility correction applied at the adoption boundary; affected orders delivered and verified.',
        verification: evidence,
        evidence: { step: 'verified', verified: accounting.verified, duplicates: accounting.duplicates },
      });
      // The correction's own record carries what was proven after it went live.
      const adaptationId = (inc.correction as CorrectionFact | null)?.adaptationId;
      if (adaptationId)
        await recordPostActivation(db, adaptationId, {
          maintenanceEventId: inc.id,
          verifiedAt: new Date().toISOString(),
          population: accounting.population,
          verified: accounting.verified,
          recovered: accounting.recovered,
          unresolved: accounting.unresolved,
          duplicates: accounting.duplicates,
          zeroLoss: accounting.zeroLoss,
          verificationRunId: run!.id,
        });
      return { state: 'resolved', detail: 'verified and resolved' };
    }
  }
  return { state: 'noop', detail: `no step for status ${inc.status}` };
}
