/**
 * Onboarding: connect → discover → confirm → activate → managed. Discovery looks for evidence that the
 * company already runs the adopted code (its writes in the target, by the code's own conventions); the
 * customer confirms a versioned list of what we will maintain; activation subscribes to the source and
 * takes a baseline of what the earlier deployment wrote.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, connections, deliveries, integrations, onboardings } from "./app.js";
import { createOrderSync } from "./integrations.js";
import { createLedgerly } from "./ledgerly.js";

const KINDS = {
  order_sync: {
    providers: ["shopify", "netsuite"] as const,
    summary: "Shopify orders → NetSuite sales orders (shopify-erp-order-sync)",
    responsibilities: {
      version: 1,
      maintain: ["Receive every Shopify order (webhook) and find any that were missed", "Run the adopted code to create the NetSuite sales order exactly once", "Adapt to Shopify and NetSuite changes and verify the result", "Tell you only when a decision is yours"],
      access: ["Shopify: read orders", "NetSuite: create and read sales orders (machine-to-machine certificate)"],
    },
    steps: ["integration", "webhook", "baseline"],
  },
  ledgerly: {
    providers: ["stripe", "quickbooks"] as const,
    summary: "Stripe transactions → QuickBooks journal entries (ledgerly)",
    responsibilities: {
      version: 1,
      maintain: ["Receive every Stripe event and find any that were missed", "Run the adopted code to book balanced journal entries exactly once", "Keep the code current with Stripe and QuickBooks and verify the books", "Tell you only when a decision is yours"],
      access: ["Stripe: restricted key (read events, charges, invoices, payouts; manage webhook endpoints)", "QuickBooks: accounting (create journal entries, read accounts)"],
    },
    steps: ["integration", "webhook", "baseline"],
  },
} as const;
type Kind = keyof typeof KINDS;

const Status = s.object({
  kind: s.string(),
  status: s.string(),
  next: s.string(),
  discovery: s.optional(s.record(s.unknown())),
  responsibilities: s.object({ version: s.integer(), maintain: s.array(s.string()), access: s.array(s.string()) }),
  integrationId: s.optional(s.string()),
  steps: s.record(s.string()),
});

async function view(ctx: any, kind: Kind) {
  const [o] = await ctx.db.find(onboardings, { kind });
  const conns = await ctx.db.find(connections, {});
  const missing = KINDS[kind].providers.filter((p) => !conns.some((c: any) => c.provider === p && c.status === "verified"));
  const [integ] = await ctx.db.find(integrations, { kind });
  const status = o?.status ?? "connect";
  const next =
    status === "connect" ? (missing.length ? `Connect ${missing.join(" and ")}` : "Find your integration")
    : status === "discovering" ? "Looking for your integration"
    : status === "confirm" ? "Confirm what we will maintain"
    : status === "activating" ? "Taking over: subscribing and checking recent history"
    : status === "managed" ? "Under management"
    : "Your integration could not be found; our team will contact you";
  return {
    kind, status, next,
    ...(o?.discovery ? { discovery: o.discovery } : {}),
    responsibilities: { version: KINDS[kind].responsibilities.version, maintain: [...KINDS[kind].responsibilities.maintain], access: [...KINDS[kind].responsibilities.access] },
    ...(integ ? { integrationId: integ.id } : {}),
    steps: (o?.steps ?? {}) as Record<string, string>,
  };
}

export const status = app.query({
  access: "mi.read",
  returns: s.object({ company: s.nullable(s.string()), integrations: s.array(Status) }),
  capability: { name: "onboarding.status", description: "Where this company is in onboarding, per integration." },
  handler: async (ctx) => ({ company: ctx.auth.tenant?.name ?? null, integrations: await Promise.all((Object.keys(KINDS) as Kind[]).map((k) => view(ctx, k))) }),
});

export const discover = app.mutation({
  access: "mi.configure",
  args: { kind: s.enum(["order_sync", "ledgerly"]) },
  returns: Status,
  capability: { name: "onboarding.discover", description: "Look for the integration this company already runs (needs its providers connected)." },
  handler: async (ctx, { kind }) => {
    const v = await view(ctx, kind);
    if (v.status === "managed") fail("FAILED_PRECONDITION", "Already under management.");
    const conns = await ctx.db.find(connections, {});
    if (KINDS[kind].providers.some((p) => !conns.some((c) => c.provider === p && c.status === "verified"))) fail("FAILED_PRECONDITION", v.next);
    const [o] = await ctx.db.find(onboardings, { kind });
    if (o) await ctx.db.patch(onboardings, o.id, { status: "discovering", discovery: undefined, updatedAt: Date.now() });
    else await ctx.db.insert(onboardings, { kind, status: "discovering", steps: {}, updatedAt: Date.now() });
    ctx.afterCommit.work("runtime", "discover", { kind }, { maxAttempts: 5 });
    return { ...v, status: "discovering", next: "Looking for your integration" };
  },
});

export const confirm = app.mutation({
  access: "mi.configure",
  args: { kind: s.enum(["order_sync", "ledgerly"]), candidateId: s.string(), responsibilitiesVersion: s.integer() },
  returns: Status,
  capability: { name: "onboarding.confirm", description: "Confirm we maintain the discovered integration under the listed responsibilities." },
  handler: async (ctx, a) => {
    const [o] = await ctx.db.find(onboardings, { kind: a.kind });
    if (!o || o.status !== "confirm") fail("FAILED_PRECONDITION", "Nothing to confirm.");
    if (a.responsibilitiesVersion !== KINDS[a.kind].responsibilities.version) fail("CONFLICT", "What we will maintain has changed; review it again.");
    const candidates = (o.discovery?.candidates as { id: string }[] | undefined) ?? [];
    if (!candidates.some((c) => c.id === a.candidateId)) fail("NOT_FOUND", "No such candidate.");
    const integrationId = a.kind === "order_sync" ? await createOrderSync(ctx, {}) : await createLedgerly(ctx);
    await ctx.db.patch(onboardings, o.id, { status: "activating", confirmedVersion: a.responsibilitiesVersion, steps: { integration: "done", webhook: "pending", baseline: "pending" }, updatedAt: Date.now() });
    ctx.afterCommit.work("runtime", "baseline", { kind: a.kind, integrationId }, { maxAttempts: 30 });
    return view(ctx, a.kind);
  },
});

/* --------------------------------------------- runtime --------------------------------------------- */

