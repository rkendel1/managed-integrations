/**
 * Onboarding work: discovery (evidence that the adopted code already runs for this company, by its own
 * conventions in the target) and the activation baseline (what the earlier deployment wrote).
 */
import type { ComponentWorkItem, ComponentWorkOutcome } from "@feltdb/feltkit/server";
import type { Runtime } from "./component.ts";
import { graphql, ordersCreatedBetween } from "./shopify.ts";
import { readSalesOrder } from "./netsuite.ts";
import { entriesFor, stripeClient } from "./ledgerly.ts";
import { grant, query } from "./quickbooks.ts";

type Handler = (item: ComponentWorkItem, ws: string) => Promise<ComponentWorkOutcome>;
const DAYS = 7;
const SAMPLE = 50;

async function orderSyncHistory(rt: Runtime, ws: string) {
  const shop = await rt.shopify(ws);
  const ns = await rt.netsuite(ws);
  if (!shop || !ns) throw new Error("Shopify and NetSuite must be connected");
  const { orders } = await ordersCreatedBetween(shop, new Date(Date.now() - DAYS * 86400_000).toISOString(), new Date(Date.now() + 60_000).toISOString());
  const sample = orders.slice(-SAMPLE);
  const inTarget: string[] = [];
  for (const o of sample) if (await readSalesOrder(ns.cred, ns.token, `shopify-${o.legacyResourceId}`)) inTarget.push(o.legacyResourceId);
  return { checked: sample.length, inTarget };
}

async function ledgerlyHistory(rt: Runtime, ws: string, qboSecret: string) {
  const c = await rt.call<{ sealed: string } | null>(ws, "runtime:sealedConnection", { provider: "stripe" });
  if (!c) throw new Error("Stripe must be connected");
  const stripe = stripeClient(rt.open<{ apiKey: string }>(ws, "connection:stripe", c.sealed).apiKey);
  const g = await grant(rt, ws, qboSecret);
  const events: { id: string; type: string }[] = [];
  for await (const e of stripe.events.list({ created: { gte: Math.floor(Date.now() / 1000) - DAYS * 86400 }, limit: 100 })) {
    events.push({ id: e.id, type: e.type });
    if (events.length >= SAMPLE) break;
  }
  const inTarget: string[] = [];
  for (const e of events) {
    const doc = e.id.length <= 21 ? e.id : e.id.slice(-21);
    const r = await query<{ QueryResponse?: { JournalEntry?: unknown[] } }>(g, `select * from JournalEntry where DocNumber in ('${doc}')`);
    if (r.body.QueryResponse?.JournalEntry?.length) inTarget.push(e.id);
  }
  // What belongs in QuickBooks is what the adopted code books: ask it (expansion + mapping, nothing sent).
  const bookable: string[] = [];
  for (const e of events) {
    const full = await stripe.events.retrieve(e.id);
    if ((await entriesFor(full as any, rt.open<{ apiKey: string }>(ws, "connection:stripe", c.sealed).apiKey)) > 0) bookable.push(e.id);
  }
  return { checked: bookable.length, inTarget: inTarget.filter((id) => bookable.includes(id)) };
}

export function handlers(get: () => Runtime, qboSecret: () => string): Record<string, Handler> {
  return {
    async discover(item, ws) {
      const rt = get();
      const kind = String(item.input.kind) as "order_sync" | "ledgerly" | "stripe_app" | "qbo_tools";
      if (kind === "stripe_app") {
        // The application's own webhook route at Stripe identifies a deployment of it.
        const c = await rt.call<{ sealed: string } | null>(ws, "runtime:sealedConnection", { provider: "stripe" });
        const stripe = stripeClient(rt.open<{ apiKey: string }>(ws, "connection:stripe", c!.sealed).apiKey);
        const eps = (await stripe.webhookEndpoints.list({ limit: 100 })).data.filter((e) => new URL(e.url).pathname === "/v1/stripe/webhook");
        await rt.call(ws, "onboarding:recordDiscovery", { kind, outcome: eps.length ? "found" : "not_found", evidence: { matched: eps.length ? 3 : 0, endpoints: eps.map((e) => ({ url: e.url, apiVersion: e.api_version, events: e.enabled_events })), convention: "a Stripe webhook endpoint at the application's route /v1/stripe/webhook" } });
        return { outcome: "done" };
      }
      if (kind === "qbo_tools") {
        const g = await grant(rt, ws, qboSecret());
        const r = await query<{ QueryResponse?: { CompanyInfo?: { CompanyName: string }[] } }>(g, "select * from CompanyInfo");
        await rt.call(ws, "onboarding:recordDiscovery", { kind, outcome: r.status === 200 ? "found" : "insufficient_evidence", evidence: { matched: 3, company: r.body.QueryResponse?.CompanyInfo?.[0]?.CompanyName ?? null, convention: "QuickBooks connected; the tools act on this company" } });
        return { outcome: "done" };
      }
      const h = kind === "order_sync" ? await orderSyncHistory(rt, ws) : await ledgerlyHistory(rt, ws, qboSecret());
      const convention = kind === "order_sync" ? "NetSuite sales orders with external id shopify-<order id> (the adopted code's upsert key)" : "QuickBooks journal entries with DocNumber = the Stripe event id's last 21 characters (ledgerly's rule)";
      await rt.call(ws, "onboarding:recordDiscovery", {
        kind,
        outcome: h.checked === 0 ? "insufficient_evidence" : h.inTarget.length ? "found" : "not_found",
        evidence: { checked: h.checked, matched: h.inTarget.length, convention, windowDays: DAYS },
      });
      return { outcome: "done", receipt: { checked: h.checked, matched: h.inTarget.length } };
    },
    async baseline(item, ws) {
      const rt = get();
      const kind = String(item.input.kind) as "order_sync" | "ledgerly";
      // The webhook subscription is made by the integration's own setup work; wait for it to exist.
      const s = await rt.call(ws, "integrations:list", {});
      const integ = s.integrations.find((i: any) => i.id === item.input.integrationId);
      if (!integ || integ.status === "checking") return { outcome: "retry", error: { message: "waiting for setup" }, retryInMs: 500 };
      let webhook = true;
      if (kind === "order_sync") {
        // The subscription must exist at Shopify (read back, not assumed).
        const shop = await rt.shopify(ws);
        const subs = shop ? await graphql<{ webhookSubscriptions: { nodes: { callbackUrl: string }[] } }>(shop, "{webhookSubscriptions(first:50){nodes{callbackUrl}}}", {}) : null;
        webhook = Boolean(subs?.data.webhookSubscriptions.nodes.some((n) => n.callbackUrl.endsWith(`/rt/hooks/shopify/${ws}/${String(item.input.integrationId)}`)));
        if (!webhook) return { outcome: "retry", error: { message: "waiting for the Shopify subscription" }, retryInMs: 500 };
      }
      const h = kind === "order_sync" ? await orderSyncHistory(rt, ws) : await ledgerlyHistory(rt, ws, qboSecret());
      const ours = await rt.call(ws, "onboarding:deliveredSources", { integrationId: String(item.input.integrationId) });
      const previouslyDelivered = h.inTarget.filter((id) => !ours.includes(id)).length;
      await rt.call(ws, "onboarding:recordBaseline", {
        kind,
        webhook,
        baseline: { checked: h.checked, accountedFor: h.inTarget.length, previouslyDelivered, missing: h.checked - h.inTarget.length },
      });
      return { outcome: "done" };
    },
  };
}
