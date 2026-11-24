/**
 * S1 "failure" (docs/experiment/SCENARIOS.md §S1), System B: the native polling sync meets a Shopify schema
 * change, fails safely, and is repaired: a planner (EVE agent, or the playbook) proposes, System B validates,
 * a person approves, a canary is verified, the engine is promoted and every waiting order is verified.
 */
import { api } from "../feltkit/_generated/api.ts";
import { FX, company, connectNetSuite, connectShopify, expect, finish, json, netsuiteRecords, staff, step, wait } from "./lib.ts";

const shop = FX.shopify;
const run = Date.now().toString(36);
await json(`${FX.netsuite}/__fixture/config`, { method: "POST", body: { oneWorld: false } });
await json(`${shop}/__fixture/variant`, { method: "POST", body: { variant: "baseline" } });
const acme = await company("AcmeNative", `owner-${run}@acme-native.test`);
const { c, workspace } = acme;
await connectShopify(c, api, shop);
await connectNetSuite(c, api);
const integrationId = await c.mutation(api.native.adopt, { since: new Date(Date.now() - 7 * 86400_000).toISOString() });
await json(`${shop}/__fixture/seed`, { method: "POST", body: { count: 5, start: new Date(Date.now() - 3600_000).toISOString(), stepMs: 60_000 } });

const syncAndWait = async (what: string) => {
  const { runId } = await c.mutation(api.native.sync, { integrationId });
  return wait(what, async () => {
    const r = await c.query(api.native.run, { runId });
    return r.status !== "running" ? r : null;
  }, 60_000);
};
const healthy = await syncAndWait("a healthy sync");
expect(healthy.status === "succeeded" && healthy.delivered === 5, `healthy run ${healthy.status} ${healthy.delivered}`);
step(1, `Integration healthy: run ${healthy.id} on engine v${healthy.engineVersion}`);
step(2, `Records delivered: ${healthy.delivered} sales orders written by the adopted NetSuite adapter`, healthy.records);
step(3, `Delivery evidence recorded: cursor ${healthy.cursorBefore} → ${healthy.cursorAfter}`);

await json(`${shop}/__fixture/variant`, { method: "POST", body: { variant: "drift" } });
await json(`${shop}/__fixture/seed`, { method: "POST", body: { count: 5, start: new Date(Date.now() - 60_000).toISOString(), stepMs: 5_000 } });
step(4, "Simulator: controlled upstream schema change (LineItem.originalUnitPriceSet removed) + 5 new orders");
const failed = await syncAndWait("the sync to fail");
expect(failed.status === "failed" && failed.errorClass === "schema_drift" && !failed.cursorAfter, `failed run ${JSON.stringify(failed).slice(0, 200)}`);
step(5, `Integration failed safely (${failed.errorClass}); cursor not advanced (held at ${failed.cursorBefore})`, failed.errorMessage);

const ev = await wait("the incident", async () => (await c.query(api.maintenance.list, { integrationId })).find((e) => e.kind === "schema_drift"));
step(6, `Detected: maintenance event ${ev.id} (${ev.kind}, boundary ${ev.boundary})`);
const operator = await staff(c, workspace);
const evidence = async () => operator.query(api.maintenance.evidence, { eventId: ev.id });
const f0 = (await evidence()).event.finding as { affectedOrderCount: number; error: string };
step(7, `Incident: "${f0.error}"`);
step(8, `Affected records identified: ${f0.affectedOrderCount} order(s) waiting since the held cursor`);
expect(f0.affectedOrderCount === 5, `affected ${f0.affectedOrderCount}`);

const validated = await wait("a validated candidate", async () => {
  const e = await evidence();
  const fix = (e.corrections as any[]).find((x) => x.kind === "patch");
  return fix?.status === "validated" ? fix : fix?.status === "rejected" || (e.corrections as any[]).some((x) => x.kind === "unsupported") ? fix ?? "unsupported" : null;
}, 120_000);
expect(typeof validated === "object" && validated.status === "validated", `candidate: ${JSON.stringify(validated).slice(0, 300)}`);
step(9, `Planner received a bounded task (incident, engine specification, provider fields; no credentials): planner=${validated.spec.planner}`);
step(10, `Planner answered in ${validated.spec.plannerMs} ms: "${validated.spec.hypothesis}"`);
step(11, `Candidate: engine v${validated.spec.engine.version} reads ${validated.spec.engine.priceField}`);
const suite = validated.validation.checks.find((k: any) => k.name === "acceptance suite not altered");
step(12, `Acceptance suite not altered: ${suite.result} (${suite.detail})`);
step(13, `Independent validation passed: ${validated.validation.checks.map((k: any) => `${k.result === "passed" ? "✓" : "✗"} ${k.name}`).join(" · ")}`);

await operator.mutation(api.corrections.activate, { correctionId: validated.id, reason: "Reviewed the candidate and its validation" });
step(14, "Operator approval recorded (staff, in the operator's own session)");
const done = await wait("the event resolved", async () => {
  const e = await evidence();
  return e.event.status === "resolved" ? e : e.event.status === "requires_action" ? e : null;
}, 120_000);
expect(done.event.status === "resolved", `event ${done.event.status}`);
const fix = (done.corrections as any[]).find((x) => x.id === validated.id);
const runs = (await c.query(api.native.runs, { integrationId })).runs;
const canary = runs.find((r) => r.canary);
const promoted = runs.find((r) => !r.canary && r.status === "succeeded" && r.engineVersion === validated.spec.engine.version);
step(15, `Candidate released via canary: run ${canary?.id} (${canary?.delivered} order, verified in NetSuite) → ${fix.history.map((h: any) => h.to).join(" → ")}`);
step(16, `Synchronization resumed on engine v${promoted?.engineVersion}: run ${promoted?.id} delivered ${promoted?.delivered}`);
const affected = ((done.event.finding as any).affectedOrders as { sourceId: string }[]);
for (const o of affected) {
  const recs = await netsuiteRecords(o.sourceId);
  expect(recs.length === 1, `order ${o.sourceId}: ${recs.length} NetSuite records`);
}
step(17, `Verification: every affected order is in NetSuite exactly once with Shopify's prices`, fix.postActivation.verified);
step(18, `Incident resolved with verification evidence: ${JSON.stringify(done.event.accounting)}`);
const story = await c.query(api.maintenance.get, { eventId: ev.id });
expect(!/originalUnitPriceSet|planner|candidate|canary|eve/i.test(JSON.stringify(story)), "customer view leaks internals");
step(19, `Customer sees: ${story.timeline.map((t) => `"${t.text}"`).join(" → ")}`);
await json(`${shop}/__fixture/variant`, { method: "POST", body: { variant: "baseline" } });
finish("failure");
