/**
 * S9 "combined" (docs/experiment/SCENARIOS.md §S9), System B: a source change and a target change at once.
 * NetSuite becomes OneWorld (target) while Shopify moves line_items[].price (source, webhook version 2027-01).
 * Neither change releases held orders on part of the path: the source adapter is validated and switched on,
 * but its held order waits until the target change is corrected too. Corrected together, every order is
 * delivered exactly once, with Shopify's prices, in the subsidiary the customer chose.
 */
import { api } from "../feltkit/_generated/api.ts";
import { FX, adoptedCompany, expect, finish, json, staff, step, wait } from "./lib.ts";

type SalesOrder = { externalId: string | null; subsidiary?: { id: string } | null; item: { items: { rate: number }[] } };
const records = async (legacyId: string) =>
  ((await json(`${FX.netsuite}/__fixture/state`)).body.salesOrders as SalesOrder[]).filter((r) => r.externalId === `shopify-${legacyId}`);

const shop = FX.shopify5;
const co = await adoptedCompany(api, "Summit", shop);
const { c, integrationId, run, workspace } = co;
const order = async (name: string, sku: string, price: string) =>
  (await json(`${shop}/__fixture/orders`, { method: "POST", body: { name, email: `buyer-${run}@summit.test`, lineItems: [{ sku, title: "Part", quantity: 1, unitPrice: price }] } })).body as { legacyId: string; name: string };
const delivery = async (legacyId: string) => (await c.query(api.deliveries.list, { integrationId })).deliveries.find((x) => x.sourceId === legacyId);
const eventOf = async (kind: string) => (await c.query(api.maintenance.list, { integrationId })).find((x) => x.kind === kind);

try {
  const early = await order(`#C-${run}-0`, "SKU-RED", "12.50");
  await wait("baseline order delivered", async () => (await records(early.legacyId)).length === 1);
  step(1, `Baseline: ${early.name} delivered normally`);

  await json(`${FX.netsuite}/__fixture/subsidiaries`, { method: "POST", body: { id: "2", name: "Harbor Canada" } });
  await json(`${FX.netsuite}/__fixture/config`, { method: "POST", body: { oneWorld: true } });
  const o1 = await order(`#C-${run}-1`, "SKU-BLUE", "7.25");
  await wait("o1 held at the target", async () => (await delivery(o1.legacyId))?.status === "held");
  step(2, `Target change (OneWorld): ${o1.name} reached NetSuite, was refused for a subsidiary and is held`);

  await json(`${shop}/__fixture/webhook-version`, { method: "POST", body: { version: "2027-01" } });
  const o2 = await order(`#C-${run}-2`, "SKU-RED", "12.50");
  // The source event corrects itself (adapter validated and switched on) but must not release on part of the path.
  const operator = await staff(c, workspace);
  const S = await wait("source adapter active, release waiting", async () => {
    const e = await eventOf("input_contract_changed");
    if (!e) return null;
    const x = await operator.query(api.maintenance.evidence, { eventId: e.id });
    return (x.event as { phase?: string }).phase === "await_release" ? { ...e, x } : null;
  }, 30_000);
  const T = (await eventOf("target_contract_change"))!;
  expect((await delivery(o1.legacyId))!.status === "held" && (await delivery(o2.legacyId))!.status === "held", "an order was released on part of the path");
  expect((await records(o2.legacyId)).length === 0, "o2 reached NetSuite");
  const waitNote = (S.x.event as { timeline: { text: string }[] }).timeline.find((t) => /wait for the other open change/.test(t.text));
  expect(waitNote, "source event did not record that it waits");
  step(3, `Source change (2027-01): ${o2.name} held at the source; event ${S.id} switched its adapter on and waits: "${waitNote!.text}"`);
  step(4, `Two events, one per change: ${S.id} (source), ${T.id} (target); both orders still held`);

  const q = await wait("customer asked", async () => (await c.query(api.maintenance.get, { eventId: T.id })).decision);
  await c.mutation(api.target.decide, { eventId: T.id, decisionId: q.id, optionId: "2" });
  step(5, `Customer chose "${q.options.find((o) => o.id === "2")!.label}"`);

  const ev = await wait("target patch validated over the whole path", async () => {
    const x = await operator.query(api.maintenance.evidence, { eventId: T.id });
    return (x.event as { phase?: string }).phase === "await_operator" ? x : null;
  }, 60_000);
  const patch = (ev.corrections as { id: string; kind: string; status: string; validation: { checks: { name: string; result: string; detail: string }[] } }[]).find((x) => x.kind === "patch")!;
  expect(patch.validation.checks[0]!.result === "passed" && patch.validation.checks[0]!.detail === "2/2 held orders", JSON.stringify(patch.validation.checks[0]));
  expect(patch.validation.checks.every((x) => x.result === "passed"), JSON.stringify(patch.validation));
  step(6, `Patch validated over the whole path: "${patch.validation.checks[0]!.detail}" (the source-held order through the adapter, the mapping and the patched adapter)`);

  await operator.mutation(api.corrections.activate, { correctionId: patch.id, reason: "reviewed" });
  await wait("both events resolved", async () => {
    const l = await c.query(api.maintenance.list, { integrationId });
    return l.length === 2 && l.every((e) => e.status === "resolved");
  }, 90_000);
  const acc = await Promise.all([S.id, T.id].map(async (id) => (await c.query(api.maintenance.get, { eventId: id })).accounting!));
  expect(acc.every((a) => a.unresolved === 0 && a.duplicates === 0), `accounting ${JSON.stringify(acc)}`);
  step(7, `Operator activated the patch; both events resolved: source ${JSON.stringify(acc[0])}, target ${JSON.stringify(acc[1])}`);

  for (const [o, price] of [[o1, 7.25], [o2, 12.5]] as const) {
    const recs = await records(o.legacyId);
    expect(recs.length === 1 && recs[0]!.subsidiary?.id === "2" && recs[0]!.item.items[0]!.rate === price, `${o.name}: ${JSON.stringify(recs)}`);
  }
  expect(!(await records(early.legacyId))[0]!.subsidiary?.id, "history rewritten");
  step(8, `Every order exactly once with Shopify's price, in subsidiary 2 (${o1.name} 7.25, ${o2.name} 12.50); ${early.name} untouched`);
} finally {
  await json(`${FX.netsuite}/__fixture/config`, { method: "POST", body: { oneWorld: false } });
}
finish("combined");
