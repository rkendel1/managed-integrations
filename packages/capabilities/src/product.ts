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
  timeline: TimelineItem[];
}

/** One step of the customer timeline. `details` are shown only when the customer expands the step. */
export interface TimelineItem {
  at: string;
  step: string;
  title: string;
  text: string;
  details: { label: string; value: string }[];
}

const STEP_TITLES: Record<string, string> = {
  noticed: 'Change detected',
  investigated: 'Investigated',
  tested: 'Fix tested',
  switched_on: 'Fix switched on',
  delivered: 'Held orders delivered',
  checked: 'Every order checked',
  verifying: 'Verifying',
  verified: 'Verified',
};
const STATUS_TITLES: Record<string, string> = {
  detected: 'Detected',
  classified: 'Assessed',
  investigating: 'Investigating',
  recoverable: 'Recovering',
  recovery: 'Recovering',
  verification: 'Verifying',
  requires_action: 'Waiting for you',
  resolved: 'Resolved',
};
const CHECK_LABELS: Record<string, string> = {
  'applies to the adopted artifact': 'Fits your integration’s software',
  'original adopted code unchanged': 'Integration software unchanged',
  'patch reproduces the reviewed change exactly': 'Exactly the reviewed fix',
  'regression: stored orders unchanged': 'Earlier orders unaffected',
  'affected orders handled': 'Held orders read correctly',
  'business data preserved (Shopify Admin API)': 'Matches Shopify’s own records',
  'no conflicting data accepted': 'No conflicting data',
  'rollback target available': 'Can be undone safely',
  // slice-4 names (events recorded before slice 5)
  'upstream unmodified': 'Integration software unchanged',
  'regression: baseline orders unchanged': 'Earlier orders unaffected',
  'changed inputs map correctly': 'Held orders read correctly',
  'mapped values match Shopify Admin API': 'Matches Shopify’s own records',
};

/** Customer-safe details for a timeline step, from that step's persisted evidence and the event's facts. */
function stepDetails(
  step: string,
  ev: Record<string, unknown>,
  finding: Finding | null,
): { label: string; value: string }[] {
  const n = (k: string) => (typeof ev[k] === 'number' ? (ev[k] as number) : null);
  switch (step) {
    case 'noticed': {
      if (!finding) return [];
      const from = finding.expected.baseline?.apiVersion;
      const to = finding.observed.apiVersion;
      return [
        ...(from && to && from !== to ? [{ label: 'Shopify data format', value: `${from} → ${to}` }] : []),
        { label: 'What moved', value: finding.observed.violations.map((v) => labelOf(v.path)).join(', ') },
        { label: 'Orders written incorrectly', value: 'None: affected orders were held' },
      ];
    }
    case 'investigated':
      return n('heldOrders') != null ? [{ label: 'Orders held safely', value: String(n('heldOrders')) }] : [];
    case 'tested':
      return (
        (ev['checks'] as { name: string; passed?: boolean; status?: string; detail: string }[] | undefined) ??
        []
      )
        .filter((c) => c.name !== 'problems')
        .map((c) => {
          const count = c.detail.match(/^(\d+)\/(\d+)/);
          const status = c.status ?? (c.passed ? 'passed' : 'failed'); // slice-4 records used `passed`
          return {
            label: CHECK_LABELS[c.name] ?? c.name,
            value: `${status === 'passed' ? 'Passed' : status === 'failed' ? 'Failed' : 'Not applicable'}${count ? ` (${count[1]} of ${count[2]})` : ''}`,
          };
        });
    case 'delivered':
      return n('held') != null
        ? [{ label: 'Delivered to NetSuite', value: `${n('delivered')} of ${n('held')}` }]
        : [];
    case 'checked':
      return n('checked') != null
        ? [
            { label: 'Orders in the affected period', value: String(n('checked')) },
            { label: 'Never reached us (recovered)', value: String(n('missing') ?? 0) },
          ]
        : [];
    case 'verified':
      return n('verified') != null
        ? [
            { label: 'Orders verified in NetSuite', value: String(n('verified')) },
            { label: 'Duplicates', value: String(n('duplicates') ?? 0) },
          ]
        : [];
    default:
      return [];
  }
}

/** A compact, human time window: "23 Nov 2026, 21:57:07–21:57:53 UTC" (date shown once when it is the same day). */
export function windowText(w: { from: string; to: string }): string {
  const f = new Date(w.from);
  const t = new Date(w.to);
  const day = (d: Date) =>
    d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const time = (d: Date, sec: boolean) =>
    d.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      ...(sec ? { second: '2-digit' } : {}),
      timeZone: 'UTC',
    });
  const sec = t.getTime() - f.getTime() < 3600_000;
  return day(f) === day(t)
    ? `${day(f)}, ${time(f, sec)}–${time(t, sec)} UTC`
    : `${day(f)} ${time(f, false)} – ${day(t)} ${time(t, false)} UTC`;
}

/** A maintenance event as the customer sees it — derived entirely from persisted facts. */
export function presentEvent(inc: IncidentRow, events: EventRow[]): CustomerEvent {
  const finding = inc.finding as Finding | null;
  const correction = inc.correction as {
    kind?: string;
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
    const precision = finding.observed.violations.every((v) => v.observed === 'precision');
    facts.push({
      label: 'Change detected',
      value: precision
        ? `Shopify sent orders where ${what} has more decimal places than your integration keeps.`
        : `Shopify changed the order data it sends${version}: ${what} is no longer where your integration reads it.`,
    });
    facts.push({
      label: 'Why it mattered',
      value: precision
        ? 'Those orders would have reached NetSuite with rounded amounts. We held them instead of writing them.'
        : `Orders could have been created in NetSuite without ${what}. We held them instead of writing them.`,
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
    const what =
      correction.kind === 'patch'
        ? `We corrected how your integration handles ${(finding?.observed.violations ?? []).map((v) => labelOf(v.path)).join(' and ') || 'this data'}, so it keeps exactly what Shopify sends. `
        : `We updated how your integration reads ${rules.map((r) => labelOf(r.target)).join(' and ')} to match Shopify’s new format. `;
    facts.push({
      label: 'Action taken',
      value:
        what +
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
        ? `Every order Shopify has for the affected period (${windowText(accounting!.window)}) was checked in NetSuite after the fix.`
        : accounting
          ? 'Not claimed: not every order in the affected period is confirmed.'
          : 'Not claimed: transaction accounting is not complete.',
    },
    customerAction: { required: needsYou, text: needsYou ? (inc.customerAction ?? null) : null },
    timeline: events
      .filter((e) => e.customerVisible)
      .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())
      .map((e) => {
        const ev = (e.evidence ?? {}) as Record<string, unknown>;
        const step = typeof ev['step'] === 'string' ? (ev['step'] as string) : e.toStatus;
        return {
          at: e.createdAt.toISOString(),
          step,
          title: STEP_TITLES[step] ?? STATUS_TITLES[e.toStatus] ?? 'Update',
          text: e.note,
          details: stepDetails(step, ev, finding),
        };
      }),
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
