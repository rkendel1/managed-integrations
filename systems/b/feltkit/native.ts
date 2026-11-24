/**
 * The native sync: System B's own polling engine (Shopify orders → NetSuite sales orders through the adopted
 * NetSuite adapter). Its query is a declared specification (`engine`), so a provider schema change is repaired
 * by a reviewed change to that specification — proposed by a planner (EVE agent or playbook), validated by
 * System B, approved by a person, released as a canary.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, corrections, integrations, syncRuns } from "./app.js";
import { openOrJoinEvent } from "./maintenance.js";

export const ENGINE_V1 = { version: 1, priceField: "originalUnitPriceSet" };

export const adopt = app.mutation({
  access: "mi.configure",
  args: { since: s.optional(s.string()) },
  returns: s.string(),
  handler: async (ctx, a) => {
    if ((await ctx.db.find(integrations, { kind: "native_sync" })).length) fail("CONFLICT", "The native sync is already under management.");
    return ctx.db.insert(integrations, {
      kind: "native_sync",
      enabled: true,
      settings: { cursor: a.since ?? "1970-01-01T00:00:00.000Z", engine: ENGINE_V1, defaultCustomer: "WEB" },
      status: "protected",
      upstream: { repository: "managed-integrations/systems/b native engine", commit: `engine-v${ENGINE_V1.version}` },
      createdAt: Date.now(),
    });
  },
});

const Run = s.object({
  id: s.string(), status: s.string(), trigger: s.string(), engineVersion: s.integer(), canary: s.optional(s.integer()),
  cursorBefore: s.string(), cursorAfter: s.optional(s.string()), delivered: s.integer(),
  errorClass: s.optional(s.string()), errorMessage: s.optional(s.string()), startedAt: s.number(), finishedAt: s.optional(s.number()),
});

export const sync = app.mutation({
  access: "mi.operate",
  args: { integrationId: s.string() },
  returns: s.object({ runId: s.string() }),
  capability: { name: "native.sync", description: "Run the native sync now (orders updated since the cursor)." },
  handler: async (ctx, { integrationId }) => ({ runId: await startRun(ctx, integrationId, `requested by ${ctx.auth.requirePrincipal().id}`) }),
});

async function startRun(ctx: any, integrationId: string, trigger: string, canary?: number) {
  const i = await ctx.db.get(integrations, integrationId);
  if (!i || i.kind !== "native_sync") fail("NOT_FOUND", "No such integration.");
  const [running] = (await ctx.db.find(syncRuns, { integrationId })).filter((r: any) => r.status === "running");
  if (running) return running.id as string;
  const active = await activeEngine(ctx, integrationId, i.settings.engine);
  const runId = await ctx.db.insert(syncRuns, {
    integrationId, status: "running", trigger, engineVersion: active.version, ...(canary ? { canary } : {}),
    cursorBefore: String(i.settings.cursor), delivered: 0, records: [], startedAt: Date.now(),
  });
  ctx.afterCommit.work("runtime", "native-sync", { runId }, { maxAttempts: 3 });
  return runId as string;
}

/** The engine that runs: the active reviewed correction's specification, else the adopted one. */
async function activeEngine(ctx: any, integrationId: string, base: { version: number; priceField: string }) {
  const [c] = (await ctx.db.find(corrections, { integrationId, status: "active" })).filter((x: any) => x.kind === "patch" && x.spec.engine);
  return (c?.spec.engine as { version: number; priceField: string } | undefined) ?? base;
}

