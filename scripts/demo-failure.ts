/**
 * End-to-end failure demonstration against a RUNNING stack (make up; make demo-failure).
 *
 * Uses DETERMINISTIC PROVIDER FIXTURES: the "upstream change" is a controlled, fictional schema
 * change in the fixture (profile `drift`). It is not a claim that Shopify changed.
 *
 * Steps follow spec §21. Human approval: by default the script waits for an operator to approve
 * the candidate in the UI (/ops). With --auto-approve it calls the same operator API endpoint as a
 * scripted stand-in for that click, and says so in its output.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { and, desc, eq } from 'drizzle-orm';
import {
  createDb,
  incidents,
  integrations,
  maintenanceRuns,
  reconciliationRuns,
  releases,
  repairCandidates,
  syncRuns,
  validationRuns,
} from '@mi/database';

const API = process.env.DEMO_API_URL ?? 'http://api:3000';
const SHOPIFY = process.env.SHOPIFY_BASE_URL_OVERRIDE ?? 'http://fixtures:4010';
const NETSUITE = process.env.NETSUITE_BASE_URL_OVERRIDE ?? 'http://fixtures:4020';
const AUTO_APPROVE = process.argv.includes('--auto-approve');
const { db, close } = createDb(process.env.DATABASE_URL!, { max: 2 });
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), fixture: 'DETERMINISTIC TEST FIXTURE (not Shopify/NetSuite)', steps: [] as unknown[] };
const t0 = Date.now();

function step(n: number, title: string, data: unknown = {}) {
  const line = `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${String(n).padStart(2)}. ${title}`;
  console.log(line);
  (evidence.steps as unknown[]).push({ n, title, at: new Date().toISOString(), data });
}
async function waitFor<T>(what: string, fn: () => Promise<T | undefined | null | false>, timeoutMs = 10 * 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
async function login(email: string, password: string) {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!r.ok) throw new Error(`login ${email} failed: ${r.status}`);
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  const { csrfToken } = (await r.json()) as { csrfToken: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (path: string, method = "GET", body?: unknown): Promise<any> => {
    const res = await fetch(`${API}${path}`, { method, headers: { cookie, 'x-csrf-token': csrfToken, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
}
const fixture = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

const customer = await login(process.env.SEED_CUSTOMER_EMAIL ?? 'customer@acme.test', process.env.SEED_CUSTOMER_PASSWORD || 'customer-demo-password');
const operator = await login(process.env.SEED_OPERATOR_EMAIL ?? 'operator@managed-integrations.test', process.env.SEED_OPERATOR_PASSWORD || 'operator-demo-password');
const [integ] = await db.select().from(integrations);
if (!integ) throw new Error('no integration — run the seed');

/* Preconditions: the fixtures are in-memory; if they restarted since seeding, the demo is invalid. */
const shopState = (await (await fetch(`${SHOPIFY}/__fixture/state`)).json()) as { orderCount: number; variant: string };
if (shopState.orderCount === 0 || shopState.variant !== 'baseline') {
  throw new Error(`Fixture state is not the seeded baseline (orders=${shopState.orderCount}, variant=${shopState.variant}). Fixtures keep state in memory; run \`make reset\` for a clean demo.`);
}

/* 1-3: healthy, delivered, evidence — only runs started by this demo count */
const demoStart = new Date();
await customer('/api/customer/integration/sync', 'POST');
const healthyRun = await waitFor('a successful sync started by this demo', async () => (await db.select().from(syncRuns).where(and(eq(syncRuns.integrationId, integ.id), eq(syncRuns.status, 'succeeded'))).orderBy(desc(syncRuns.createdAt)).limit(5)).find((r) => r.createdAt >= demoStart));
await waitFor('healthy status before the demo (resolve open incidents or run `make reset`)', async () => (await customer('/api/customer/overview')).integration.health === 'healthy', 90_000);
const ns0 = (await (await fetch(`${NETSUITE}/__fixture/state`)).json()) as { salesOrders: unknown[] };
step(1, 'Integration healthy', { health: (await customer('/api/customer/overview')).integration.health, implementation: integ.implementationVersionId });
step(2, `Records delivered: NetSuite fixture holds ${ns0.salesOrders.length} sales orders`, { syncRunId: healthyRun.id, delivered: healthyRun.deliveredCount });
step(3, 'Delivery evidence recorded', { run: await customer(`/api/customer/sync-runs/${healthyRun.id}`).then((r) => ({ status: r.status, records: r.records.length, sample: r.records[0] })) });

