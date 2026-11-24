/**
 * S5 "onboarding" (docs/experiment/SCENARIOS.md §S5), System B: a company that already runs the adopted
 * order sync itself signs up, connects Shopify and NetSuite, we discover its integration from its own writes,
 * it confirms, we take over with a baseline; then a Shopify change is absorbed through the correction registry.
 */
import { api } from "../feltkit/_generated/api.ts";
import { FX, company, connectNetSuite, connectShopify, expect, finish, json, netsuiteRecords, staff, step, theirOrderSync, wait } from "./lib.ts";

const shop = FX.shopify3;
const run = Date.now().toString(36);
await json(`${FX.netsuite}/__fixture/config`, { method: "POST", body: { oneWorld: false } });
await json(`${shop}/__fixture/webhook-version`, { method: "POST", body: { version: "2026-10" } });

const history = [];
for (let i = 0; i < 6; i++) {
  const t = new Date(Date.now() - 6 * 3600_000 + i * 60_000).toISOString();
  history.push((await json(`${shop}/__fixture/orders`, { method: "POST", body: { name: `#N-${run}-${i + 1}`, createdAt: t, updatedAt: t, email: "buyer@northwind.test", lineItems: [{ sku: i % 2 ? "SKU-BLUE" : "SKU-RED", title: "Part", quantity: i + 1, unitPrice: "10.00" }] } })).body as { legacyId: string; name: string });
}
const theirs = await theirOrderSync();
for (const o of history) {
  const payload = (await json(`${shop}/__fixture/orders/${o.legacyId}/webhook-payload`)).body;
  const r = await theirs.process(payload);
  expect(r.status === "created", `their deployment: ${o.name} ${r.status} ${r.message ?? ""}`);
}
step(0, `Before: Northwind's own deployment of shopify-erp-order-sync wrote ${history.length} orders to NetSuite`);

const actions: string[] = [];
const nw = await company("Northwind", `owner-${run}@northwind.test`);
const { c, workspace } = nw;
actions.push("sign up");
step("A1", `New company signed up: ${(await c.query(api.onboarding.status)).integrations.find((i) => i.kind === "order_sync")!.next}`);
await connectShopify(c, api, shop);
actions.push("connect Shopify");
step("A2", "Shopify connected through OAuth (scope read_orders)");
await connectNetSuite(c, api);
actions.push("connect NetSuite", "register the certificate in NetSuite");
step("A3", "NetSuite connected (machine-to-machine certificate) → verified");

await c.mutation(api.onboarding.discover, { kind: "order_sync" });
const found = await wait("discovery", async () => (await c.query(api.onboarding.status)).integrations.find((i) => i.kind === "order_sync" && i.status !== "discovering"));
expect(found.status === "confirm", `discovery: ${found.status} ${JSON.stringify(found.discovery)}`);
const cand = (found.discovery!.candidates as { id: string; summary: string; confidence: string }[])[0]!;
step("A4", `Discovered: ${cand.summary} (confidence: ${cand.confidence}) — ${JSON.stringify(found.discovery!.evidence)}`);
actions.push("confirm: maintain this integration");
await c.mutation(api.onboarding.confirm, { kind: "order_sync", candidateId: cand.id, responsibilitiesVersion: found.responsibilities.version });
step("A5", `Customer confirmed ${found.responsibilities.maintain.length} responsibilities (version ${found.responsibilities.version})`);
const managed = await wait("management to become active", async () => (await c.query(api.onboarding.status)).integrations.find((i) => i.kind === "order_sync" && i.status === "managed"));
const b = managed.discovery!.baseline as Record<string, number>;
expect(b.previouslyDelivered === 6 && b.missing === 0, `baseline ${JSON.stringify(b)}`);
step("A6", `Under management. Baseline: ${b.checked} recent orders checked, ${b.accountedFor} in NetSuite (${b.previouslyDelivered} written by their earlier deployment), ${b.missing} missing`);
const integrationId = managed.integrationId!;
step("A7", `Customer overview: ${(await c.query(api.integrations.list)).integrations.find((i) => i.id === integrationId)!.status}`);

const fresh = (await json(`${shop}/__fixture/orders`, { method: "POST", body: { name: `#N-${run}-NEW`, email: "buyer@northwind.test", lineItems: [{ sku: "SKU-RED", title: "Part", quantity: 2, unitPrice: "10.00" }] } })).body as { legacyId: string; name: string };
await wait("the new order in NetSuite", async () => (await netsuiteRecords(fresh.legacyId)).length === 1);
step("A8", `A new order (${fresh.name}) reached us through the subscription we registered and is in NetSuite exactly once`);
step("A9", `Customer actions in onboarding (${actions.length}): ${actions.join(" → ")}`);

await json(`${shop}/__fixture/webhook-version`, { method: "POST", body: { version: "2027-01" } });
const changed = (await json(`${shop}/__fixture/orders`, { method: "POST", body: { name: `#N-${run}-CHG`, email: "buyer@northwind.test", lineItems: [{ sku: "SKU-BLUE", title: "Part", quantity: 1, unitPrice: "7.25" }] } })).body as { legacyId: string; name: string };
step("B1", `Simulator: Shopify switches order webhooks to 2027-01; ${changed.name} arrives in the new format`);
const operator = await staff(c, workspace);
const done = await wait("the correction active and the event resolved", async () => {
  const x = await operator.query(api.corrections.inspect, { integrationId });
  const a = x.corrections.find((r) => r.kind === "adapter");
  const ev = (await operator.query(api.maintenance.list, { integrationId }))[0];
  return a?.status === "active" && ev?.status === "resolved" ? { x, a, ev } : null;
}, 60_000);
const finding = (await operator.query(api.maintenance.evidence, { eventId: done.ev.id })).event.finding as { location: string[] };
step("B2", `Operator: running ${done.x.running.join(", ")} on ${done.x.upstream.repository} @ ${done.x.upstream.commit.slice(0, 12)}; price is read at ${finding.location.join(", ")}`);
step("B3", `Adapter ${String(done.a.spec.adapter)}: ${done.a.history.map((h) => h.to).join(" → ")}; ${(done.a.validation as { checks: { name: string; result: string }[] }).checks.map((k) => `${k.name}: ${k.result}`).join("; ")}`);
const rec = await netsuiteRecords(changed.legacyId);
expect(rec.length === 1 && rec[0]!.item.items[0]!.rate === 7.25, `${changed.name} in NetSuite: ${JSON.stringify(rec)}`);
step("B4", `${changed.name} is in NetSuite with Shopify's price (7.25), written by the adopted code with the adapter applied`);
const story = await c.query(api.maintenance.get, { eventId: done.ev.id });
step("B5", `Customer sees: "${story.headline}" … "${story.timeline.at(-1)!.text}"`);

const acme = await company("Acme", `owner-${run}@acme.test`);
const acmeView = (await acme.c.query(api.onboarding.status)).integrations.find((i) => i.kind === "order_sync")!;
expect(acmeView.integrationId !== integrationId, "cross-company leak");
step("C1", `Another company sees only its own onboarding (status ${acmeView.status}, integration ${acmeView.integrationId ?? "none"})`);
finish("onboarding");
