/**
 * A changed provider contract enters the maintenance lifecycle as evidence: contracts preserved, impact attributed,
 * an event opened only for the affected application, nothing beyond "impact identified" implied.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { adaptations, contractObservations, incidents, integrations, integrationContracts, tenants, type DbHandle } from '@mi/database';
import { fromFile, normalize, type NormalizedContract, type UsageManifest } from '../src/index.ts';
import { checkContractChange } from '../src/maintain.ts';
import { freshDb } from '../../../test/support/harness.ts';

let dbh: DbHandle;
let v1267: NormalizedContract;
let v1618: NormalizedContract;
const dir = mkdtempSync(join(tmpdir(), 'mi-oa-m-'));
const load = async (tag: string) => {
  const p = join(dir, `${tag}.json`);
  writeFileSync(p, gunzipSync(readFileSync(join(import.meta.dirname, `../specs/stripe-${tag}.json.gz`))));
  const s = fromFile(p, { authority: 'official', license: 'MIT' });
  return normalize(s.document, s.source);
};
const usage = (f: string) => JSON.parse(readFileSync(join(import.meta.dirname, `../adoptions/${f}`), 'utf8')) as UsageManifest;

beforeAll(async () => {
  dbh = await freshDb();
  [v1267, v1618] = await Promise.all([load('v1267'), load('v1618')]);
}, 120_000);
afterAll(async () => dbh?.close());

async function integration(flowType: string) {
  const [t] = await dbh.db.insert(tenants).values({ name: flowType, slug: `t-${Math.random().toString(36).slice(2, 8)}`, lifecycle: 'active' }).returning();
  await dbh.db.insert(integrationContracts).values({ version: `c-${flowType}`, flowType, definition: {}, definitionSha256: 'x' }).onConflictDoNothing();
  const [i] = await dbh.db.insert(integrations).values({ tenantId: t!.id, flowType, config: {}, contractVersion: `c-${flowType}`, enabled: true, lifecycle: 'active' }).returning();
  return i!;
}

it('basil: the subscriptions app gets a reviewable event naming the three fields and lines; SaaSKit gets none; both contracts are kept; nothing is corrected by itself', async () => {
  const app = await integration('adopted.stripe_subscriptions_app');
  const sk = await integration('saaskit.stripe');
  const r1 = await checkContractChange(dbh.db, { integrationId: app.id, provider: 'stripe', from: v1267, to: v1618, usage: usage('subscriptions-app-stripe.usage.json') });
  expect(r1.report.verdict).toBe('affected_breaking');
  const [ev] = await dbh.db.select().from(incidents).where(eq(incidents.id, r1.eventId!));
  expect(ev).toMatchObject({ kind: 'provider_contract_change', boundary: 'provider', provider: 'stripe', status: 'investigating', correction: null, validation: null });
  expect((ev!.impactAssessment as { affected: { field: string; usedAt: string }[] }).affected.map((a) => `${a.field}@${a.usedAt.split(':').pop()}`).sort()).toEqual(['current_period_end@21', 'paid@50', 'subscription@46']);
  // no correction is created by detection
  expect(await dbh.db.select().from(adaptations).where(eq(adaptations.maintenanceEventId, ev!.id))).toEqual([]);
  // both contracts preserved: baseline (adopted against) and the new one, with the subsets the application uses
  const obs = await dbh.db.select().from(contractObservations).where(and(eq(contractObservations.integrationId, app.id), eq(contractObservations.contract, 'openapi:stripe')));
  expect(obs.map((o) => [o.status, o.version]).sort()).toEqual([['baseline', '2024-06-20'], ['observed', '2025-03-31.basil']]);
  const kept = obs.find((o) => o.status === 'baseline')!.sample as { usedSubset: { schemas: Record<string, { fields: Record<string, unknown> }> } };
  expect(Object.keys(kept.usedSubset.schemas['invoice']!.fields)).toContain('subscription');
  // idempotent: checking again neither duplicates the event nor the observations
  const r2 = await checkContractChange(dbh.db, { integrationId: app.id, provider: 'stripe', from: v1267, to: v1618, usage: usage('subscriptions-app-stripe.usage.json') });
  expect(r2.eventId).toBe(r1.eventId);
  expect((await dbh.db.select().from(contractObservations).where(eq(contractObservations.integrationId, app.id))).length).toBe(2);
  // SaaSKit: contract change recorded, application unaffected → no event
  const s = await checkContractChange(dbh.db, { integrationId: sk.id, provider: 'stripe', from: v1267, to: v1618, usage: usage('saaskit-stripe.usage.json') });
  expect(s).toMatchObject({ eventId: null, report: { verdict: 'unaffected' } });
  expect((await dbh.db.select().from(incidents).where(eq(incidents.integrationId, sk.id))).length).toBe(0);
}, 120_000);
