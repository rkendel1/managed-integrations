/** Reconciliation work: provider reads for a run, recovery of one order, and read-back verification. */
import type { ComponentWorkItem, ComponentWorkOutcome } from "@feltdb/feltkit/server";
import type { Runtime } from "./component.ts";
import { graphql, ordersCreatedBetween } from "./shopify.ts";
import { readSalesOrder } from "./netsuite.ts";
import { stripeClient } from "./ledgerly.ts";
import { grant, query } from "./quickbooks.ts";

const docNumber = (id: string) => (id.length <= 21 ? id : id.slice(-21));
async function inQuickBooks(rt: Runtime, ws: string, eventId: string) {
  const g = await grant(rt, ws, (rt as any).qboSecret ?? "");
  const r = await query<{ QueryResponse?: { JournalEntry?: unknown[] } }>(g, `select * from JournalEntry where DocNumber in ('${docNumber(eventId)}')`);
  return r.body.QueryResponse?.JournalEntry?.length ?? 0;
}
async function stripeFor(rt: Runtime, ws: string) {
  const c = await rt.call<{ sealed: string } | null>(ws, "runtime:sealedConnection", { provider: "stripe" });
  if (!c) throw new Error("Stripe is not connected");
  return stripeClient(rt.open<{ apiKey: string }>(ws, "connection:stripe", c.sealed).apiKey);
}

type Handler = (item: ComponentWorkItem, ws: string) => Promise<ComponentWorkOutcome>;

/** The webhook-shaped payload of one order, rebuilt from the Admin API (what the adopted code reads). */
async function orderPayload(rt: Runtime, ws: string, sourceId: string) {
  const shop = await rt.shopify(ws);
  if (!shop) throw new Error("Shopify is not connected");
  const { data } = await graphql<{ order: any }>(
    shop,
    `query($id:ID!){order(id:$id){legacyResourceId name createdAt updatedAt cancelledAt email note currencyCode customer{email}
      lineItems(first:100){nodes{sku title quantity originalUnitPriceSet{shopMoney{amount currencyCode}}}}}}`,
    { id: `gid://shopify/Order/${sourceId}` },
  );
  const o = data.order;
  if (!o) throw new Error(`order ${sourceId} not found in Shopify`);
  return {
    id: Number(o.legacyResourceId),
    name: o.name,
    created_at: o.createdAt,
    updated_at: o.updatedAt,
    cancelled_at: o.cancelledAt,
    email: o.email,
    customer: o.customer ? { email: o.customer.email } : null,
    currency: o.currencyCode,
    note: o.note,
    line_items: o.lineItems.nodes.map((l: any) => ({
      sku: l.sku,
      title: l.title,
      quantity: l.quantity,
      price: l.originalUnitPriceSet.shopMoney.amount,
      price_set: { shop_money: { amount: l.originalUnitPriceSet.shopMoney.amount, currency_code: l.originalUnitPriceSet.shopMoney.currencyCode } },
    })),
  };
}

export function handlers(get: () => Runtime): Record<string, Handler> {
  return {
    async reconcile(item, ws) {
      const rt = get();
      const runId = String(item.input.runId);
      const run = await rt.call(ws, "reconcile:runContext", { runId });
      if (run.status !== "running") return { outcome: "done" };
      try {
        if (run.kind === "ledgerly") {
          // Stripe's Events API for the window; an event we have no delivery for is checked in QuickBooks.
          const stripe = await stripeFor(rt, ws);
          const rows = [];
          for await (const e of stripe.events.list({ created: { gte: Math.floor(Date.parse(run.window.from) / 1000), lt: Math.ceil(Date.parse(run.window.to) / 1000) }, limit: 100 })) {
            rows.push({ sourceId: e.id, reference: e.type, cancelled: false, destinationExists: (await inQuickBooks(rt, ws, e.id)) > 0 });
          }
          await rt.call(ws, "reconcile:classify", { runId, orders: rows });
          return { outcome: "done", receipt: { discovered: rows.length } };
        }
        const shop = await rt.shopify(ws);
        if (!shop) throw new Error("Shopify is not connected");
        const { orders } = await ordersCreatedBetween(shop, run.window.from, run.window.to);
        const ns = await rt.netsuite(ws);
        const rows = [];
        for (const o of orders) {
          // Only an order we have no delivery for needs the target read (destination_exists_untracked).
          const exists = ns ? Boolean(await readSalesOrder(ns.cred, ns.token, `shopify-${o.legacyResourceId}`).catch(() => null)) : false;
          rows.push({ sourceId: o.legacyResourceId, reference: o.name, cancelled: Boolean(o.cancelledAt), destinationExists: exists });
        }
        await rt.call(ws, "reconcile:classify", { runId, orders: rows });
        return { outcome: "done", receipt: { discovered: rows.length } };
      } catch (err) {
        if (item.attempt >= 5) await rt.call(ws, "reconcile:runFailed", { runId, error: (err as Error).message });
        throw err;
      }
    },
    async recover(item, ws) {
      const rt = get();
      const itemId = String(item.input.itemId);
      const ctxItem = await rt.call(ws, "reconcile:itemContext", { itemId });
      if (ctxItem.deliveryId) return { outcome: "done", receipt: { already: ctxItem.deliveryId } };
      let r: { disposition: string; deliveryId?: string };
      if (ctxItem.kind === "ledgerly") {
        const event = await (await stripeFor(rt, ws)).events.retrieve(ctxItem.sourceId);
        r = await rt.call(ws, "runtime:ingest", {
          integrationId: ctxItem.integrationId, providerEventId: `reconciliation:${itemId}`, topic: event.type, sourceId: event.id,
          reference: event.type, sealed: rt.seal(ws, "receipt", event), origin: "reconciliation",
        });
      } else {
        const payload = await orderPayload(rt, ws, ctxItem.sourceId);
        r = await rt.call(ws, "runtime:ingest", {
          integrationId: ctxItem.integrationId,
          providerEventId: `reconciliation:${itemId}`,
          topic: "orders/create",
          sourceId: ctxItem.sourceId,
          reference: payload.name,
          sealed: rt.seal(ws, "receipt", payload),
          origin: "reconciliation",
        });
      }
      if (r.deliveryId) await rt.call(ws, "reconcile:itemRecovering", { itemId, deliveryId: r.deliveryId });
      return { outcome: "done", receipt: r };
    },
    async "verify-recovery"(item, ws) {
      const rt = get();
      const itemId = String(item.input.itemId);
      const i = await rt.call(ws, "reconcile:itemContext", { itemId });
      if (i.kind === "ledgerly") {
        const n = await inQuickBooks(rt, ws, i.sourceId);
        await rt.call(ws, "reconcile:itemVerified", { itemId, found: n === 1 });
        return { outcome: "done", receipt: { entries: n } };
      }
      const ns = await rt.netsuite(ws);
      if (!ns) return { outcome: "retry", error: { message: "NetSuite not connected" }, retryInMs: 5000 };
      const found = await readSalesOrder(ns.cred, ns.token, `shopify-${i.sourceId}`);
      await rt.call(ws, "reconcile:itemVerified", { itemId, found: Boolean(found) });
      return { outcome: "done", receipt: { found: Boolean(found) } };
    },
  };
}
