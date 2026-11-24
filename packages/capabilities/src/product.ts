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
import { sourceOf, targetOf, type IntegrationDescriptor } from '@mi/managed';
import type { incidentEvents, incidents, reconciliationRuns } from '@mi/database';

type IncidentRow = typeof incidents.$inferSelect;
type EventRow = typeof incidentEvents.$inferSelect;
type RunRow = typeof reconciliationRuns.$inferSelect;

/* ================================================================== words */

/** The integration's own vocabulary (from its descriptor): every customer sentence uses these. */
export interface Words {
  source: string;
  destination: string;
  one: string;
  many: string;
  record: string;
  businessData: string;
}
export const SHOPIFY_WORDS: Words = {
  source: 'Shopify',
  destination: 'NetSuite',
  one: 'order',
  many: 'orders',
  record: 'sales order',
  businessData: 'items, quantities and prices',
};
export function wordsOf(d: IntegrationDescriptor | undefined): Words {
  return d
    ? {
        source: (sourceOf(d) ?? d.providers[0]!).name,
        destination: (targetOf(d) ?? d.providers.at(-1)!).name,
        one: d.transactions.one,
        many: d.transactions.many,
        record: d.transactions.record,
        businessData: d.transactions.businessData,
      }
    : SHOPIFY_WORDS;
}

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
      'No open issues, and a check completed in the last 24 hours found every transaction accounted for in both systems.',
  },
  checking: {
    label: 'Verification pending',
    definition:
      'No open issues, but there is no completed check from the last 24 hours that accounts for every transaction. We do not call this protected until there is.',
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
  w: Words = SHOPIFY_WORDS,
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
  if (open[0]) return make('maintaining', headlineFor(open[0], null, w), { incidentId: open[0].id });
  if (
    lastResolved?.resolvedAt &&
    lastResolved.verification &&
    now.getTime() - lastResolved.resolvedAt.getTime() < VERIFIED_FOR_MS
  ) {
    return make(
      'verified',
      `${headlineFor(lastResolved, null, w)} on ${lastResolved.resolvedAt.toISOString().slice(0, 10)}.`,
      {
        incidentId: lastResolved.id,
      },
    );
  }
  if (lastCheck?.finishedAt && now.getTime() - lastCheck.finishedAt.getTime() < EVIDENCE_FRESH_MS) {
    if (lastCheck.status === 'completed' && lastCheck.outcome === 'consistent')
      return make('protected', checkSentence(lastCheck, w), { reconciliationRunId: lastCheck.id });
    return make(
      'checking',
      `The most recent check did not account for every ${w.one} yet; we are reviewing it.`,
      {
        reconciliationRunId: lastCheck.id,
      },
    );
  }
  return make('checking', 'No completed check in the last 24 hours.', {});
}

export function checkSentence(run: RunRow, w: Words = SHOPIFY_WORDS): string {
  const n = run.expectedCount ?? run.sourceCount ?? 0;
  return `On ${run.finishedAt!.toISOString().slice(0, 16).replace('T', ' ')} UTC we checked ${n} ${w.one}(s) from ${w.source} against ${w.destination}: all accounted for.`;
}

/* ================================================================== maintenance events */

const KIND_HEADLINES = (w: Words): Record<string, { open: string; done: string; category: string }> => ({
  input_contract_change: {
    open: `We are handling a change in how ${w.source} sends ${w.many}`,
    done: 'We resolved a compatibility issue',
    category: 'Provider change',
  },
  dependency_contract_change: {
    open: 'We are updating your integration for a provider change',
    done: 'We updated your integration for a provider change',
    category: 'Provider change',
  },
  schema_drift: {
    open: `We are handling a change in ${w.source}’s ${w.one} data`,
    done: 'We resolved a compatibility issue',
    category: 'Provider change',
  },
  connection_auth: {
    open: 'A connection needs to be renewed',
    done: 'Your connection was restored',
    category: 'Access',
  },
  records_rejected: {
    open: `Some ${w.many} need information from you`,
    done: `${w.many[0]!.toUpperCase()}${w.many.slice(1)} that needed your input were completed`,
    category: 'Data',
  },
  sync_failure: {
    open: `We are restoring ${w.one} delivery`,
    done: `We restored ${w.one} delivery`,
    category: 'Availability',
  },
  freshness_breach: {
    open: `${w.many[0]!.toUpperCase()}${w.many.slice(1)} are arriving later than usual; we are on it`,
    done: `${w.one[0]!.toUpperCase()}${w.one.slice(1)} delivery is back on time`,
    category: 'Availability',
  },
  reconciliation_discrepancy: {
    open: `We are correcting ${w.many} that did not match`,
    done: `We corrected ${w.many} that did not match`,
    category: 'Accuracy',
  },
});

