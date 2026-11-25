/**
 * S8 "target" (docs/experiment/SCENARIOS.md §S8), System B: a TARGET-side change the adopted code cannot meet.
 * The customer's NetSuite becomes OneWorld and refuses every sales order without a subsidiary; the adopted
 * adapter has no way to send one. Orders are held (not rejected); only the customer may choose the
 * subsidiary; the choice becomes a validated configuration; a reviewed patch is validated over the whole path
 * and switched on by an operator; held orders are released once and verified; orders already in NetSuite are
 * untouched; rollback restores the pinned code.
 */
import { api } from "../feltkit/_generated/api.ts";
import { FX, adoptedCompany, company, expect, finish, json, staff, step, wait } from "./lib.ts";

type SalesOrder = { externalId: string | null; id: string; subsidiary?: { id: string } | null; item: { items: { rate: number }[] } };
const records = async (legacyId: string) =>
  ((await json(`${FX.netsuite}/__fixture/state`)).body.salesOrders as SalesOrder[]).filter((r) => r.externalId === `shopify-${legacyId}`);

const shop = FX.shopify4;
const co = await adoptedCompany(api, "Harbor", shop);
const { c, integrationId, run, workspace } = co;
const order = async (name: string, sku: string, price: string) =>
  (await json(`${shop}/__fixture/orders`, { method: "POST", body: { name, email: `buyer-${run}@harbor.test`, lineItems: [{ sku, title: "Part", quantity: 2, unitPrice: price }] } })).body as { legacyId: string; name: string };

