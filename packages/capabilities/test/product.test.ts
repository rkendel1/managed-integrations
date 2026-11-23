/**
 * Pure rules of the customer product: status definitions and the claims a maintenance event may make.
 * Rows are built in memory with the shapes the database returns.
 */
import { describe, expect, it } from 'vitest';
import type { incidents, reconciliationRuns } from '@mi/database';
import { assessStatus, presentEvent, windowText } from '../src/product.ts';

type Inc = typeof incidents.$inferSelect;
type Run = typeof reconciliationRuns.$inferSelect;
const now = new Date('2026-11-23T12:00:00Z');
const ago = (h: number) => new Date(now.getTime() - h * 3600_000);

const inc = (over: Partial<Inc> = {}): Inc =>
  ({
    id: '00000000-0000-4000-8000-000000000001',
    tenantId: 't',
    integrationId: 'i',
    kind: 'input_contract_change',
    status: 'resolved',
    severity: 'high',
    title: 'Shopify order data changed shape',
    reason: 'r',
    errorClass: null,
    dedupeKey: 'k',
    affectedScope: {},
    impact: null,
    customerSummary: null,
    customerAction: null,
    evidence: {},
    implementationVersionId: null,
    resolution: 'fixed',
    verification: { passed: true },
    finding: null,
    investigation: null,
    correction: null,
    validation: null,
    accounting: null,
    detectedAt: ago(5),
    resolvedAt: ago(1),
    createdAt: ago(5),
    updatedAt: ago(1),
    ...over,
  }) as Inc;
const run = (over: Partial<Run> = {}): Run =>
  ({
    id: 'run',
    status: 'completed',
    outcome: 'consistent',
    finishedAt: ago(2),
    expectedCount: 12,
    sourceCount: 12,
    ...over,
  }) as Run;
const accounting = (over: Record<string, unknown> = {}) => ({
  window: { from: ago(6).toISOString(), to: ago(2).toISOString() },
  sourceRunId: 'r',
  population: 4,
  populationComplete: true,
  deliveredBeforeChange: 1,
  delayed: 2,
  failedDuringDisruption: 0,
  discoveredByReconciliation: 1,
  recovered: 3,
  verified: 4,
  excluded: { count: 0, reasons: {} },
  unresolved: 0,
  duplicates: 0,
  orders: [],
  zeroLoss: true,
  computedAt: ago(1).toISOString(),
  ...over,
});

describe('customer status rules', () => {
  it('protected needs a completed, consistent check from the last 24 hours', () => {
    expect(assessStatus([], undefined, run(), now).code).toBe('protected');
    expect(assessStatus([], undefined, run({ finishedAt: ago(30) }), now).code).toBe('checking');
    expect(assessStatus([], undefined, run({ outcome: 'discrepancies' }), now).code).toBe('checking');
    expect(assessStatus([], undefined, run({ outcome: 'partial', status: 'failed' }), now).code).toBe(
      'checking',
    );
    expect(assessStatus([], undefined, undefined, now).code).toBe('checking');
  });
  it('an open issue needing the customer wins; any other open issue is maintenance', () => {
    const open = [
      inc({ status: 'investigating' }),
      inc({ status: 'requires_action', customerAction: 'Add a SKU mapping' }),
    ];
    expect(assessStatus(open, undefined, run(), now)).toMatchObject({
      code: 'customer_action',
      reason: 'Add a SKU mapping',
    });
    expect(assessStatus([inc({ status: 'recovery' })], undefined, run(), now).code).toBe('maintaining');
  });
  it('verified only for 7 days after a resolution that has verification evidence', () => {
    expect(assessStatus([], inc(), run(), now).code).toBe('verified');
    expect(assessStatus([], inc({ resolvedAt: ago(8 * 24) }), run(), now).code).toBe('protected');
    expect(assessStatus([], inc({ verification: null }), undefined, now).code).toBe('checking');
  });
  it('every status carries its definition', () => {
    const s = assessStatus([], undefined, run(), now);
    expect(s.definition).toMatch(/last 24 hours/);
    expect(s.label).toBe('Protected');
  });
});

describe('maintenance event claims (tests 16, 17)', () => {
  it('a proven outcome yields the zero-loss statement', () => {
    const ev = presentEvent(inc({ accounting: accounting() }), []);
    expect(ev.claim).toMatchObject({ zeroLoss: true, statement: 'Zero transactions lost.' });
  });
  it('one unresolved order prevents the claim and says so', () => {
    const ev = presentEvent(
      inc({ accounting: accounting({ unresolved: 1, verified: 3, zeroLoss: false }) }),
      [],
    );
    expect(ev.claim).toMatchObject({ zeroLoss: false, statement: null });
    expect(ev.headline).toMatch(/with exceptions/);
    expect(ev.facts.find((f) => f.label === 'Final outcome')!.value).toMatch(
      /^3 of 4 orders confirmed in NetSuite; 1 order not yet confirmed/,
    );
  });
  it('no claim without accounting, without verification, or before resolution', () => {
    expect(presentEvent(inc(), []).claim.zeroLoss).toBe(false);
    expect(
      presentEvent(inc({ accounting: accounting(), verification: { passed: false } }), []).claim.zeroLoss,
    ).toBe(false);
    expect(
      presentEvent(inc({ accounting: accounting(), status: 'verification', resolvedAt: null }), []).claim
        .zeroLoss,
    ).toBe(false);
  });
  it('an incomplete population can never be presented as zero loss, even if a stored flag said so', () => {
    // presentEvent trusts only zeroLoss computed by the accounting, which requires a complete population;
    // a row claiming zeroLoss with an incomplete population is still refused at resolution (transitionIncident).
    const ev = presentEvent(
      inc({ accounting: accounting({ populationComplete: false, zeroLoss: false }) }),
      [],
    );
    expect(ev.claim.zeroLoss).toBe(false);
  });
  it('only customer-visible timeline entries are shown', () => {
    const e = (note: string, customerVisible: boolean, at: number) =>
      ({
        id: note,
        incidentId: 'x',
        fromStatus: null,
        toStatus: 'investigating',
        actor: 'system',
        note,
        customerVisible,
        evidence: {},
        createdAt: ago(at),
      }) as never;
    const ev = presentEvent(inc({ status: 'investigating', resolvedAt: null }), [
      e('internal escalation', false, 2),
      e('Investigated', true, 3),
    ]);
    expect(ev.timeline.map((t) => t.text)).toEqual(['Investigated']);
  });
});

describe('window wording', () => {
  it('shows the date once and seconds for short windows', () => {
    expect(windowText({ from: '2026-11-23T21:57:07Z', to: '2026-11-23T21:57:53Z' })).toBe(
      '23 Nov 2026, 21:57:07–21:57:53 UTC',
    );
    expect(windowText({ from: '2026-11-22T20:00:00Z', to: '2026-11-23T08:30:00Z' })).toBe(
      '22 Nov 2026 20:00 – 23 Nov 2026 08:30 UTC',
    );
  });
});
