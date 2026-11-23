import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { incidentEvents, incidents, integrations, syncRuns } from '@mi/database';
import { applyReconciliationResult, evaluateIntegration, recordAffectedOrders } from '../src/checks.ts';
import {
  canTransition,
  InvalidIncidentTransition,
  openIncident,
  transitionIncident,
} from '../src/incidents.ts';
import { reconcile } from '../src/reconciliation.ts';
import { createHarness, FAST_RETRY, type Harness } from '../../../test/support/harness.ts';

describe('incident state machine (pure)', () => {
  it('only allows resolved from verification', () => {
    expect(canTransition('investigating', 'resolved')).toBe(false);
    expect(canTransition('recovery', 'resolved')).toBe(false);
    expect(canTransition('verification', 'resolved')).toBe(true);
    expect(canTransition('resolved', 'investigating')).toBe(false);
  });
});

describe('incident detection and lifecycle (durable)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => h.close());

  const timeline = async (id: string) =>
    (await h.dbh.db.select().from(incidentEvents).where(eq(incidentEvents.incidentId, id))).map(
      (e) => e.toStatus,
    );

  it('refreshing an open incident keeps the affected orders recorded by the backlog (no lost update)', async () => {
    const input = {
      tenantId: h.tenantId,
      integrationId: h.integrationId,
      kind: 'schema_drift' as const,
      severity: 'high' as const,
      title: 't',
      reason: 'r',
      customerSummary: 's',
      classifyAs: 'investigating' as const,
      classificationNote: 'n',
      affectedScope: { syncRunIds: ['a'] },
    };
    const [inc] = await openIncident(h.dbh.db, input);
    await recordAffectedOrders(h.dbh.db, inc, [
      { name: '#1', legacyId: '1', updatedAt: '2026-11-23T00:00:00Z' },
    ]);
    // a later evaluation refreshes the same incident with new sync-run evidence (stale row in hand)
    await openIncident(h.dbh.db, { ...input, affectedScope: { syncRunIds: ['b', 'a'] } });
    await recordAffectedOrders(h.dbh.db, inc, [
      { name: '#1', legacyId: '1', updatedAt: '2026-11-23T00:00:00Z' },
      { name: '#2', legacyId: '2', updatedAt: '2026-11-23T00:01:00Z' },
    ]);
    const [row] = await h.dbh.db.select().from(incidents).where(eq(incidents.id, inc.id));
    expect(row!.affectedScope).toMatchObject({ syncRunIds: ['b', 'a'], affectedOrderCount: 2 });
  });

  it('dedupes open incidents and rejects invalid transitions durably', async () => {
    const input = {
      tenantId: h.tenantId,
      integrationId: h.integrationId,
      kind: 'sync_failure' as const,
      severity: 'medium' as const,
      title: 't',
      reason: 'r',
      customerSummary: 's',
      classifyAs: 'recoverable' as const,
      classificationNote: 'n',
    };
    const [a, createdA] = await openIncident(h.dbh.db, input);
    const [b, createdB] = await openIncident(h.dbh.db, input);
    expect(createdA).toBe(true);
    expect(createdB).toBe(false);
    expect(b.id).toBe(a.id);
    expect(await timeline(a.id)).toEqual(['detected', 'classified', 'recoverable']);
    await expect(
      transitionIncident(h.dbh.db, a.id, 'resolved', { actor: 'system', note: 'x', verification: {} }),
    ).rejects.toBeInstanceOf(InvalidIncidentTransition);
    await transitionIncident(h.dbh.db, a.id, 'recovery', { actor: 'system', note: 'x' });
    await transitionIncident(h.dbh.db, a.id, 'verification', { actor: 'system', note: 'x' });
    await expect(
      transitionIncident(h.dbh.db, a.id, 'resolved', { actor: 'system', note: 'x' }),
    ).rejects.toThrow(/verification evidence/);
    const r = await transitionIncident(h.dbh.db, a.id, 'resolved', {
      actor: 'system',
      note: 'ok',
      verification: { checked: true },
    });
    expect(r.resolvedAt).not.toBeNull();
  });

  it('schema drift: sync failure → schema_drift incident (investigating) + maintenance action', async () => {
    h.shopify.control.seedOrders(3, { start: new Date('2026-11-01T00:00:00Z') });
    h.shopify.control.setVariant('drift');
    const r = await (await h.engine()).run({ integrationId: h.integrationId, trigger: 'schedule' });
    expect(r.status).toBe('failed');
    expect(r.errorClass).toBe('schema');
    const ev = await evaluateIntegration(h.dbh.db, h.integrationId);
    const [inc] = await h.dbh.db.select().from(incidents);
    expect(inc).toMatchObject({ kind: 'schema_drift', status: 'investigating', severity: 'high' });
    expect(ev.actions.map((a) => a.type).sort()).toEqual(['assess_backlog', 'maintenance']);
    expect(ev.health).toBe('failing');
  });

  it('auth failure → requires customer action, resolved after re-authorization and a successful sync', async () => {
    h.shopify.control.seedOrders(2, { start: new Date('2026-11-01T00:00:00Z') });
    h.netsuite.control.revoke();
    await (await h.engine()).run({ integrationId: h.integrationId, trigger: 'schedule' });
    await evaluateIntegration(h.dbh.db, h.integrationId);
    const [inc] = await h.dbh.db.select().from(incidents);
    expect(inc).toMatchObject({ kind: 'connection_auth', status: 'requires_action' });
    expect(inc!.customerAction).toMatch(/Re-authorize NetSuite/);

    // customer re-authorizes (fixture accepts tokens again)
    h.netsuite.state.revoked = false;
    const r = await (await h.engine()).run({ integrationId: h.integrationId, trigger: 'schedule' });
    expect(r.status).toBe('succeeded');
    await evaluateIntegration(h.dbh.db, h.integrationId);
    const [after] = await h.dbh.db.select().from(incidents);
    expect(after!.status).toBe('resolved');
    expect(await timeline(after!.id)).toEqual([
      'detected',
      'classified',
      'requires_action',
      'recovery',
      'verification',
      'resolved',
    ]);
  });

  it('transient failures: incident after 2 consecutive failures, resolved only after reconciliation verifies', async () => {
    h.shopify.control.seedOrders(4, { start: new Date('2026-11-20T00:00:00Z') });
    h.netsuite.state.faults.add({ target: 'record.put', type: 'http503', count: 1000 });
    const engine = await h.engine();
    await engine.run({ integrationId: h.integrationId, trigger: 'schedule' });
    expect((await evaluateIntegration(h.dbh.db, h.integrationId)).openIncidents).toHaveLength(0);
    await engine.run({ integrationId: h.integrationId, trigger: 'schedule' });
    const ev = await evaluateIntegration(h.dbh.db, h.integrationId);
    expect(ev.openIncidents).toEqual([
      expect.objectContaining({ kind: 'sync_failure', status: 'recoverable' }),
    ]);
    expect(ev.actions.some((a) => a.type === 'sync')).toBe(true);

    h.netsuite.state.faults.clear();
    await engine.run({ integrationId: h.integrationId, trigger: 'recovery' });
    const ev2 = await evaluateIntegration(h.dbh.db, h.integrationId);
    const recon = ev2.actions.find((a) => a.type === 'reconcile');
    expect(recon).toBeDefined();
    const [inc] = await h.dbh.db.select().from(incidents);
    expect(inc!.status).toBe('verification');

    const c = await h.clients();
    const result = await reconcile({
      db: h.dbh.db,
      shopify: c.shopify,
      netsuite: c.netsuite,
      integrationId: h.integrationId,
      trigger: 'incident',
      incidentId: inc!.id,
      windowFrom: new Date('2026-11-19T00:00:00Z'),
      retry: FAST_RETRY,
    });
    await applyReconciliationResult(h.dbh.db, h.integrationId, inc!.id, result);
    const [done] = await h.dbh.db.select().from(incidents);
    expect(done!.status).toBe('resolved');
    expect((done!.verification as { matched: number }).matched).toBe(4);
  });

  it('freshness breach opens and resolves on catch-up', async () => {
    await h.dbh.db
      .update(integrations)
      .set({ lastSuccessfulSyncAt: new Date(Date.now() - 3 * 3600_000) })
      .where(eq(integrations.id, h.integrationId));
    await evaluateIntegration(h.dbh.db, h.integrationId);
    expect((await h.dbh.db.select().from(incidents))[0]).toMatchObject({
      kind: 'freshness_breach',
      status: 'recoverable',
    });
    await (await h.engine()).run({ integrationId: h.integrationId, trigger: 'schedule' });
    const ev = await evaluateIntegration(h.dbh.db, h.integrationId);
    expect(ev.openIncidents).toHaveLength(0);
    expect(ev.health).toBe('healthy');
  });

  it('rejected records → requires_action naming the unmapped SKU; resolves after redelivery', async () => {
    h.shopify.control.upsertOrder({
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
      lineItems: [{ sku: 'SKU-GREEN', title: 'G', quantity: 1, unitPrice: '3.00' }],
    });
    await (await h.engine()).run({ integrationId: h.integrationId, trigger: 'schedule' });
    await evaluateIntegration(h.dbh.db, h.integrationId);
    const [inc] = await h.dbh.db.select().from(incidents);
    expect(inc!.customerAction).toContain('SKU-GREEN');
    const cfg = (await h.dbh.db.select().from(integrations))[0]!.config as { skuMap: Record<string, string> };
    await h.dbh.db
      .update(integrations)
      .set({ config: { ...cfg, skuMap: { ...cfg.skuMap, 'SKU-GREEN': '103' } } });
    const order = [...h.shopify.state.orders.values()][0]!;
    await (
      await h.engine()
    ).run({
      integrationId: h.integrationId,
      trigger: 'recovery',
      mode: 'redelivery',
      sourceLegacyIds: [order.legacyId],
    });
    await evaluateIntegration(h.dbh.db, h.integrationId);
    expect((await h.dbh.db.select().from(incidents))[0]!.status).toBe('resolved');
  });

  it('interrupted runs count toward sync failure detection', async () => {
    await h.dbh.db.insert(syncRuns).values([
      {
        integrationId: h.integrationId,
        mode: 'incremental',
        status: 'interrupted',
        trigger: 'schedule',
        errorClass: 'transient',
      },
    ]);
    await new Promise((r) => setTimeout(r, 5));
    await h.dbh.db.insert(syncRuns).values([
      {
        integrationId: h.integrationId,
        mode: 'incremental',
        status: 'interrupted',
        trigger: 'schedule',
        errorClass: 'transient',
      },
    ]);
    const ev = await evaluateIntegration(h.dbh.db, h.integrationId);
    expect(ev.openIncidents.map((i) => i.kind)).toContain('sync_failure');
  });
});
