/**
 * S2 "adopted" (shared spec docs/experiment/SCENARIOS.md §S2), System B.
 * A company puts its Shopify → NetSuite order sync under management; a signed orders/create runs the adopted
 * upstream code; a rejection is represented as it is; another company is refused; the operator-side retry
 * recovers it once, and a duplicate retry is refused.
 */
import { api } from "../feltkit/_generated/api.ts";
import { FX, company, connectNetSuite, connectShopify, expect, finish, json, step, wait } from "./lib.ts";

const run = Date.now().toString(36);
const order = (name: string, sku: string) =>
  json(`${FX.shopify2}/__fixture/orders`, { method: "POST", body: { name, email: `buyer-${run}@bluewave.test`, lineItems: [{ sku, title: "Part", quantity: 3, unitPrice: "12.50" }] } });

// Shared precondition (SCENARIOS.md §S2): a non-OneWorld NetSuite account, as System A's seed sets it.
await json(`${FX.netsuite}/__fixture/config`, { method: "POST", body: { oneWorld: false } });
const blue = await company("Bluewave", `ops-${run}@bluewave.test`);
await connectShopify(blue.c, api, FX.shopify2);
await connectNetSuite(blue.c, api);
const conns = await blue.c.query(api.connections.list);
step(1, `Company ${blue.workspace} connected: ${conns.map((x) => `${x.provider}=${x.status}`).join(", ")}`);

const integrationId = await blue.c.mutation(api.integrations.adoptOrderSync, { defaultCustomer: "WEB" });
await wait("orders/create subscription", async () => {
  const s = await json(`${FX.shopify2}/__fixture/state`);
  return s.body.subscriptions.some((x: { callbackUrl: string }) => x.callbackUrl.includes(integrationId));
});
const listed = await blue.c.query(api.integrations.list);
step(2, `Adopted implementation attached: ${listed.integrations[0]!.upstream.repository} @ ${listed.integrations[0]!.upstream.commit.slice(0, 12)}; webhook subscribed`);

const ok = await order(`#B-${run}-1`, "SKU-RED");
const delivered = await wait("delivery 1", async () => {
  const l = await blue.c.query(api.deliveries.list, { integrationId });
  return l.deliveries.find((d) => d.sourceId === ok.body.legacyId && d.status === "delivered");
}).catch(async (e) => {
  console.error(JSON.stringify(await blue.c.query(api.deliveries.list, { integrationId }), null, 1), ok.body.legacyId);
  throw e;
});
const d1 = await blue.c.query(api.deliveries.get, { deliveryId: delivered.id });
step(3, `Signed orders/create → upstream code created NetSuite sales order ${delivered.destinationRef}`, d1.attempts);
const ns1 = await json(`${FX.netsuite}/services/rest/record/v1/salesOrder/eid:shopify-${ok.body.legacyId}`, { headers: { authorization: "Bearer x" } });
step(4, `Independent check: the simulator holds the record (read without credentials → ${ns1.status}; state below)`);
const nsState = await json(`${FX.netsuite}/__fixture/state`);
const recs = (nsState.body.salesOrders ?? []).filter((r: { externalId?: string }) => r.externalId === `shopify-${ok.body.legacyId}`);
expect(recs.length === 1, `expected exactly one NetSuite record for order 1, found ${recs.length}`);

const bad = await order(`#B-${run}-2`, "SKU-PURPLE");
const rejected = await wait("rejection of order 2", async () => {
  const l = await blue.c.query(api.deliveries.list, { integrationId });
  return l.deliveries.find((d) => d.sourceId === bad.body.legacyId && d.status === "rejected");
});
step(5, `Failure represented accurately: ${rejected.status} — "${rejected.reason}"`);

const acme = await company("Acme", `owner-${run}@acme.test`);
const denied = await acme.c.mutation(api.deliveries.retry, { deliveryId: rejected.id, reason: "not my company" }).then(
  () => null,
  (e: { code?: string; message?: string }) => `${e.code}: ${e.message}`,
);
step(6, `Another company is refused: ${denied ?? "ALLOWED (unexpected!)"}`);
expect(denied, "tenant isolation failed");

await json(`${FX.netsuite}/__fixture/items`, { method: "POST", body: { id: "104", code: "SKU-PURPLE" } });
step(7, "Simulator stand-in for the customer's fix: item SKU-PURPLE now exists in NetSuite");
const retry = await blue.c.mutation(api.deliveries.retry, { deliveryId: rejected.id, reason: "Item SKU-PURPLE now exists" });
const dup = await blue.c.mutation(api.deliveries.retry, { deliveryId: rejected.id, reason: "double click" }).then(
  () => "ACCEPTED (unexpected!)",
  (e: { code?: string }) => `refused (${e.code})`,
);
step(8, `Retry → ${JSON.stringify(retry)}; duplicate → ${dup}`);
expect(dup.startsWith("refused"), "duplicate retry was accepted");
const recovered = await wait("recovery of order 2", async () => {
  const l = await blue.c.query(api.deliveries.list, { integrationId });
  return l.deliveries.find((d) => d.id === rejected.id && d.status === "delivered");
});
const d2 = await blue.c.query(api.deliveries.get, { deliveryId: rejected.id });
step(9, `Recovered: NetSuite sales order ${recovered.destinationRef}`, d2.attempts.map((a) => ({ outcome: a.outcome, by: a.by })));
const ns2 = (await json(`${FX.netsuite}/__fixture/state`)).body.salesOrders.filter((r: { externalId?: string }) => r.externalId === `shopify-${bad.body.legacyId}`);
expect(ns2.length === 1, `expected exactly one NetSuite record for order 2, found ${ns2.length}`);
step(10, "Exactly one NetSuite record per order");
finish("adopted");
