/**
 * Hosted applications that depend on one provider each:
 *  - stripe-webhooks-subscriptions-node-ts @ 4812d25 (MIT): its own event processor keeps its own records
 *    (subscriptions, invoices, payment intents) — here in FeltDB, through the Prisma stand-in.
 *  - quickbooks-mcp @ ce1317e (MIT): its create_invoice tool, with the node-quickbooks the deployment links.
 */
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

/** One AsyncLocalStorage per process, shared with the bundled stand-in through globalThis. */
function appStores(): AsyncLocalStorage<AppStore> {
  const slot = Symbol.for("mi.appStore");
  const g = globalThis as Record<symbol, AsyncLocalStorage<AppStore> | undefined>;
  return (g[slot] ??= new AsyncLocalStorage<AppStore>());
}
import Stripe from "stripe";
import { materialize, type Patch } from "./artifacts.ts";
import type { AppStore } from "./prisma-shim.ts";
import { QBO, type QboGrant, query } from "./quickbooks.ts";
import { stripeClient } from "./ledgerly.ts";

export const STRIPE_APP = {
  repository: "https://github.com/abdelrahmansapryalwtany/stripe-webhooks-subscriptions-node-ts",
  commit: "4812d259e7e8e1e57785f2e09be448e5e3ad92b1",
  license: "MIT",
  /** The application's own Stripe client version (src/stripe/stripe.ts) and webhook route (src/app.ts). */
  apiVersion: "2025-02-24.acacia",
  route: "/v1/stripe/webhook",
  processorFile: "src/webhooks/stripeEventProcessor.ts",
};
export const QBO_TOOLS = {
  repository: "https://github.com/laf-rge/quickbooks-mcp",
  commit: "ce1317e51d43fb669d73f6f874935fb7827e5ebd",
  license: "MIT",
  pinnedDependency: { name: "node-quickbooks", version: "2.0.48" },
};

/** Reviewed patch (System B's own review of the upstream processor against Stripe's basil changelog). */
export const APP_PATCHES: Record<string, Patch> = {
  "stripe-basil-field-locations": {
    id: "stripe-basil-field-locations",
    file: STRIPE_APP.processorFile,
    find: "export async function processStripeEvent(event: Stripe.Event) {\n  switch (event.type) {",
    replace: [
      "// Reviewed under management: Stripe API 2025-03-31.basil moved three fields this processor reads",
      "// (subscription period end -> subscription items; invoice subscription -> parent.subscription_details;",
      "// invoice paid -> status). Payloads that still carry the old fields pass through unchanged.",
      "function fromBasilLocations(event: Stripe.Event): Stripe.Event {",
      "  const o = event.data.object as any;",
      "  if (o.object === 'subscription' && o.current_period_end === undefined && o.items?.data?.length) {",
      "    const first = o.items.data[0];",
      "    return { ...event, data: { ...event.data, object: { ...o, current_period_start: first.current_period_start, current_period_end: first.current_period_end } } } as any;",
      "  }",
      "  if (o.object === 'invoice' && o.subscription === undefined && o.parent) {",
      "    const sub = o.parent.subscription_details?.subscription ?? null;",
      "    return { ...event, data: { ...event.data, object: { ...o, subscription: sub, paid: o.paid ?? o.status === 'paid' } } } as any;",
      "  }",
      "  return event;",
      "}",
      "",
      "export async function processStripeEvent(event: Stripe.Event) {",
      "  event = fromBasilLocations(event);",
      "  switch (event.type) {",
    ].join("\n"),
    reason: "Webhook bodies follow the endpoint's API version; under 2025-03-31.basil the processor stores null period ends, subscriptions and paid flags while answering 200.",
  },
};

export const stripeAppArtifact = (patchIds: string[]) =>
  materialize<{ processStripeEvent(e: unknown): Promise<{ outcome: string }> }>({
    pkg: "stripe-webhooks-subscriptions-node-ts",
    from: "vendor",
    entry: "mi-entry.ts",
    entrySource: "export { processStripeEvent } from './src/webhooks/stripeEventProcessor.js';\n",
    patches: patchIds.map((id) => APP_PATCHES[id]!).filter(Boolean),
    provide: [{ importPattern: "/db/prisma$", file: join(process.cwd(), "runtime", "prisma-shim.ts") }],
  });

