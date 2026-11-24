/**
 * Reconciliation: read the source for a window, classify every order against what was delivered, recover the
 * ones whose webhook never arrived, and verify each recovery in the target. The runtime component does the
 * provider reads; these functions own the records and the rules.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, deliveries, integrations, reconItems, reconRuns } from "./app.js";

const Run = s.object({
  id: s.string(),
  integrationId: s.string(),
  status: s.string(),
  window: s.object({ from: s.string(), to: s.string() }),
  counts: s.record(s.integer()),
  requestedBy: s.string(),
  startedAt: s.number(),
  finishedAt: s.optional(s.number()),
  error: s.optional(s.string()),
});
const Item = s.object({
  id: s.string(),
  sourceId: s.string(),
  reference: s.string(),
  classification: s.string(),
  recovery: s.string(),
  deliveryId: s.optional(s.string()),
  verifiedAt: s.optional(s.number()),
});
const runView = (r: any) => ({
  id: r.id, integrationId: r.integrationId, status: r.status, window: r.window, counts: r.counts, requestedBy: r.requestedBy, startedAt: r.startedAt,
  ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}), ...(r.error ? { error: r.error } : {}),
});
const itemView = (i: any) => ({
  id: i.id, sourceId: i.sourceId, reference: i.reference, classification: i.classification, recovery: i.recovery,
  ...(i.deliveryId ? { deliveryId: i.deliveryId } : {}), ...(i.verifiedAt ? { verifiedAt: i.verifiedAt } : {}),
});

export const start = app.mutation({
  access: "mi.operate",
  args: { integrationId: s.string(), from: s.optional(s.string()), to: s.optional(s.string()) },
  returns: s.object({ runId: s.string(), joined: s.boolean() }),
  capability: { name: "reconciliation.start", description: "Compare the source with what was delivered for a window; join a run already in progress." },
  handler: async (ctx, a) => {
    if (!(await ctx.db.get(integrations, a.integrationId))) fail("NOT_FOUND", "No such integration.");
    const [running] = await ctx.db.find(reconRuns, { integrationId: a.integrationId, status: "running" });
    if (running) return { runId: running.id, joined: true };
    const to = a.to ?? new Date(Date.now() + 60_000).toISOString();
    const from = a.from ?? new Date(Date.now() - 24 * 3600_000).toISOString();
    const runId = await ctx.db.insert(reconRuns, {
      integrationId: a.integrationId, status: "running", window: { from, to }, counts: {}, requestedBy: ctx.auth.requirePrincipal().id, startedAt: Date.now(),
    });
    ctx.afterCommit.work("runtime", "reconcile", { runId }, { maxAttempts: 5 });
    return { runId, joined: false };
  },
});

export const runs = app.query({
  access: "mi.read",
  args: { integrationId: s.string() },
  returns: s.object({ runs: s.array(Run) }),
  capability: { name: "reconciliation.runs", description: "Reconciliation runs with their classification counts, newest first." },
  handler: async (ctx, { integrationId }) => ({
    runs: (await ctx.db.find(reconRuns, { integrationId }, { orderBy: [{ field: "startedAt", direction: "desc" }] })).map(runView),
  }),
});

const ORDER = ["missing_delivery", "failed_delivery", "destination_exists_untracked", "pending_delivery", "excluded", "delivered"];
export const items = app.query({
  access: "mi.read",
  args: { runId: s.string() },
  returns: s.object({ items: s.array(Item) }),
  capability: { name: "reconciliation.items", description: "Items of a run, exceptions first." },
  handler: async (ctx, { runId }) => {
    if (!(await ctx.db.get(reconRuns, runId))) fail("NOT_FOUND", "No such run.");
    const rows = await ctx.db.find(reconItems, { runId });
    return { items: rows.sort((x, y) => ORDER.indexOf(x.classification) - ORDER.indexOf(y.classification)).map(itemView) };
  },
});

export const recover = app.mutation({
  access: "mi.operate",
  args: { runId: s.string(), sourceIds: s.array(s.string(), { minItems: 1, maxItems: 200 }) },
  returns: s.object({ accepted: s.array(s.string()), refused: s.array(s.object({ sourceId: s.string(), reason: s.string() })) }),
  capability: { name: "reconciliation.recover", description: "Recover orders classified missing_delivery (each once)." },
  handler: async (ctx, { runId, sourceIds }) => {
    if (!(await ctx.db.get(reconRuns, runId))) fail("NOT_FOUND", "No such run.");
    const accepted: string[] = [];
    const refused: { sourceId: string; reason: string }[] = [];
    for (const sourceId of sourceIds) {
      const [item] = await ctx.db.find(reconItems, { runId, sourceId });
      if (!item) refused.push({ sourceId, reason: "not in this run" });
      else if (item.classification !== "missing_delivery") refused.push({ sourceId, reason: `classified ${item.classification}` });
      else if (item.recovery !== "none") refused.push({ sourceId, reason: `recovery already ${item.recovery}` });
      else {
        await ctx.db.patch(reconItems, item.id, { recovery: "requested" });
        ctx.afterCommit.work("runtime", "recover", { itemId: item.id }, { maxAttempts: 5 });
        accepted.push(sourceId);
      }
    }
    return { accepted, refused };
  },
});

/* --------------------------------------------- runtime --------------------------------------------- */