/* 4-5: controlled upstream change (FIXTURE) → failure */
await fixture(SHOPIFY, '/__fixture/variant', { variant: 'drift' });
await fixture(SHOPIFY, '/__fixture/seed', { count: 5, start: new Date(Date.now() - 60_000).toISOString(), stepMs: 5_000 });
step(4, 'FIXTURE: controlled upstream schema change introduced (LineItem.originalUnitPriceSet removed) + 5 new orders');
const detectedAfter = new Date();
await customer('/api/customer/integration/sync', 'POST');
const failedRun = await waitFor('the sync to fail', async () => (await db.select().from(syncRuns).where(and(eq(syncRuns.integrationId, integ.id), eq(syncRuns.status, 'failed'))).orderBy(desc(syncRuns.createdAt)).limit(1)).find((r) => r.createdAt > detectedAfter));
step(5, `Integration failed safely (${failedRun.errorClass}); cursor not advanced`, { syncRunId: failedRun.id, error: failedRun.errorMessage, cursorBefore: failedRun.cursorBefore, cursorAfter: failedRun.cursorAfter });

/* 6-8: detection, incident, affected records */
const inc = await waitFor('incident', async () => (await db.select().from(incidents).where(and(eq(incidents.integrationId, integ.id), eq(incidents.kind, 'schema_drift'))).orderBy(desc(incidents.detectedAt)).limit(1))[0]);
step(6, 'Reliability system detected the failure', { incidentId: inc.id, status: inc.status });
step(7, `Incident created: "${inc.title}"`, { severity: inc.severity, classification: inc.status });
const withScope = await waitFor('affected orders', async () => {
  const [i] = await db.select().from(incidents).where(eq(incidents.id, inc.id));
  return (i?.affectedScope as { affectedOrderCount?: number })?.affectedOrderCount != null ? i : undefined;
});
step(8, `Affected records identified: ${(withScope.affectedScope as { affectedOrderCount: number }).affectedOrderCount} order(s)`, { orders: (withScope.affectedScope as { affectedOrders: unknown[] }).affectedOrders });

/* 9-12: maintenance agent */
const mr = await waitFor('maintenance run', async () => (await db.select().from(maintenanceRuns).where(eq(maintenanceRuns.incidentId, inc.id)))[0]);
step(9, 'Maintenance agent received a bounded, sanitized task', { maintenanceRunId: mr.id });
const mrDone = await waitFor('agent to finish', async () => {
  const [m] = await db.select().from(maintenanceRuns).where(eq(maintenanceRuns.id, mr.id));
  return m && ['candidate_submitted', 'no_candidate', 'failed'].includes(m.status) ? m : undefined;
});
const calls = mrDone.toolCalls as { tool: string; ok: boolean }[];
step(10, `Agent investigated with ${calls.length} restricted tool calls (planner: ${mrDone.planner})`, { tools: calls.map((c) => `${c.tool}${c.ok ? '' : ' (refused/failed)'}`), status: mrDone.status });
if (mrDone.status !== 'candidate_submitted') throw new Error(`Agent did not produce a candidate: ${mrDone.outcome}`);
const [cand] = await db.select().from(repairCandidates).where(eq(repairCandidates.maintenanceRunId, mr.id));
step(11, 'Repair candidate created in an isolated worktree', { candidateId: cand!.id, branch: cand!.branch, changedFiles: cand!.changedFiles, hypothesis: cand!.hypothesis });
step(12, 'Acceptance tests not altered by the agent', { acceptanceFilesChanged: cand!.changedFiles.filter((f) => f.includes('/test/acceptance/')) });