type Row = Record<string, unknown>;
/** Run the application's processor for one event against `current` records; returns the writes it made. */
export async function processWith(patchIds: string[], event: unknown, current: (model: string, key: string) => Row | null) {
  const a = await stripeAppArtifact(patchIds);
  const writes = new Map<string, { model: string; key: string; row: Row }>();
  const store: AppStore = {
    read: (m, k) => writes.get(`${m}|${k}`)?.row ?? current(m, k),
    write: (m, k, row) => void writes.set(`${m}|${k}`, { model: m, key: k, row }),
  };
  const r = await appStores().run(store, () => a.module.processStripeEvent(event));
  return { outcome: r.outcome, writes: [...writes.values()], artifact: a.id };
}

/** What Stripe says about the records the application keeps (read at the application's own API version). */
export async function stripeTruth(apiKey: string, model: string, key: string): Promise<Row | null> {
  const s = stripeClient(apiKey);
  const opts = { apiVersion: STRIPE_APP.apiVersion } as Stripe.RequestOptions;
  if (model === "Subscription") {
    const sub = (await s.subscriptions.retrieve(key, {}, opts)) as any;
    const end = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;
    return { status: sub.status, currentPeriodEnd: end ? new Date(end * 1000).toISOString() : null, cancelAtPeriodEnd: sub.cancel_at_period_end ?? false };
  }
  if (model === "Invoice") {
    const inv = (await s.invoices.retrieve(key, {}, opts)) as any;
    const sub = typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id ?? inv.parent?.subscription_details?.subscription ?? null;
    return { status: inv.status ?? "unknown", stripeSubscriptionId: sub, paid: inv.paid ?? inv.status === "paid", amountDue: inv.amount_due ?? null };
  }
  return null;
}

/** Fields the application stored that differ from Stripe (only those Stripe's answer covers). */
export function differences(row: Row, truth: Row | null): string[] {
  if (!truth) return [];
  return Object.keys(truth).filter((f) => JSON.stringify(row[f] ?? null) !== JSON.stringify(truth[f] ?? null));
}

/* ----------------------------------------- QuickBooks tools ----------------------------------------- */

const qbToolsArtifact = (nodeQuickbooks: string) =>
  materialize<{ handleCreateInvoice(client: unknown, args: unknown): Promise<{ content: { type: string; text: string }[] }>; QuickBooks: any }>({
    pkg: "quickbooks-mcp",
    from: "vendor",
    entry: "mi-entry.ts",
    entrySource: "export { handleCreateInvoice } from './src/tools/handlers/invoice.js';\nexport { default as QuickBooks } from 'node-quickbooks';\n",
    patches: [],
    alias: { "node-quickbooks": `nqb-${nodeQuickbooks}` },
  });

export interface InvoiceInput {
  txn_date: string;
  customer_name: string;
  doc_number: string;
  lines: { item_name: string; amount?: number; qty?: number; unit_price?: number }[];
}

export async function findInvoiceByDoc(g: QboGrant, doc: string) {
  const r = await query<{ QueryResponse?: { Invoice?: { Id: string; DocNumber: string; TotalAmt: number }[] } }>(g, `select * from Invoice where DocNumber = '${doc.replace(/'/g, "\\'")}'`);
  return { status: r.status, invoice: r.body.QueryResponse?.Invoice?.[0] ?? null };
}

/**
 * Create one invoice with the adopted tool. The QuickBooks create is not idempotent: it is never sent twice
 * for one request. Before sending we look for the request's DocNumber; after an unclear failure we look again.
 */
export async function createInvoice(g: QboGrant, clientSecret: string, input: InvoiceInput, nodeQuickbooks: string, options: { baseUrl?: string } = {}) {
  const a = await qbToolsArtifact(nodeQuickbooks);
  const QB = a.module.QuickBooks;
  const client = new QB(QBO.clientId, clientSecret, g.accessToken, false, g.realmId, false, false, 75, "2.0", g.refreshToken);
  // node-quickbooks keeps its endpoint per client (set from a static at construction); set ours per call.
  client.endpoint = `${options.baseUrl ?? QBO.apiBase}/v3/company/`;
  // The tool previews unless draft is false: an invocation of create_invoice creates the invoice.
  const out = await a.module.handleCreateInvoice(client, { ...input, draft: false });
  return { text: out.content.map((c) => c.text).join("\n"), artifact: a.id };
}