export const runs = app.query({
  access: "mi.read",
  args: { integrationId: s.string() },
  returns: s.object({ runs: s.array(Run) }),
  capability: { name: "native.runs", description: "Native sync runs, newest first." },
  handler: async (ctx, { integrationId }) => ({
    runs: (await ctx.db.find(syncRuns, { integrationId })).sort((a, b) => b.startedAt - a.startedAt).map((r) => ({
      id: r.id, status: r.status, trigger: r.trigger, engineVersion: r.engineVersion, cursorBefore: r.cursorBefore, delivered: r.delivered, startedAt: r.startedAt,
      ...(r.canary ? { canary: r.canary } : {}), ...(r.cursorAfter ? { cursorAfter: r.cursorAfter } : {}), ...(r.errorClass ? { errorClass: r.errorClass } : {}),
      ...(r.errorMessage ? { errorMessage: r.errorMessage } : {}), ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
    })),
  }),
});

export const run = app.query({
  access: "mi.read",
  args: { runId: s.string() },
  handler: async (ctx, { runId }) => {
    const r = await ctx.db.get(syncRuns, runId);
    if (!r) fail("NOT_FOUND", "No such run.");
    return r;
  },
});

/* --------------------------------------------- runtime --------------------------------------------- */

export const runContext = app.query({
  access: "mi.runtime",
  args: { runId: s.string() },
  handler: async (ctx, { runId }) => {
    const r = await ctx.db.get(syncRuns, runId);
    if (!r) fail("NOT_FOUND", "No such run.");
    const i = await ctx.db.get(integrations, r.integrationId);
    return { run: r, settings: i!.settings, engine: await activeEngine(ctx, r.integrationId, i!.settings.engine as any) };
  },
});

export const finishRun = app.mutation({
  access: "mi.runtime",
  args: {
    runId: s.string(), status: s.enum(["succeeded", "failed"]), cursorAfter: s.optional(s.string()),
    records: s.array(s.object({ sourceId: s.string(), reference: s.string(), outcome: s.string(), destinationRef: s.optional(s.string()) })),
    errorClass: s.optional(s.string()), errorMessage: s.optional(s.string()),
    affected: s.optional(s.array(s.object({ sourceId: s.string(), reference: s.string() }))),
    providerFields: s.optional(s.array(s.object({ name: s.string(), type: s.string() }))),
  },
  handler: async (ctx, a) => {
    const r = await ctx.db.get(syncRuns, a.runId);
    if (!r) fail("NOT_FOUND", "No such run.");
    const delivered = a.records.filter((x) => x.outcome === "delivered").length;
    await ctx.db.patch(syncRuns, r.id, {
      status: a.status, records: a.records, delivered, finishedAt: Date.now(),
      ...(a.cursorAfter ? { cursorAfter: a.cursorAfter } : {}), ...(a.errorClass ? { errorClass: a.errorClass } : {}), ...(a.errorMessage ? { errorMessage: a.errorMessage } : {}),
    });
    const i = await ctx.db.get(integrations, r.integrationId);
    if (a.status === "succeeded" && a.cursorAfter && !r.canary) await ctx.db.patch(integrations, r.integrationId, { settings: { ...i!.settings, cursor: a.cursorAfter } });
    if (a.status === "failed" && a.errorClass === "schema_drift") {
      await openOrJoinEvent(ctx, {
        integrationId: r.integrationId, kind: "schema_drift", boundary: "source",
        dedupeKey: `${r.integrationId}:schema_drift:${a.errorMessage}`,
        finding: {
          provider: "shopify", error: a.errorMessage ?? null, engine: i!.settings.engine, cursorHeld: r.cursorBefore,
          affectedOrders: a.affected ?? [], affectedOrderCount: a.affected?.length ?? 0, providerFields: a.providerFields ?? [],
        },
        customerText: "Shopify changed its API. Your orders are safe in Shopify and nothing was skipped; we are repairing the integration.",
        phase: "correct",
      });
    }
  },
});

/** Canary (one order) and promotion after an operator activated a reviewed engine change. */
export const startEngineRun = app.mutation({
  access: "mi.runtime",
  args: { integrationId: s.string(), trigger: s.string(), canary: s.optional(s.integer()) },
  returns: s.string(),
  handler: async (ctx, a) => startRun(ctx, a.integrationId, a.trigger, a.canary),
});