function headlineFor(inc: IncidentRow, accounting: Accounting | null, w: Words = SHOPIFY_WORDS): string {
  const h = KIND_HEADLINES(w)[inc.kind] ?? { open: inc.title, done: inc.title, category: 'Other' };
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
  /** A question only the customer may answer (slice 7): offered options, in business terms. */
  decision: { id: string; question: string; options: { id: string; label: string; detail?: string }[] } | null;
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
  released: 'Held transactions released',
  recovered: 'Missing transactions recovered',
  reviewing: 'Waiting for an engineer',
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
  // Stripe → QuickBooks (slice 6)
  'regression: stored transactions unchanged': 'Earlier transactions unaffected',
  'destination request changes only as reviewed': 'Only the reviewed difference',
  'business data preserved (QuickBooks)': 'Matches the entries in your books',
  'QuickBooks authorized again by the customer': 'Reconnected by you',
  'Stripe authorized again by the customer': 'Reconnected by you',
  'token refresh works with the new authorization': 'Connection renews itself',
  'QuickBooks company reachable': 'Your books are reachable',
  'Stripe reachable': 'Stripe is reachable',
};

/** Customer-safe details for a timeline step, from that step's persisted evidence and the event's facts. */
function stepDetails(
  step: string,
  ev: Record<string, unknown>,
  finding: Finding | null,
  w: Words = SHOPIFY_WORDS,
): { label: string; value: string }[] {
  const n = (k: string) => (typeof ev[k] === 'number' ? (ev[k] as number) : null);
  switch (step) {
    case 'noticed': {
      if (!finding) return [];
      const from = finding.expected.baseline?.apiVersion;
      const to = finding.observed.apiVersion;
      return [
        ...(from && to && from !== to
          ? [{ label: `${w.source} data format`, value: `${from} → ${to}` }]
          : []),
        { label: 'What moved', value: finding.observed.violations.map((v) => labelOf(v.path)).join(', ') },
        {
          label: `${w.many[0]!.toUpperCase()}${w.many.slice(1)} written incorrectly`,
          value: `None: affected ${w.many} were held`,
        },
      ];
    }
    case 'investigated':
      return n('heldOrders') != null
        ? [
            {
              label: `${w.many[0]!.toUpperCase()}${w.many.slice(1)} held safely`,
              value: String(n('heldOrders')),
            },
          ]
        : [];
    case 'released':
      return n('released') != null ? [{ label: 'Released', value: String(n('released')) }] : [];
    case 'recovered':
      return n('missing') != null
        ? [{ label: 'Found by checking directly', value: String(n('missing')) }]
        : [];
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
        ? [{ label: `Delivered to ${w.destination}`, value: `${n('delivered')} of ${n('held')}` }]
        : [];
    case 'checked':
      return n('checked') != null
        ? [
            {
              label: `${w.many[0]!.toUpperCase()}${w.many.slice(1)} in the affected period`,
              value: String(n('checked')),
            },
            { label: 'Never reached us (recovered)', value: String(n('missing') ?? 0) },
          ]
        : [];
    case 'verified':
      return n('verified') != null
        ? [
            {
              label: `${w.many[0]!.toUpperCase()}${w.many.slice(1)} verified in ${w.destination}`,
              value: String(n('verified')),
            },
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

type AuthFinding = { kind: 'authorization_lost'; providers: { provider: string; state: string }[] };
type DependencyFinding = { provider: string; contract: string; declared: string; served: string };
type StripeInputFinding = { provider: 'stripe'; field: string };

/** "Change detected" and "Why it mattered", from whichever finding this event persisted. */
function findingFacts(inc: IncidentRow, w: Words): { label: string; value: string }[] {
  const f = inc.finding as Record<string, unknown> | null;
  if (!f) return [{ label: 'What happened', value: inc.title }];
  if ((f as AuthFinding).kind === 'authorization_lost') {
    const names = (f as AuthFinding).providers.map((p) =>
      p.provider === 'quickbooks' ? 'QuickBooks' : p.provider === 'stripe' ? 'Stripe' : p.provider,
    );
    return [
      {
        label: 'Change detected',
        value: `Our access to ${names.join(' and ')} stopped working (${(f as AuthFinding).providers.map((p) => p.state).join(', ')}).`,
      },
      {
        label: 'Why it mattered',
        value: `${w.many[0]!.toUpperCase()}${w.many.slice(1)} could not reach ${w.destination}. We held them safely instead of losing them.`,
      },
    ];
  }
  if ('declared' in f && 'served' in f) {
    const d = f as unknown as DependencyFinding;
    return [
      {
        label: 'Change detected',
        value: `${w.destination} retired the API version your integration asks for (${d.declared}); it answers with version ${d.served}.`,
      },
      {
        label: 'Why it mattered',
        value: `Nothing was wrong in your books. Left alone, your integration would depend on a version ${w.destination} no longer supports.`,
      },
    ];
  }
  if ((f as StripeInputFinding).provider === 'stripe' && 'field' in f) {
    return [
      {
        label: 'Change detected',
        value: `${w.source} sent data without what your integration reads (${(f as StripeInputFinding).field}).`,
      },
      {
        label: 'Why it mattered',
        value: `Those ${w.many} could have been written incorrectly. We held them instead of writing them.`,
      },
    ];
  }
  if (Array.isArray(f['contracts']) && Array.isArray(f['mismatches'])) {
    // a provider an application depends on changed what it sends (slice 7)
    const fields = [...new Set((f['mismatches'] as { field: string }[]).map((m) => m.field))];
    return [
      { label: 'Change detected', value: `${w.source} now sends some details in a different place (API version ${String((f['observed'] as { apiVersion?: string } | undefined)?.apiVersion ?? 'changed')}).` },
      { label: 'Why it mattered', value: `Your application kept working but recorded ${fields.length === 1 ? 'one detail' : `${fields.length} details`} incorrectly. Nothing was lost: we correct the records from ${w.source} itself.` },
    ];
  }
  if (f['upstream'] && Array.isArray(f['dependencyChanges'])) {
    const up = f['upstream'] as { to?: { version?: string } };
    return [
      { label: 'What changed', value: `A new version (${up.to?.version ?? 'new'}) of your application was released.` },
      { label: 'Why it matters', value: 'We check exactly what changed and test it with your own requests before switching. Nothing changes for you until then.' },
    ];
  }
  if (Array.isArray(f['inactiveAccounts'])) {
    const names = (f['inactiveAccounts'] as { name: string }[]).map((a) => a.name).join(', ');
    return [
      { label: 'Change detected', value: `An account in ${w.destination} that your entries post to (${names}) was made inactive, so ${w.destination} stopped accepting them.` },
      { label: 'Why it mattered', value: `Those ${w.many} could not be recorded. We held them safely instead of losing them.` },
    ];
  }
  if (Array.isArray(f['journalEntryIds'])) {
    return [
      { label: 'Change detected', value: `${w.destination} accepted entries we wrote, but now keeps different accounts or amounts for them.` },
      { label: 'Why it mattered', value: `Your books may not match ${w.source} for these ${w.many}. We have not changed anything in ${w.destination}.` },
    ];
  }
  if (f['provider'] === 'netsuite' && f['requiredField']) {
    return [
      { label: 'Change detected', value: `${w.destination} now requires a ${String(f['requiredField']).toLowerCase()} on every ${w.record}, which your integration did not send.` },
      { label: 'Why it mattered', value: `${w.destination} refused those ${w.many}. We held them safely instead of losing them.` },
    ];
  }
  if (!Array.isArray((f['observed'] as { violations?: unknown } | undefined)?.violations)) return [{ label: 'What happened', value: inc.customerSummary ?? inc.title }];
  const finding = f as unknown as Finding;
  const what = finding.observed.violations.map((v) => labelOf(v.path)).join(' and ');
  const version =
    finding.observed.apiVersion &&
    finding.expected.baseline?.apiVersion &&
    finding.observed.apiVersion !== finding.expected.baseline.apiVersion
      ? ` (format ${finding.expected.baseline.apiVersion} → ${finding.observed.apiVersion})`
      : '';
  const precision = finding.observed.violations.every((v) => v.observed === 'precision');
  return [
    {
      label: 'Change detected',
      value: precision
        ? `${w.source} sent ${w.many} where ${what} has more decimal places than your integration keeps.`
        : `${w.source} changed the ${w.one} data it sends${version}: ${what} is no longer where your integration reads it.`,
    },
    {
      label: 'Why it mattered',
      value: precision
        ? `Those ${w.many} would have reached ${w.destination} with rounded amounts. We held them instead of writing them.`
        : `${w.many[0]!.toUpperCase()}${w.many.slice(1)} could have been created in ${w.destination} without ${what}. We held them instead of writing them.`,
    },
  ];
}

/** A maintenance event as the customer sees it — derived entirely from persisted facts. */
export interface PendingDecision {
  id: string;
  question: string;
  options: { id: string; label: string; detail?: string }[];
}

export function presentEvent(
  inc: IncidentRow,
  events: EventRow[],
  w: Words = SHOPIFY_WORDS,
  pendingDecision: PendingDecision | null = null,
): CustomerEvent {
  const finding = (inc.finding as Record<string, unknown> | null) ?? null;
  const shopifyFinding =
    finding && Array.isArray((finding['observed'] as { violations?: unknown } | undefined)?.violations)
      ? (finding as unknown as Finding)
      : null;
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
  const facts: { label: string; value: string }[] = [...findingFacts(inc, w)];
  const plain = (n: number) => plural(n, w.one, w.many);

  // Action taken
  if (correction?.activatedAt && validation?.passed) {
    const checks = validation.checks ?? [];
    const count = (pred: (n: string) => boolean) =>
      checks.find((c) => pred(c.name))?.detail.match(/^(\d+)\//)?.[1];
    const regression = count((n) => n.startsWith('regression'));
    let text: string;
    if (correction.kind === 'reauthorization') {
      text = `You reconnected ${w.destination}. Before sending anything, we confirmed the new connection works and renews itself.`;
    } else if (shopifyFinding) {
      const source = count((n) => n.includes('Shopify Admin API'));
      const rules = correction.rules ?? [];
      text =
        (correction.kind === 'patch'
          ? `We corrected how your integration handles ${shopifyFinding.observed.violations.map((v) => labelOf(v.path)).join(' and ') || 'this data'}, so it keeps exactly what ${w.source} sends. `
          : `We updated how your integration reads ${rules.map((r) => labelOf(r.target)).join(' and ')} to match ${w.source}’s new format. `) +
        `Before switching it on, we confirmed it changes nothing for ${plural(Number(regression ?? 0), `earlier ${w.one}`)} and gives the same values as ${w.source}’s own records for ${plural(Number(source ?? 0), `affected ${w.one}`)}.`;
    } else {
      const books = count((n) => n.startsWith('business data preserved'));
      text =
        regression === undefined
          ? `We updated your ${inc.kind === 'provider_contract_change' || inc.kind === 'application_change' ? 'application' : 'integration'} with a reviewed change, tested with your own data before switching it on.`
          : `We updated your integration with a reviewed change. Before switching it on, we confirmed it changes nothing for ${plural(Number(regression), `earlier ${w.one}`)}` +
            (books ? ` and matches the ${plural(Number(books), `${w.record}`)} already in ${w.destination}.` : '.');
    }
    facts.push({ label: 'Action taken', value: text });
  } else if (resolved && inc.resolution) {
    facts.push({ label: 'Action taken', value: inc.resolution });
  } else if (!resolved) {
    facts.push({ label: 'Action taken', value: needsYou ? 'Waiting for you.' : 'In progress.' });
  }

  // Transactions
  if (accounting) {
    const affected =
      accounting.delayed + accounting.failedDuringDisruption + accounting.discoveredByReconciliation;
    const parts = [
      accounting.delayed ? `${accounting.delayed} held safely and delivered after the fix` : null,
      accounting.failedDuringDisruption ? `${accounting.failedDuringDisruption} failed` : null,
      accounting.discoveredByReconciliation
        ? `${accounting.discoveredByReconciliation} never reached us and ${accounting.discoveredByReconciliation === 1 ? 'was' : 'were'} found by checking ${w.source} directly`
        : null,
    ].filter(Boolean);
    facts.push({
      label: 'Transactions affected',
      value: affected ? `${plain(affected)}: ${parts.join('; ')}.` : 'None.',
    });
    facts.push({ label: 'Transactions recovered', value: `${accounting.recovered} of ${affected}.` });
    const relevant = accounting.population - accounting.excluded.count;
    facts.push({
      label: 'Final outcome',
      value: accounting.zeroLoss
        ? `All ${plain(relevant)} created in the affected period are in ${w.destination} exactly once, with the ${w.businessData} ${w.source} has for them.`
        : `${accounting.verified} of ${plain(relevant)} confirmed in ${w.destination}; ${plain(accounting.unresolved)} not yet confirmed${accounting.duplicates ? `; ${accounting.duplicates} duplicated` : ''}. We are still working on ${accounting.unresolved === 1 ? 'it' : 'them'}.`,
    });
  } else if (!resolved) {
    facts.push({
      label: 'Transactions affected',
      value: needsYou ? `Held safely until you act.` : 'Being established.',
    });
  }

  facts.push({
    label: 'Customer action',
    value: needsYou ? (inc.customerAction ?? 'Required.') : 'None required.',
  });

  const zeroLoss = resolved && verification?.passed === true && accounting?.zeroLoss === true;
  const relevant = accounting ? accounting.population - accounting.excluded.count : 0;
  const summary = resolved
    ? zeroLoss
      ? `We detected a change that threatened ${w.one} processing. We resolved it and verified all ${plain(relevant)} from the affected period against ${w.destination}.`
      : `We resolved this issue.${accounting ? ` Not every ${w.one} could be confirmed; see the outcome.` : ''}`
    : needsYou
      ? 'We need something from you to continue.'
      : `We detected this and are handling it. ${w.many[0]!.toUpperCase()}${w.many.slice(1)} are protected while we work; nothing is needed from you.`;

  return {
    id: inc.id,
    integrationId: inc.integrationId!,
    category: (KIND_HEADLINES(w)[inc.kind] ?? { category: 'Other' }).category,
    state: resolved ? 'completed' : needsYou ? 'needs_you' : 'in_progress',
    headline: headlineFor(inc, accounting, w),
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
        ? `Every ${w.one} ${w.source} has for the affected period (${windowText(accounting!.window)}) was checked in ${w.destination} after the fix.`
        : accounting
          ? `Not claimed: not every ${w.one} in the affected period is confirmed.`
          : 'Not claimed: transaction accounting is not complete.',
    },
    customerAction: { required: needsYou, text: needsYou ? (inc.customerAction ?? null) : null },
    decision: !resolved ? pendingDecision : null,
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
          details: stepDetails(step, ev, shopifyFinding, w),
        };
      }),
  };
}

/* ================================================================== responsibilities */

/** What Managed Integrations is responsible for, per integration — only mechanisms that exist. */
export function responsibilitiesFor(
  flowType: string,
  reconcileIntervalMinutes: number | null,
  d?: IntegrationDescriptor,
): string[] {
  if (d?.responsibilities)
    return [
      ...d.responsibilities.maintain,
      `Check ${d.providers.length > 1 ? d.providers.map((x) => x.name).join(' against ') : `${d.providers[0]!.name} against what your application recorded`}${reconcileIntervalMinutes ? ` every ${reconcileIntervalMinutes} minutes` : ''} so nothing is silently missed.`,
      `Tell you what happened and what it meant for your ${d.transactions.many}. Ask you only when a decision is yours.`,
    ];
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
