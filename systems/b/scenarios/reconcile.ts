/**
 * S3 "reconcile" (docs/experiment/SCENARIOS.md §S3), System B: an order whose webhook never arrives is found
 * by reconciliation, recovered once through the adopted code, and verified in NetSuite.
 */
import { api } from "../feltkit/_generated/api.ts";
import { FX, adoptedCompany, company, expect, finish, json, netsuiteRecords, step, wait } from "./lib.ts";

const bw = await adoptedCompany(api, "Bluewave", FX.shopify2);
const { c, integrationId, run } = bw;
const newOrder = async (name: string) =>
  (await json(`${FX.shopify2}/__fixture/orders`, { method: "POST", body: { name, email: "buyer@bluewave.test", lineItems: [{ sku: "SKU-RED", title: "Part", quantity: 2, unitPrice: "12.50" }] } })).body as { legacyId: string; name: string };

const a = await newOrder(`#R-${run}-1`);
await wait(`order ${a.name} delivered by webhook`, async () => (await netsuiteRecords(a.legacyId)).length === 1);
step(1, `Order ${a.name}: webhook received and delivered to NetSuite by the adopted code`);

await json(`${FX.shopify2}/__fixture/drop-webhooks`, { method: "POST", body: { n: 1 } });
const b = await newOrder(`#R-${run}-2`);
await new Promise((r) => setTimeout(r, 1000));
expect((await netsuiteRecords(b.legacyId)).length === 0, "order B reached NetSuite although its webhook was lost");
step(2, `Order ${b.name} created in Shopify; its webhook is lost in transit (simulator drop); NetSuite has no record`);

const started = await c.mutation(api.reconcile.start, { integrationId });
const run1 = await wait("run 1 completed", async () => (await c.query(api.reconcile.runs, { integrationId })).runs.find((r) => r.id === started.runId && r.status === "completed"));
step(3, `reconciliation.start → run ${run1.id}: ${JSON.stringify(run1.counts)} in ${run1.window.from} → ${run1.window.to}`);
const items1 = (await c.query(api.reconcile.items, { runId: run1.id })).items;
const ia = items1.find((i) => i.sourceId === a.legacyId);
const ib = items1.find((i) => i.sourceId === b.legacyId);
expect(ia?.classification === "delivered" && ib?.classification === "missing_delivery", `classification: A=${ia?.classification} B=${ib?.classification}`);
step(4, `${a.name} → delivered; ${b.name} → missing_delivery (exceptions listed first: ${items1[0]?.classification})`);

const rec = await c.mutation(api.reconcile.recover, { runId: run1.id, sourceIds: [b.legacyId] });
expect(rec.accepted.length === 1, `recover not accepted: ${JSON.stringify(rec)}`);
step(5, `reconciliation.recover for ${b.name}: accepted`);
const recovered = await wait("item recovered and verified", async () => (await c.query(api.reconcile.items, { runId: run1.id })).items.find((i) => i.sourceId === b.legacyId && i.recovery === "recovered" && i.verifiedAt));
step(6, `Recovered through the adopted code and verified by reading NetSuite back (delivery ${recovered.deliveryId})`);
const ns = await netsuiteRecords(b.legacyId);
expect(ns.length === 1, `expected exactly one NetSuite record for ${b.name}, found ${ns.length}`);
step(7, `NetSuite contains exactly one sales order for ${b.name}: id ${ns[0]!.id}`);

const s2 = await c.mutation(api.reconcile.start, { integrationId });
const run2 = await wait("run 2 completed", async () => (await c.query(api.reconcile.runs, { integrationId })).runs.find((r) => r.id === s2.runId && r.status === "completed"));
const ib2 = (await c.query(api.reconcile.items, { runId: run2.id })).items.find((i) => i.sourceId === b.legacyId);
expect(ib2?.classification === "delivered", `second run: ${ib2?.classification}`);
step(8, `Second run ${run2.id}: ${b.name} → delivered`);

const again1 = await c.mutation(api.reconcile.recover, { runId: run1.id, sourceIds: [b.legacyId] });
const again2 = await c.mutation(api.reconcile.recover, { runId: run2.id, sourceIds: [b.legacyId] });
expect(!again1.accepted.length && !again2.accepted.length, "a duplicate recovery was accepted");
expect((await netsuiteRecords(b.legacyId)).length === 1, "duplicate recovery created a second record");
step(9, `Duplicate recoveries refused (${again1.refused[0]?.reason}; ${again2.refused[0]?.reason}); still exactly one record`);

const acme = await company("Acme", `owner-${run}@acme.test`);
const refusedAll = await Promise.all([
  acme.c.query(api.reconcile.items, { runId: run1.id }).then(() => "allowed", (e) => e.code),
  acme.c.mutation(api.reconcile.recover, { runId: run1.id, sourceIds: [b.legacyId] }).then(() => "allowed", (e) => e.code),
  acme.c.mutation(api.reconcile.start, { integrationId }).then(() => "allowed", (e) => e.code),
]);
expect(!refusedAll.includes("allowed"), `cross-company call allowed: ${refusedAll}`);
step(10, `Another company is refused reconciliation.items / recover / start: ${refusedAll.join(", ")}`);
finish("reconcile");