try {
  const early = await order(`#T-${run}-0`, "SKU-RED", "12.50");
  await wait("baseline order delivered", async () => (await records(early.legacyId)).length === 1);
  step(1, `Baseline: ${early.name} delivered normally (no subsidiary: the account is not OneWorld)`);

  await json(`${FX.netsuite}/__fixture/subsidiaries`, { method: "POST", body: { id: "2", name: "Harbor Canada" } });
  await json(`${FX.netsuite}/__fixture/config`, { method: "POST", body: { oneWorld: true } });
  step(2, "Target change: the NetSuite account becomes OneWorld (a second subsidiary exists; every sales order needs one)");

  const o1 = await order(`#T-${run}-1`, "SKU-BLUE", "7.25");
  const ev = await wait("target event awaiting the customer", async () => {
    const e = (await c.query(api.maintenance.list, { integrationId })).find((x) => x.kind === "target_contract_change");
    if (!e) return null;
    const v = await c.query(api.maintenance.get, { eventId: e.id });
    return v.decision ? { ...e, view: v } : null;
  });
  const d1 = (await c.query(api.deliveries.list, { integrationId })).deliveries.find((x) => x.sourceId === o1.legacyId)!;
  expect(d1.status === "held", `${o1.name} should be held, is ${d1.status}`);
  expect((await records(o1.legacyId)).length === 0, "nothing written to NetSuite");
  expect(ev.boundary === "target", `boundary ${ev.boundary}`);
  step(3, `${o1.name}: NetSuite refused it for a subsidiary → held (not rejected); one event ${ev.id} (${ev.kind}, boundary ${ev.boundary})`);

  const options = ev.view.decision!.options.map((o) => o.label);
  expect(ev.view.status === "customer_action" && options.includes("Harbor Canada"), `customer view ${JSON.stringify(ev.view).slice(0, 300)}`);
  step(4, `Customer is asked: "${ev.view.decision!.question}" options ${JSON.stringify(options)} (read from their NetSuite)`);

  const operator = await staff(c, workspace);
  const opDecides = await operator.mutation(api.target.decide, { eventId: ev.id, decisionId: ev.view.decision!.id, optionId: "2" }).then(() => "allowed", (e) => e.code);
  expect(opDecides === "FORBIDDEN", `operator decided: ${opDecides}`);
  step(5, `Staff cannot answer the customer's business question: ${opDecides}`);

  await c.mutation(api.target.decide, { eventId: ev.id, decisionId: ev.view.decision!.id, optionId: "2" });
  const again = await c.mutation(api.target.decide, { eventId: ev.id, decisionId: ev.view.decision!.id, optionId: "1" }).then(() => "allowed", (e) => e.code);
  expect(again === "CONFLICT", `second answer: ${again}`);
  step(6, `Customer chose "Harbor Canada"; answering twice is refused (${again})`);

  const evidence = await wait("patch validated, awaiting an operator", async () => {
    const x = await operator.query(api.maintenance.evidence, { eventId: ev.id });
    return (x.event as { phase?: string }).phase === "await_operator" ? x : null;
  }, 60_000);
  const fixes = evidence.corrections as { id: string; kind: string; status: string; validation?: { checks: { name: string; result: string; detail: string }[] } }[];
  expect(JSON.stringify(fixes.map((x) => [x.kind, x.status])) === JSON.stringify([["decision", "active"], ["configuration", "active"], ["patch", "validated"]]), `corrections ${JSON.stringify(fixes.map((x) => [x.kind, x.status]))}`);
  const patch = fixes.find((x) => x.kind === "patch")!;
  expect(patch.validation!.checks.every((x) => x.result === "passed"), JSON.stringify(patch.validation));
  expect((await c.query(api.deliveries.list, { integrationId })).deliveries.find((x) => x.id === d1.id)!.status === "held", "released before activation");
  step(7, "Corrections: decision active → configuration validated and active → reviewed patch validated over the whole path; orders still held", patch.validation!.checks.map((x) => `${x.name}: ${x.result} (${x.detail})`));
  const where = (evidence.event as { finding?: { location?: string[] } }).finding?.location;
  expect(where?.some((l) => l.startsWith("src/adapters/netsuite.js:")), `location ${where}`);
  step(8, `Investigation names the adopted code that builds the body: ${where}`);

  await operator.mutation(api.corrections.activate, { correctionId: patch.id, reason: "reviewed: sends only the customer's chosen subsidiary" });
  const done = await wait("event resolved", async () => {
    const v = await c.query(api.maintenance.get, { eventId: ev.id });
    return v.status === "completed" ? v : null;
  }, 60_000);
  expect(done.accounting?.affected === 1 && done.accounting.delivered === 1 && done.accounting.unresolved === 0 && done.accounting.duplicates === 0, `accounting ${JSON.stringify(done.accounting)}`);
  step(9, `Operator activated the patch; held order released and verified: ${JSON.stringify(done.accounting)}`);

  const [r1] = await records(o1.legacyId);
  const [r0] = await records(early.legacyId);
  expect((await records(o1.legacyId)).length === 1 && r1!.subsidiary?.id === "2" && r1!.item.items[0]!.rate === 7.25, `o1 ${JSON.stringify(r1)}`);
  expect(!r0!.subsidiary?.id, `history rewritten: ${JSON.stringify(r0!.subsidiary)}`);
  step(10, `${o1.name} is in NetSuite once, subsidiary 2, rate 7.25; ${early.name} (written before the change) untouched`);

  const o2 = await order(`#T-${run}-2`, "SKU-RED", "12.50");
  await wait("new order flows", async () => (await records(o2.legacyId))[0]?.subsidiary?.id === "2");
  const d2 = (await c.query(api.deliveries.list, { integrationId })).deliveries.find((x) => x.sourceId === o2.legacyId)!;
  expect(d2.status === "delivered", `o2 ${d2.status}`);
  step(11, `A new order (${o2.name}) flows straight through with the chosen subsidiary`);

  const customerText = JSON.stringify(done);
  expect(!/netsuite\.js|patch|correction|runtime|configuration/i.test(customerText), `customer view leaks internals: ${customerText}`);
  step(12, "Customer timeline (no internals):", done.timeline.map((t) => t.text));

  const other = await company("Gulf", `owner-${run}@gulf.test`);
  const denied = await other.c.mutation(api.target.decide, { eventId: ev.id, decisionId: ev.view.decision!.id, optionId: "2" }).then(() => "allowed", (e) => e.code);
  const deniedRead = await other.c.query(api.maintenance.get, { eventId: ev.id }).then(() => "allowed", (e) => e.code);
  expect(denied !== "allowed" && deniedRead !== "allowed", "another company reached the event");
  step(13, `Another company is refused: decide ${denied}, read ${deniedRead}`);

  await operator.mutation(api.corrections.rollback, { correctionId: patch.id, reason: "rollback drill" });
  const inspected = await operator.query(api.corrections.inspect, { integrationId });
  const running = inspected.running;
  expect(!running.some((r) => r.startsWith("patch:")) && running.includes("configuration:subsidiaryId") && inspected.configuration.subsidiaryId === "2", `running ${running}`);
  step(14, `Rollback drill: the pinned adapter runs again (running: ${running.join(", ")}); the event's evidence stays`);
} finally {
  // The NetSuite simulator is shared by every scenario of a run: put the account back as the others expect it.
  await json(`${FX.netsuite}/__fixture/config`, { method: "POST", body: { oneWorld: false } });
}
finish("target");
