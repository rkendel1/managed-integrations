/**
 * The customer product's view of authoritative state (slice 4). Two pure functions over durable rows:
 *
 *  - `assessStatus`: an integration's customer status, by explicit rules with stated evidence. Nothing is
 *    "Protected" because a worker is running or an API call succeeded; it needs a recent completed check.
 *  - `presentEvent`: a maintenance event as a customer story. Every sentence is built from the event's
 *    persisted facts (finding, correction, validation, accounting, verification, timeline). A zero-loss
 *    statement appears only when the persisted accounting proves it.
 *
 * Operators read the same rows through `maintenance.events.evidence`; the customer projection is a
 * function of them, so the two cannot disagree about the outcome.
 */
import { UPSTREAM_INPUT_CONTRACT, type Accounting, type Finding } from '@mi/adopted-order-sync';
import type { incidentEvents, incidents, reconciliationRuns } from '@mi/database';

type IncidentRow = typeof incidents.$inferSelect;
type EventRow = typeof incidentEvents.$inferSelect;
type RunRow = typeof reconciliationRuns.$inferSelect;

/* ================================================================== status */

export const STATUS_CODES = ['protected', 'maintaining', 'verified', 'customer_action', 'checking'] as const;
export type StatusCode = (typeof STATUS_CODES)[number];

/** Each status, with the rule that grants it. Published to the customer alongside the status. */
export const STATUS_DEFINITIONS: Record<StatusCode, { label: string; definition: string }> = {
  customer_action: {
    label: 'Your input needed',
    definition: 'An open issue needs a decision, data or credential that only you can provide.',
  },
  maintaining: {
    label: 'Maintaining',
    definition: 'We are handling a detected change or issue right now. Nothing is needed from you.',
  },
  verified: {
    label: 'Verified',
    definition:
      'We completed maintenance in the last 7 days and verified the outcome against your systems. No open issues.',
  },
  protected: {
    label: 'Protected',
    definition:
      'No open issues, and a check completed in the last 24 hours found every order accounted for in both systems.',
  },
  checking: {
    label: 'Verification pending',
    definition:
      'No open issues, but there is no completed check from the last 24 hours that accounts for every order. We do not call this protected until there is.',
  },
};

const DAY = 24 * 3600_000;
export const VERIFIED_FOR_MS = 7 * DAY;
export const EVIDENCE_FRESH_MS = DAY;

export interface StatusAssessment {
  code: StatusCode;
  label: string;
  definition: string;
  /** Why this status, in the customer's terms. */
  reason: string;
  /** The rows the status is based on. */
  basis: { incidentId?: string; reconciliationRunId?: string };
}

export function assessStatus(
  open: IncidentRow[],
  lastResolved: IncidentRow | undefined,
  lastCheck: RunRow | undefined,
  now = new Date(),
): StatusAssessment {
  const make = (code: StatusCode, reason: string, basis: StatusAssessment['basis']) => ({
    code,
    ...STATUS_DEFINITIONS[code],
    reason,
    basis,
  });
  const action = open.find((i) => i.status === 'requires_action');
  if (action)
    return make('customer_action', action.customerAction ?? action.title, { incidentId: action.id });
  if (open[0]) return make('maintaining', headlineFor(open[0], null), { incidentId: open[0].id });
  if (
    lastResolved?.resolvedAt &&
    lastResolved.verification &&
    now.getTime() - lastResolved.resolvedAt.getTime() < VERIFIED_FOR_MS
  ) {
    return make(
      'verified',
      `${headlineFor(lastResolved, null)} on ${lastResolved.resolvedAt.toISOString().slice(0, 10)}.`,
      {
        incidentId: lastResolved.id,
      },
    );
  }
  if (lastCheck?.finishedAt && now.getTime() - lastCheck.finishedAt.getTime() < EVIDENCE_FRESH_MS) {
    if (lastCheck.status === 'completed' && lastCheck.outcome === 'consistent')
      return make('protected', checkSentence(lastCheck), { reconciliationRunId: lastCheck.id });
    return make(
      'checking',
      'The most recent check did not account for every order yet; we are reviewing it.',
      {
        reconciliationRunId: lastCheck.id,
      },
    );
  }
  return make('checking', 'No completed check in the last 24 hours.', {});
}

export function checkSentence(run: RunRow): string {
  const n = run.expectedCount ?? run.sourceCount ?? 0;
  return `On ${run.finishedAt!.toISOString().slice(0, 16).replace('T', ' ')} UTC we checked ${n} order(s) from Shopify against NetSuite: all accounted for.`;
}

/* ================================================================== maintenance events */