export const recordDiscovery = app.mutation({
  access: "mi.runtime",
  args: { kind: s.enum(["order_sync", "ledgerly"]), outcome: s.enum(["found", "not_found", "insufficient_evidence"]), evidence: s.record(s.unknown()) },
  handler: async (ctx, a) => {
    const [o] = await ctx.db.find(onboardings, { kind: a.kind });
    if (!o) fail("NOT_FOUND", "No onboarding.");
    const discovery = {
      outcome: a.outcome,
      candidates: a.outcome === "found" ? [{ id: `${a.kind}:1`, summary: KINDS[a.kind].summary, confidence: (a.evidence.matched as number) >= 3 ? "high" : "medium", evidence: a.evidence }] : [],
      evidence: a.evidence,
    };
    await ctx.db.patch(onboardings, o.id, { status: a.outcome === "found" ? "confirm" : "blocked", discovery, updatedAt: Date.now() });
  },
});

export const recordBaseline = app.mutation({
  access: "mi.runtime",
  args: { kind: s.enum(["order_sync", "ledgerly"]), webhook: s.boolean(), baseline: s.record(s.unknown()) },
  handler: async (ctx, a) => {
    const [o] = await ctx.db.find(onboardings, { kind: a.kind });
    if (!o) fail("NOT_FOUND", "No onboarding.");
    await ctx.db.patch(onboardings, o.id, {
      status: "managed",
      steps: { integration: "done", webhook: a.webhook ? "done" : "failed", baseline: "done" },
      discovery: { ...(o.discovery ?? {}), baseline: a.baseline },
      updatedAt: Date.now(),
    });
  },
});

export const deliveredSources = app.query({
  access: "mi.runtime",
  args: { integrationId: s.string() },
  returns: s.array(s.string()),
  handler: async (ctx, { integrationId }) => (await ctx.db.find(deliveries, { integrationId, status: "delivered" })).map((d) => d.sourceId),
});
