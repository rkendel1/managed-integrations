/**
 * Transaction accounting (generic; the rule extracted from slice 4). Answers, for a population of source
 * transactions, without knowing what a transaction is:
 *
 *   what was considered · what was expected · delivered · delayed or recovered · excluded · unresolved ·
 *   what destination evidence confirms each · whether duplicates were introduced · whether the population is
 *   complete enough to make a loss claim.
 *
 * The integration supplies the population (from its own reconciliation of its own source) and the
 * destination verification of each transaction (its own business semantics). The CLAIM is made here, once:
 * zero loss requires a completely read, non-empty population that contains every transaction the event
 * affected, with every non-excluded transaction independently verified, nothing unresolved and no duplicate.
 */

export type TransactionCategory =
  'delivered_before_change' | 'delayed' | 'failed' | 'discovered' | 'delivered' | 'excluded' | 'unresolved';

/** One source transaction in the population, as the integration observed it. */
export interface PopulationItem {
  /** Stable source id (what affected ids refer to). */
  sourceId: string;
  /** Human label, e.g. "#1001" or "Charge ch_…". */
  label: string;
  /** Provider reference, e.g. order legacy id or object id. */
  reference: string;
  excluded: string | null;
  /** The reconciliation that read the population classified it as delivered (exists at the destination). */
  delivered: boolean;
  /** It was missing at the start and was recovered (found by checking the source). */
  discovered: boolean;
  /** Execution attempt outcomes recorded for it (held, failed, rejected, delivered, …). */
  attemptOutcomes: string[];
  deliveredAt: Date | null;
  /** Independent destination verification. */
  verification: { verified: boolean; records: number; detail: string } | null;
}

export interface TransactionAccounting {
  window: { from: string; to: string };
  sourceRunId: string;
  population: number;
  populationComplete: boolean;
  deliveredBeforeChange: number;
  delayed: number;
  failedDuringDisruption: number;
  discoveredByReconciliation: number;
  recovered: number;
  verified: number;
  excluded: { count: number; reasons: Record<string, number> };
  unresolved: number;
  duplicates: number;
  transactions: {
    label: string;
    reference: string;
    category: TransactionCategory;
    verified: boolean;
    detail: string;
  }[];
  /** Affected transactions missing from the population (makes the population incomplete). */
  notInPopulation?: string[];
  zeroLoss: boolean;
  computedAt: string;
}

export function accountTransactions(input: {
  window: { from: Date; to: Date };
  sourceRunId: string;
  /** The population was read completely (the reconciliation run completed, not partial). */
  readCompletely: boolean;
  items: PopulationItem[];
  /** Every transaction the event affected (e.g. held): all must be in the population. */
  affectedSourceIds: string[];
  /** When the change was detected: deliveries before it count as unaffected. */
  detectedAt: Date;
}): TransactionAccounting {
  const excludedReasons: Record<string, number> = {};
  const transactions: TransactionAccounting['transactions'] = [];
  let duplicates = 0;
  for (const i of input.items) {
    if (i.excluded !== null) {
      excludedReasons[i.excluded] = (excludedReasons[i.excluded] ?? 0) + 1;
      transactions.push({
        label: i.label,
        reference: i.reference,
        category: 'excluded',
        verified: false,
        detail: i.excluded,
      });
      continue;
    }
    if ((i.verification?.records ?? 0) > 1) duplicates++;
    const verified = i.verification?.verified === true && i.delivered;
    let category: TransactionCategory;
    if (!verified) category = 'unresolved';
    else if (i.discovered) category = 'discovered';
    else if (i.attemptOutcomes.includes('held')) category = 'delayed';
    else if (i.attemptOutcomes.some((o) => o === 'failed' || o === 'rejected')) category = 'failed';
    else if (i.deliveredAt && i.deliveredAt < input.detectedAt) category = 'delivered_before_change';
    else category = 'delivered';
    transactions.push({
      label: i.label,
      reference: i.reference,
      category,
      verified,
      detail: i.verification?.detail ?? '',
    });
  }
  const count = (c: TransactionCategory) => transactions.filter((t) => t.category === c).length;
  const inPopulation = new Set(input.items.map((i) => i.sourceId));
  const notCovered = input.affectedSourceIds.filter((id) => !inPopulation.has(id));
  const populationComplete = input.readCompletely && input.items.length > 0 && notCovered.length === 0;
  const verified = transactions.filter((t) => t.verified).length;
  const unresolved = count('unresolved') + notCovered.length;
  return {
    window: { from: input.window.from.toISOString(), to: input.window.to.toISOString() },
    sourceRunId: input.sourceRunId,
    population: input.items.length,
    populationComplete,
    deliveredBeforeChange: count('delivered_before_change'),
    delayed: count('delayed'),
    failedDuringDisruption: count('failed'),
    discoveredByReconciliation: count('discovered'),
    recovered: count('delayed') + count('failed') + count('discovered'),
    verified,
    excluded: { count: count('excluded'), reasons: excludedReasons },
    unresolved,
    duplicates,
    transactions,
    ...(notCovered.length ? { notInPopulation: notCovered } : {}),
    zeroLoss:
      populationComplete &&
      unresolved === 0 &&
      duplicates === 0 &&
      verified > 0 &&
      verified === input.items.length - count('excluded'),
    computedAt: new Date().toISOString(),
  };
}