const KIND_HEADLINES: Record<string, { open: string; done: string; category: string }> = {
  input_contract_change: {
    open: 'We are handling a change in how Shopify sends orders',
    done: 'We resolved a compatibility issue',
    category: 'Provider change',
  },
  schema_drift: {
    open: 'We are handling a change in Shopify’s order data',
    done: 'We resolved a compatibility issue',
    category: 'Provider change',
  },
  connection_auth: {
    open: 'A connection needs to be re-authorized',
    done: 'A connection was restored',
    category: 'Access',
  },
  records_rejected: {
    open: 'Some orders need information from you',
    done: 'Orders that needed your input were completed',
    category: 'Data',
  },
  sync_failure: {
    open: 'We are restoring order delivery',
    done: 'We restored order delivery',
    category: 'Availability',
  },
  freshness_breach: {
    open: 'Orders are arriving later than usual; we are on it',
    done: 'Order delivery is back on time',
    category: 'Availability',
  },
  reconciliation_discrepancy: {
    open: 'We are correcting orders that did not match',
    done: 'We corrected orders that did not match',
    category: 'Accuracy',
  },
};

function headlineFor(inc: IncidentRow, accounting: Accounting | null): string {
  const h = KIND_HEADLINES[inc.kind] ?? { open: inc.title, done: inc.title, category: 'Other' };
  if (inc.status !== 'resolved') return h.open;
  return accounting && !accounting.zeroLoss ? `${h.done}, with exceptions` : h.done;
}

const labelOf = (path: string) => UPSTREAM_INPUT_CONTRACT.find((f) => f.path === path)?.label ?? path;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface CustomerEvent {
  id: string;
  integrationId: string;
  category: string;
  state: 'in_progress' | 'completed' | 'needs_you';
  headline: string;
  summary: string;
  detectedAt: string;
  resolvedAt: string | null;
  facts: { label: string; value: string }[];
  accounting: {
    window: { from: string; to: string };
    ordersInWindow: number;
    deliveredBeforeChange: number;
    delayed: number;
    failedDuringDisruption: number;
    foundByChecking: number;
    recovered: number;
    verified: number;
    excluded: number;
    unresolved: number;
    duplicates: number;
  } | null;
  claim: { zeroLoss: boolean; statement: string | null; basis: string };
  customerAction: { required: boolean; text: string | null };
  timeline: { at: string; text: string }[];
}

