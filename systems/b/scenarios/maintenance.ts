/**
 * S4 "maintenance" (docs/experiment/SCENARIOS.md §S4), System B: Shopify changes its orders/create payload
 * (2027-01: line_items[].price no longer sent) and one webhook is lost. The change is detected, investigated,
 * corrected by a reviewed adapter, validated, activated; held and lost orders are recovered and verified;
 * the accounting shows nothing lost or duplicated; the customer needs to do nothing.
 */
import { api } from "../feltkit/_generated/api.ts";
import { FX, adoptedCompany, company, expect, finish, json, netsuiteRecords, staff, step, wait } from "./lib.ts";

const bw = await adoptedCompany(api, "Northwind", FX.shopify3);
const { c, integrationId, run, workspace } = bw;
const shop = FX.shopify3;
const status0 = (await c.query(api.integrations.list)).integrations[0]!.status;
expect(status0 === "protected", `expected protected, got ${status0}`);
step(1, `Integration ${integrationId} is ${status0}`);

const newOrder = async (name: string, price: string) =>
  (await json(`${shop}/__fixture/orders`, { method: "POST", body: { name, email: "buyer@northwind.test", lineItems: [{ sku: "SKU-BLUE", title: "Part", quantity: 1, unitPrice: price }] } })).body as { legacyId: string; name: string };

const before = await newOrder(`#M-${run}-0`, "7.25");
await wait("baseline order delivered", async () => (await netsuiteRecords(before.legacyId)).length === 1);
step(2, `Baseline: ${before.name} (2026-10 payload) delivered normally`);

await json(`${shop}/__fixture/webhook-version`, { method: "POST", body: { version: "2027-01" } });
step(3, "Provider change: Shopify now sends 2027-01 payloads (line_items[].price removed; price_set kept)");
const o1 = await newOrder(`#M-${run}-1`, "7.25");
await json(`${shop}/__fixture/drop-webhooks`, { method: "POST", body: { n: 1 } });
const lost = await newOrder(`#M-${run}-2`, "9.50");
const o3 = await newOrder(`#M-${run}-3`, "11.00");
step(4, `Three orders in the new format; the webhook for ${lost.name} is lost in transit`);

const events = await wait("maintenance event resolved", async () => {
  const l = await c.query(api.maintenance.list, { integrationId });
  return l.length && l.every((e) => e.status === "resolved") ? l : null;
}, 60_000);
expect(events.length === 1, `expected one event for one change, got ${events.length}`);
const ev = events[0]!;
step(5, `One maintenance event ${ev.id} (${ev.kind}, boundary ${ev.boundary}) — resolved`);

const operator = await staff(c, workspace);
const evidence = await operator.query(api.maintenance.evidence, { eventId: ev.id });
const finding = evidence.event.finding as { location?: string[]; missing?: string[]; apiVersion?: string };
expect(finding.location?.some((l) => l.startsWith("src/mapping.js:")), `investigation location: ${finding.location}`);
step(6, `Investigated: 2027-01 lacks ${finding.missing?.join(", ")}; the adopted code reads it at ${finding.location?.join(", ")}`);
const fix = (evidence.corrections as any[])[0];
expect(fix?.kind === "adapter" && fix.status === "active" && fix.validation?.passed, `correction: ${JSON.stringify(fix).slice(0, 200)}`);
step(7, `Corrected by adapter "${fix.spec.adapter}" — validation passed (${fix.validation.checks.map((x: any) => x.name).join("; ")}); active`);

for (const o of [o1, o3]) {
  const d = (await c.query(api.deliveries.list, { integrationId })).deliveries.find((x) => x.sourceId === o.legacyId)!;
  const full = await c.query(api.deliveries.get, { deliveryId: d.id });
  expect(full.attempts[0]?.outcome === "held" && full.status === "delivered", `${o.name}: ${full.attempts.map((a) => a.outcome)}`);
}
step(8, `${o1.name} and ${o3.name}: first attempt held (input contract), then delivered through the adapter`);

const prices: Record<string, number> = { [o1.legacyId]: 7.25, [lost.legacyId]: 9.5, [o3.legacyId]: 11 };
for (const o of [o1, lost, o3]) {
  const recs = await netsuiteRecords(o.legacyId);
  expect(recs.length === 1, `${o.name}: ${recs.length} NetSuite records`);
  expect(recs[0]!.item.items[0]!.rate === prices[o.legacyId], `${o.name}: rate ${recs[0]!.item.items[0]!.rate}`);
}
step(9, `Each order is in NetSuite exactly once with Shopify's price (7.25, 9.50, 11.00), including the lost one`);

const customer = await c.query(api.maintenance.get, { eventId: ev.id });
expect(customer.accounting?.affected === 3 && customer.accounting.delivered === 3 && customer.accounting.unresolved === 0 && customer.accounting.duplicates === 0, `accounting ${JSON.stringify(customer.accounting)}`);
expect(!customer.customerAction, "customer action requested");
step(10, `Accounting: ${JSON.stringify(customer.accounting)}; no customer action; customer status ${customer.status}`);
step(11, "Customer timeline (no internals):", customer.timeline.map((t) => t.text));
const internal = JSON.stringify(customer);
expect(!/mapping\.js|adapter|correction|runtime/i.test(internal), "customer view leaks internals");
const operatorView = await operator.query(api.maintenance.get, { eventId: ev.id });
expect(JSON.stringify(operatorView) === internal, "operator and customer see different outcome projections");
step(12, "Operator sees the same customer projection plus the evidence behind it");

const acme = await company("Acme", `owner-${run}@acme.test`);
const denied = await acme.c.query(api.maintenance.get, { eventId: ev.id }).then(() => "allowed", (e) => e.code);
expect(denied !== "allowed", "another company can read the event");
step(13, `Another company is refused: ${denied}`);

const after = await newOrder(`#M-${run}-4`, "8.00");
await wait("2027-01 order flows normally", async () => (await netsuiteRecords(after.legacyId)).length === 1);
step(14, `A new 2027-01 order (${after.name}) now flows normally; status ${(await c.query(api.integrations.list)).integrations[0]!.status}`);
finish("maintenance");