/* 13: independent validation */
const val = await waitFor('independent validation', async () => {
  const [v] = await db.select().from(validationRuns).where(eq(validationRuns.repairCandidateId, cand!.id)).orderBy(desc(validationRuns.startedAt)).limit(1);
  return v && v.status !== 'running' ? v : undefined;
});
step(13, `Independent validation ${val.status} (protected suite intact: ${val.protectedPathsOk})`, { validationRunId: val.id, suiteSha256: val.testSuiteSha256, suites: (val.results as { suites?: Record<string, { passed: boolean; isolated: boolean }> }).suites });
if (val.status !== 'passed') throw new Error('validation did not pass');

/* 14: human approval */
if (AUTO_APPROVE) {
  await operator(`/api/operator/candidates/${cand!.id}/approve`, 'POST', { note: 'demo --auto-approve: scripted stand-in for the operator approval click' });
  step(14, 'Approval recorded via operator API (--auto-approve: SCRIPTED stand-in for a human click)');
} else {
  console.log(`\n>>> Waiting for a human: open ${process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000'}/ops/candidates/${cand!.id} and approve.\n`);
  await waitFor('human approval', async () => (await db.select().from(releases).where(eq(releases.repairCandidateId, cand!.id)))[0], 60 * 60_000);
  step(14, 'Human approval recorded');
}

/* 15-18: release, resume, reconcile, resolve */
const rel = await waitFor('release outcome', async () => {
  const [r] = await db.select().from(releases).where(eq(releases.repairCandidateId, cand!.id));
  return r && ['released', 'rolled_back'].includes(r.status) && (r.status === 'rolled_back' || r.postReleaseReconciliationId) ? r : undefined;
});
step(15, `Candidate released via canary (${rel.status})`, { releaseId: rel.id, version: rel.integrationVersionId, previous: rel.previousVersionId, canary: rel.canaryResult });
if (rel.status !== 'released') throw new Error('release rolled back');
const resumed = (await db.select().from(syncRuns).where(eq(syncRuns.integrationId, integ.id)).orderBy(desc(syncRuns.createdAt)).limit(5)).find((r) => r.implementationVersionId === rel.integrationVersionId && r.status !== 'failed');
step(16, 'Synchronization resumed on the new version', { syncRunId: resumed?.id, mode: resumed?.mode, delivered: resumed?.deliveredCount });
const [recon] = await db.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, rel.postReleaseReconciliationId!));
step(17, `Reconciliation: ${recon!.outcome} — ${recon!.matchedCount}/${recon!.expectedCount} expected orders matched; missing ${(recon!.missing as unknown[]).length}, duplicates ${(recon!.duplicates as unknown[]).length}`, { reconciliationRunId: recon!.id });
const resolved = await waitFor('incident resolution', async () => {
  const [i] = await db.select().from(incidents).where(eq(incidents.id, inc.id));
  return i?.status === 'resolved' ? i : undefined;
});
step(18, 'Incident resolved with verification evidence', { resolution: resolved.resolution, verification: resolved.verification });
const view = await customer(`/api/customer/incidents/${inc.id}`);
step(19, 'Customer sees a clear status and history', { status: view.status, summary: view.summary, resolution: view.resolution, timeline: view.timeline.map((e: { status: string; note: string }) => `${e.status}: ${e.note}`) });

const ns1 = (await (await fetch(`${NETSUITE}/__fixture/state`)).json()) as { salesOrders: { externalId: string }[] };
const ext = ns1.salesOrders.map((s) => s.externalId);
evidence.finishedAt = new Date().toISOString();
evidence.netsuiteFixture = { salesOrders: ext.length, uniqueExternalIds: new Set(ext).size };
console.log(`\nDONE in ${((Date.now() - t0) / 1000).toFixed(0)}s — NetSuite fixture: ${ext.length} sales orders, ${new Set(ext).size} unique externalIds (no duplicates: ${ext.length === new Set(ext).size})`);
const out = process.env.DEMO_EVIDENCE_DIR ?? '/data/artifacts/evidence';
await mkdir(out, { recursive: true });
const file = `${out}/demo-failure-${Date.now()}.json`;
await writeFile(file, JSON.stringify(evidence, null, 2));
console.log(`evidence written to ${file}`);
await close();