/** A maintenance event as the customer sees it — derived entirely from persisted facts. */
export function presentEvent(inc: IncidentRow, events: EventRow[]): CustomerEvent {
  const finding = inc.finding as Finding | null;
  const correction = inc.correction as {
    activatedAt?: string;
    rules?: { target: string; source: string }[];
  } | null;
  const validation = inc.validation as {
    passed?: boolean;
    checks?: { name: string; detail: string }[];
  } | null;
  const accounting = inc.accounting as Accounting | null;
  const verification = inc.verification as { passed?: boolean } | null;
  const resolved = inc.status === 'resolved';
  const needsYou = inc.status === 'requires_action';
  const facts: { label: string; value: string }[] = [];

  // Change detected
  if (finding) {
    const what = finding.observed.violations.map((v) => labelOf(v.path)).join(' and ');
    const version =
      finding.observed.apiVersion &&
      finding.expected.baseline?.apiVersion &&
      finding.observed.apiVersion !== finding.expected.baseline.apiVersion
        ? ` (format ${finding.expected.baseline.apiVersion} → ${finding.observed.apiVersion})`
        : '';
    facts.push({
      label: 'Change detected',
      value: `Shopify changed the order data it sends${version}: ${what} is no longer where your integration reads it.`,
    });
    facts.push({
      label: 'Why it mattered',
      value: `Orders could have been created in NetSuite without ${what}. We held them instead of writing them.`,
    });
  } else {
    facts.push({ label: 'What happened', value: inc.title });
  }

  // Action taken
  if (correction?.activatedAt && validation?.passed) {
    const rules = correction.rules ?? [];
    const checks = validation.checks ?? [];
    const regression = checks.find((c) => c.name.startsWith('regression'))?.detail.match(/^(\d+)\//)?.[1];
    const source = checks.find((c) => c.name.includes('Shopify Admin API'))?.detail.match(/^(\d+)\//)?.[1];
    facts.push({
      label: 'Action taken',
      value:
        `We updated how your integration reads ${rules.map((r) => labelOf(r.target)).join(' and ')} to match Shopify’s new format. ` +
        `Before switching it on, we confirmed it changes nothing for ${plural(Number(regression ?? 0), 'earlier order')} and gives the same values as Shopify’s own records for ${plural(Number(source ?? 0), 'affected order')}.`,
    });
  } else if (resolved && inc.resolution) {
    facts.push({ label: 'Action taken', value: inc.resolution });
  } else if (!resolved) {
    facts.push({ label: 'Action taken', value: 'In progress.' });
  }

  // Transactions
  if (accounting) {
    const affected =
      accounting.delayed + accounting.failedDuringDisruption + accounting.discoveredByReconciliation;
    const parts = [
      accounting.delayed ? `${accounting.delayed} held safely and delivered after the fix` : null,
      accounting.failedDuringDisruption ? `${accounting.failedDuringDisruption} failed` : null,
      accounting.discoveredByReconciliation
        ? `${accounting.discoveredByReconciliation} never reached us and ${accounting.discoveredByReconciliation === 1 ? 'was' : 'were'} found by checking Shopify directly`
        : null,
    ].filter(Boolean);
    facts.push({
      label: 'Transactions affected',
      value: affected ? `${plural(affected, 'order')}: ${parts.join('; ')}.` : 'None.',
    });
    facts.push({ label: 'Transactions recovered', value: `${accounting.recovered} of ${affected}.` });
    const relevant = accounting.population - accounting.excluded.count;
    facts.push({
      label: 'Final outcome',
      value: accounting.zeroLoss
        ? `All ${plural(relevant, 'order')} created in the affected period are in NetSuite exactly once, with the items, quantities and prices Shopify has for them.`
        : `${accounting.verified} of ${plural(relevant, 'order')} confirmed in NetSuite; ${plural(accounting.unresolved, 'order')} not yet confirmed${accounting.duplicates ? `; ${accounting.duplicates} duplicated` : ''}. We are still working on ${accounting.unresolved === 1 ? 'it' : 'them'}.`,
    });
  } else if (!resolved) {
    facts.push({ label: 'Transactions affected', value: 'Being established.' });
  }

  facts.push({
    label: 'Customer action',
    value: needsYou ? (inc.customerAction ?? 'Required.') : 'None required.',
  });

  const zeroLoss = resolved && verification?.passed === true && accounting?.zeroLoss === true;
  const relevant = accounting ? accounting.population - accounting.excluded.count : 0;
  const summary = resolved
    ? zeroLoss
      ? `We detected a change that threatened order processing. We resolved it and verified all ${plural(relevant, 'order')} from the affected period against NetSuite.`
      : `We resolved this issue.${accounting ? ' Not every order could be confirmed; see the outcome.' : ''}`
    : needsYou
      ? 'We need something from you to continue.'
      : 'We detected this and are handling it. Orders are protected while we work; nothing is needed from you.';

  return {
    id: inc.id,
    integrationId: inc.integrationId!,
    category: (KIND_HEADLINES[inc.kind] ?? { category: 'Other' }).category,
    state: resolved ? 'completed' : needsYou ? 'needs_you' : 'in_progress',
    headline: headlineFor(inc, accounting),
    summary,
    detectedAt: inc.detectedAt.toISOString(),
    resolvedAt: inc.resolvedAt?.toISOString() ?? null,
    facts,
    accounting: accounting
      ? {
          window: accounting.window,
          ordersInWindow: accounting.population,
          deliveredBeforeChange: accounting.deliveredBeforeChange,
          delayed: accounting.delayed,
          failedDuringDisruption: accounting.failedDuringDisruption,
          foundByChecking: accounting.discoveredByReconciliation,
          recovered: accounting.recovered,
          verified: accounting.verified,
          excluded: accounting.excluded.count,
          unresolved: accounting.unresolved,
          duplicates: accounting.duplicates,
        }
      : null,
    claim: {
      zeroLoss,
      statement: zeroLoss ? 'Zero transactions lost.' : null,
      basis: zeroLoss
        ? `Every order Shopify has for ${accounting!.window.from.slice(0, 16).replace('T', ' ')}–${accounting!.window.to.slice(0, 16).replace('T', ' ')} UTC was checked in NetSuite after the fix.`
        : accounting
          ? 'Not claimed: not every order in the affected period is confirmed.'
          : 'Not claimed: transaction accounting is not complete.',
    },
    customerAction: { required: needsYou, text: needsYou ? (inc.customerAction ?? null) : null },
    timeline: events
      .filter((e) => e.customerVisible)
      .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())
      .map((e) => ({ at: e.createdAt.toISOString(), text: e.note })),
  };
}

/* ================================================================== responsibilities */

/** What Managed Integrations is responsible for, per flow — only mechanisms that exist. */
export function responsibilitiesFor(flowType: string, reconcileIntervalMinutes: number | null): string[] {
  const common = [
    'Create each Shopify order in NetSuite exactly once, with the items, quantities and prices from Shopify.',
    `Check Shopify directly${reconcileIntervalMinutes ? ` every ${reconcileIntervalMinutes} minutes` : ''} so an order is never silently missed, and recover any that are.`,
    'Notice when Shopify or NetSuite change in a way that affects your orders, fix the integration, and verify the result.',
    'Tell you what happened and what it meant for your orders. Ask you only when a decision is yours.',
  ];
  return flowType.startsWith('adopted.')
    ? ['Receive every Shopify order notification and keep a durable record of it.', ...common]
    : ['Read new and changed Shopify orders on a schedule.', ...common];
}
