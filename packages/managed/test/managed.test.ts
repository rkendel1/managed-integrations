/**
 * The generic mechanisms on their own (slice 6): the zero-loss rule refuses incomplete evidence, the correction
 * lifecycle refuses unsafe activations and a rollback whose previous runtime does not load, onboarding rules,
 * and monitoring that records durable facts only when a signal changes.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { adaptations, integrations, observations, tenants, type DbHandle } from '@mi/database';
import {
  accountTransactions,
  activateAdaptation,
  confidenceOf,
  discoveryOutcome,
  evaluateSignals,
  monitorIntegration,
  overallStatus,
  recordAdaptation,
  recordValidation,
  rollbackAdaptation,
  startValidation,
  type IntegrationDescriptor,
  type PopulationItem,
  type Probe,
} from '@mi/managed';
import { freshDb } from '../../../test/support/harness.ts';

const item = (id: string, over: Partial<PopulationItem> = {}): PopulationItem => ({
  sourceId: id,
  label: id,
  reference: id,
  excluded: null,
  delivered: true,
  discovered: false,
  attemptOutcomes: ['delivered'],
  deliveredAt: new Date(),
  verification: { verified: true, records: 1, detail: 'ok' },
  ...over,
});
const base = { window: { from: new Date(0), to: new Date() }, sourceRunId: 'r', detectedAt: new Date(0) };

describe('transaction accounting: a zero-loss claim needs complete, non-empty, independently verified evidence', () => {
  it('claims zero loss only for a complete, verified population', () => {
    const a = accountTransactions({
      ...base,
      readCompletely: true,
      items: [item('a'), item('b', { attemptOutcomes: ['held', 'delivered'] })],
      affectedSourceIds: ['b'],
    });
    expect(a).toMatchObject({ zeroLoss: true, population: 2, delayed: 1, verified: 2, unresolved: 0 });
  });
  it.each([
    ['an empty population', { readCompletely: true, items: [], affectedSourceIds: [] }],
    ['a partially read population', { readCompletely: false, items: [item('a')], affectedSourceIds: [] }],
    [
      'an affected transaction missing from the population',
      { readCompletely: true, items: [item('a')], affectedSourceIds: ['x'] },
    ],
    [
      'an unverified transaction',
      {
        readCompletely: true,
        items: [item('a', { verification: { verified: false, records: 0, detail: 'not found' } })],
        affectedSourceIds: [],
      },
    ],
    [
      'a duplicate at the destination',
      {
        readCompletely: true,
        items: [item('a', { verification: { verified: true, records: 2, detail: '2' } })],
        affectedSourceIds: [],
      },
    ],
    [
      'only excluded transactions',
      { readCompletely: true, items: [item('a', { excluded: 'out of scope' })], affectedSourceIds: [] },
    ],
  ])('refuses the claim with %s', (_n, input) => {
    expect(accountTransactions({ ...base, ...input }).zeroLoss).toBe(false);
  });
});

describe('onboarding rules', () => {
  it('confidence, outcome and the customer’s overall position follow fixed rules', () => {
    expect(confidenceOf(5, 5)).toBe('established');
    expect(confidenceOf(2, 2)).toBe('partial');
    expect(confidenceOf(4, 6)).toBe('partial');
    const c = (kind: 'adoptable' | 'unsupported' | 'new') => ({
      id: kind,
      kind,
      title: '',
      summary: '',
      implementation: null,
      confidence: null,
      evidence: {},
    });
    expect(discoveryOutcome([c('adoptable')])).toBe('found');
    expect(discoveryOutcome([c('adoptable'), c('unsupported')])).toBe('ambiguous');
    expect(discoveryOutcome([c('unsupported')])).toBe('unsupported');
    expect(discoveryOutcome([])).toBe('not_found');
    expect(overallStatus([{ status: 'managed' }, { status: 'confirm' }])).toBe('confirm');
    expect(overallStatus([{ status: 'managed' }, { status: 'activating' }])).toBe('activating');
    expect(overallStatus([])).toBe('connect');
  });
});

let dbh: DbHandle;
afterEach(async () => {
  await dbh?.close();
});
async function integration() {
  dbh = await freshDb();
  const [t] = await dbh.db
    .insert(tenants)
    .values({ name: 'T', slug: `t-${randomBytes(3).toString('hex')}`, lifecycle: 'active' })
    .returning();
  const [i] = await dbh.db
    .insert(integrations)
    .values({
      tenantId: t!.id,
      flowType: 'test.flow',
      contractVersion: '1.0.0',
      config: {},
      enabled: true,
      lifecycle: 'active',
    })
    .returning();
  return i!;
}
const proposal = (integrationId: string, spec: Record<string, unknown> = { x: 1 }) => ({
  integrationId,
  kind: 'patch' as const,
  artifact: { commit: 'c' },
  dependency: {},
  codePath: {},
  spec,
  rationale: 'test',
  actor: 'operator:test',
});

describe('correction lifecycle (generic)', () => {
  it('failed validation rejects; limited validation needs a decision; one active correction per scope', async () => {
    const i = await integration();
    const db = dbh.db;
    const hooks = { scopeKey: () => 'p:file', loadRuntime: async () => undefined };
    // failed validation → rejected, never activatable
    const bad = await recordAdaptation(db, proposal(i.id));
    await startValidation(db, bad.id);
    const rejected = await recordValidation(
      db,
      bad.id,
      [{ name: 'applies', status: 'failed', detail: 'base hash differs' }],
      { before: 'a', after: 'b' },
    );
    expect(rejected.status).toBe('rejected');
    await expect(activateAdaptation(db, bad.id, 'operator:test', 'x', hooks)).rejects.toThrow(
      /Only a validated/,
    );
    // limited validation → decision required
    const lim = await recordAdaptation(db, proposal(i.id));
    await startValidation(db, lim.id);
    await recordValidation(
      db,
      lim.id,
      [{ name: 'regression', status: 'not_applicable', detail: 'nothing stored' }],
      { before: 'a', after: 'b' },
    );
    await expect(activateAdaptation(db, lim.id, 'operator:test', 'x', hooks)).rejects.toThrow(
      /explicit decision/,
    );
    await activateAdaptation(db, lim.id, 'operator:test', 'x', hooks, { acceptLimitations: true });
    // a second correction of the same scope is refused (duplicate activation)
    const dup = await recordAdaptation(db, proposal(i.id, { x: 2 }));
    await startValidation(db, dup.id);
    await recordValidation(db, dup.id, [{ name: 'ok', status: 'passed', detail: '' }], {
      before: 'a',
      after: 'b',
    });
    await expect(activateAdaptation(db, dup.id, 'operator:test', 'x', hooks)).rejects.toThrow(
      /same behaviour \(p:file\)/,
    );
    // a correction whose runtime does not load is never switched on
    await expect(
      activateAdaptation(db, dup.id, 'operator:test', 'x', {
        scopeKey: (r) => r.id,
        loadRuntime: async () => {
          throw new Error('patch does not apply');
        },
      }),
    ).rejects.toThrow(/patch does not apply/);
  });

  it('failed rollback: when the previous runtime does not load, the correction stays active', async () => {
    const i = await integration();
    const db = dbh.db;
    const row = await recordAdaptation(db, proposal(i.id));
    await startValidation(db, row.id);
    await recordValidation(db, row.id, [{ name: 'ok', status: 'passed', detail: '' }], {
      before: 'a',
      after: 'b',
    });
    await activateAdaptation(db, row.id, 'operator:test', 'on', {
      scopeKey: () => 'k',
      loadRuntime: async () => undefined,
    });
    await expect(
      rollbackAdaptation(db, row.id, 'operator:test', 'drill', {
        loadRuntime: async () => {
          throw new Error('installed upstream differs from the pin');
        },
      }),
    ).rejects.toThrow(/Rollback refused.*stays active/);
    const [after] = await db.select().from(adaptations).where(eq(adaptations.id, row.id));
    expect(after!.status).toBe('active');
    await rollbackAdaptation(db, row.id, 'operator:test', 'drill', { loadRuntime: async () => undefined });
    const [done] = await db.select().from(adaptations).where(eq(adaptations.id, row.id));
    expect(done!.status).toBe('rolled_back');
    expect((done!.history as { to: string }[]).map((h) => h.to)).toEqual([
      'proposed',
      'validating',
      'validated',
      'active',
      'rolled_back',
    ]);
  });
});

const DESCRIPTOR: IntegrationDescriptor = {
  flowType: 'test.flow',
  name: 'Test',
  process: 'p',
  source: { id: 'stripe', name: 'Stripe' },
  destination: { id: 'quickbooks', name: 'QuickBooks' },
  transactions: { one: 'transaction', many: 'transactions', record: 'entry', businessData: 'amounts' },
  adopted: null,
  execution: { trigger: '', idempotency: '' },
  dependencies: [],
  capabilities: {
    discovery: null,
    monitoring: [
      { signal: 'source_available', method: '' },
      { signal: 'destination_available', method: '' },
      { signal: 'credentials', method: '' },
      { signal: 'destination_verification', method: '' },
    ],
    recovery: '',
    verification: '',
    corrections: [],
  },
  limitations: [],
  responsibilities: null,
};
const probe = (over: Partial<Probe> = {}): Probe => ({
  source: { available: true, detail: 'ok' },
  destination: { available: true, detail: 'ok' },
  credentials: [{ provider: 'quickbooks', state: 'valid', detail: 'ok' }],
  recentSourceActivity: null,
  ...over,
});

describe('monitoring (generic)', () => {
  it('a reachable system is not "healthy" without a verified check; undeclared signals are not monitored', async () => {
    const i = await integration();
    const f = await evaluateSignals(dbh.db, i, DESCRIPTOR, probe());
    expect(f.signals.find((s) => s.signal === 'destination_verification')).toMatchObject({
      state: 'attention',
    });
    expect(f.signals.find((s) => s.signal === 'activity')).toMatchObject({ state: 'not_monitored' });
    expect(f.health).toBe('degraded');
  });
  it('records durable facts only on change, and lost authorization opens one event asking the customer', async () => {
    const i = await integration();
    await monitorIntegration(dbh.db, i, DESCRIPTOR, probe());
    const again = await monitorIntegration(dbh.db, i, DESCRIPTOR, probe());
    expect(again.changed).toBe(false);
    const lost = probe({
      credentials: [{ provider: 'quickbooks', state: 'revoked', detail: 'invalid_grant' }],
    });
    const m1 = await monitorIntegration(dbh.db, i, DESCRIPTOR, lost);
    const m2 = await monitorIntegration(dbh.db, i, DESCRIPTOR, lost);
    expect(m1.changed).toBe(true);
    expect(m1.facts.health).toBe('failing');
    expect(m1.reauthorizationEventId).toBe(m2.reauthorizationEventId); // one open event, not a stream
    const obs = await dbh.db.select().from(observations).where(eq(observations.integrationId, i.id));
    expect(obs.filter((o) => o.kind === 'monitoring')).toHaveLength(2);
  });
});