export const runContext = app.query({
  access: "mi.runtime",
  args: { runId: s.string() },
  handler: async (ctx, { runId }) => {
    const r = await ctx.db.get(reconRuns, runId);
    if (!r) fail("NOT_FOUND", "No such run.");
    const i = await ctx.db.get(integrations, r.integrationId);
    return { ...runView(r), kind: i?.kind ?? null };
  },
});

/** Classify what the source holds for the window against our deliveries (one item per order). */
export const classify = app.mutation({
  access: "mi.runtime",
  args: {
    runId: s.string(),
    orders: s.array(s.object({ sourceId: s.string(), reference: s.string(), cancelled: s.boolean(), destinationExists: s.boolean() })),
  },
  handler: async (ctx, { runId, orders }) => {
    const run = await ctx.db.get(reconRuns, runId);
    if (!run || run.status !== "running") fail("FAILED_PRECONDITION", "Run is not running.");
    const counts: Record<string, number> = {};
    for (const o of orders) {
      const [d] = await ctx.db.find(deliveries, { idempotencyKey: `${run.integrationId}:${o.sourceId}` });
      const classification = o.cancelled
        ? "excluded"
        : d?.status === "delivered"
          ? "delivered"
          : d && (d.status === "rejected" || d.status === "failed")
            ? "failed_delivery"
            : d
              ? "pending_delivery"
              : o.destinationExists
                ? "destination_exists_untracked"
                : "missing_delivery";
      counts[classification] = (counts[classification] ?? 0) + 1;
      await ctx.db.insert(reconItems, {
        runId, integrationId: run.integrationId, sourceId: o.sourceId, reference: o.reference, classification, recovery: "none",
        ...(d ? { deliveryId: d.id } : {}),
      });
    }
    await ctx.db.patch(reconRuns, runId, { status: "completed", counts: { ...counts, discovered: orders.length }, finishedAt: Date.now() });
  },
});

export const runFailed = app.mutation({
  access: "mi.runtime",
  args: { runId: s.string(), error: s.string() },
  handler: async (ctx, { runId, error }) => {
    await ctx.db.patch(reconRuns, runId, { status: "failed", error, finishedAt: Date.now() });
  },
});

export const itemContext = app.query({
  access: "mi.runtime",
  args: { itemId: s.string() },
  handler: async (ctx, { itemId }) => {
    const i = await ctx.db.get(reconItems, itemId);
    if (!i) fail("NOT_FOUND", "No such item.");
    const integ = await ctx.db.get(integrations, i.integrationId);
    return { id: i.id, integrationId: i.integrationId, sourceId: i.sourceId, recovery: i.recovery, deliveryId: i.deliveryId ?? null, kind: integ?.kind ?? null };
  },
});

export const itemRecovering = app.mutation({
  access: "mi.runtime",
  args: { itemId: s.string(), deliveryId: s.string() },
  handler: async (ctx, { itemId, deliveryId }) => {
    await ctx.db.patch(reconItems, itemId, { deliveryId });
  },
});

/** The recovered order was read back from the target (or was not there). */
export const itemVerified = app.mutation({
  access: "mi.runtime",
  args: { itemId: s.string(), found: s.boolean() },
  handler: async (ctx, { itemId, found }) => {
    await ctx.db.patch(reconItems, itemId, found ? { recovery: "recovered", verifiedAt: Date.now() } : { recovery: "failed" });
  },
});
