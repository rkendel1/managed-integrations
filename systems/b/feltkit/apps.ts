/** Hosted applications: their records, their operations (applications.invoke), and the runtime's writes. */
import { fail, s } from "@feltdb/feltkit";
import { app, appRecords, appRequests, corrections, deliveries, integrations, receipts } from "./app.js";
import { openOrJoinEvent } from "./maintenance.js";

const Invoked = s.object({
  requestId: s.string(),
  status: s.string(),
  replayed: s.boolean(),
  result: s.optional(s.record(s.unknown())),
});

/**
 * Run an operation of a hosted application (today: quickbooks-mcp's create_invoice). The same requestId is
 * answered with the first request's outcome and never runs twice.
 */
export const invoke = app.mutation({
  access: "mi.operate",
  args: { integrationId: s.string(), operation: s.enum(["create_invoice"]), requestId: s.string({ minLength: 1, maxLength: 120 }), input: s.record(s.unknown()) },
  returns: Invoked,
  capability: { name: "applications.invoke", description: "Run a hosted application's operation once per requestId; poll applications.request for the outcome." },
  handler: async (ctx, a) => {
    const i = await ctx.db.get(integrations, a.integrationId);
    if (!i || i.kind !== "qbo_tools") fail("NOT_FOUND", "No such application.");
    const [existing] = await ctx.db.find(appRequests, { integrationId: a.integrationId, requestId: a.requestId });
    if (existing) return { requestId: existing.requestId, status: existing.status, replayed: true, ...(existing.result ? { result: existing.result } : {}) };
    await ctx.db.insert(appRequests, {
      integrationId: a.integrationId, requestId: a.requestId, operation: a.operation, input: a.input, status: "queued", attempts: [],
      requestedBy: ctx.auth.requirePrincipal().id, updatedAt: Date.now(),
    });
    ctx.afterCommit.work("runtime", "app-invoke", { integrationId: a.integrationId, requestId: a.requestId }, { maxAttempts: 5 });
    return { requestId: a.requestId, status: "queued", replayed: false };
  },
});

export const request = app.query({
  access: "mi.read",
  args: { integrationId: s.string(), requestId: s.string() },
  returns: Invoked,
  capability: { name: "applications.request", description: "The outcome of an applications.invoke request." },
  handler: async (ctx, a) => {
    const [r] = await ctx.db.find(appRequests, { integrationId: a.integrationId, requestId: a.requestId });
    if (!r) fail("NOT_FOUND", "No such request.");
    return { requestId: r.requestId, status: r.status, replayed: false, ...(r.result ? { result: r.result } : {}) };
  },
});

export const records = app.query({
  access: "mi.read",
  args: { integrationId: s.string(), model: s.optional(s.string()) },
  returns: s.array(s.object({ model: s.string(), key: s.string(), data: s.record(s.unknown()), verified: s.optional(s.record(s.unknown())) })),
  capability: { name: "applications.records", description: "A hosted application's own records and how each compares with the provider." },
  handler: async (ctx, a) =>
    (await ctx.db.find(appRecords, a.model ? { integrationId: a.integrationId, model: a.model } : { integrationId: a.integrationId })).map((r) => ({ model: r.model, key: r.key, data: r.data, ...(r.verified ? { verified: r.verified } : {}) })),
});

/* --------------------------------------------- runtime --------------------------------------------- */

export const currentRecords = app.query({
  access: "mi.runtime",
  args: { integrationId: s.string() },
  handler: async (ctx, { integrationId }) => (await ctx.db.find(appRecords, { integrationId })).map((r) => ({ model: r.model, key: r.key, data: r.data, sourceEventId: r.sourceEventId ?? null })),
});

/** Commit one event's writes made by the application's own code, with the comparison against the provider. */
export const writeRecords = app.mutation({
  access: "mi.runtime",
  args: {
    integrationId: s.string(),
    sourceEventId: s.string(),
    writes: s.array(s.object({ model: s.string(), key: s.string(), row: s.record(s.unknown()), differs: s.array(s.string()) })),
  },
  handler: async (ctx, a) => {
    const now = Date.now();
    for (const w of a.writes) {
      const [r] = await ctx.db.find(appRecords, { integrationId: a.integrationId, model: w.model, key: w.key });
      const fields = { data: w.row, sourceEventId: a.sourceEventId, verified: { at: now, matches: !w.differs.length, differs: w.differs }, updatedAt: now };
      if (r) await ctx.db.patch(appRecords, r.id, fields);
      else await ctx.db.insert(appRecords, { integrationId: a.integrationId, model: w.model, key: w.key, ...fields });
    }
  },
});

/** Stored records differ from what the provider states, though the application answered success. */
export const openDataEvent = app.mutation({
  access: "mi.runtime",
  args: { integrationId: s.string(), contract: s.string(), finding: s.record(s.unknown()) },
  returns: s.string(),
  handler: async (ctx, a) =>
    openOrJoinEvent(ctx, {
      integrationId: a.integrationId,
      kind: "provider_contract",
      boundary: "provider",
      dedupeKey: `${a.integrationId}:provider:${a.contract}`,
      finding: a.finding,
      customerText: "Stripe changed the shape of some notifications your application relies on. We are correcting it; your customers are not affected.",
      phase: "correct",
    }),
});

export const requestContext = app.query({
  access: "mi.runtime",
  args: { integrationId: s.string(), requestId: s.string() },
  handler: async (ctx, a) => {
    const [r] = await ctx.db.find(appRequests, { integrationId: a.integrationId, requestId: a.requestId });
    if (!r) fail("NOT_FOUND", "No such request.");
    const i = await ctx.db.get(integrations, a.integrationId);
    return { request: { status: r.status, input: r.input, attempts: r.attempts.length }, settings: i?.settings ?? {} };
  },
});

export const recordRequest = app.mutation({
  access: "mi.runtime",
  args: {
    integrationId: s.string(), requestId: s.string(),
    outcome: s.enum(["running", "succeeded", "failed", "awaiting_authorization", "unknown"]),
    result: s.optional(s.record(s.unknown())), detail: s.optional(s.string()), correction: s.optional(s.string()),
  },
  handler: async (ctx, a) => {
    const [r] = await ctx.db.find(appRequests, { integrationId: a.integrationId, requestId: a.requestId });
    if (!r) fail("NOT_FOUND", "No such request.");
    let heldBy = r.heldBy;
    if (a.outcome === "awaiting_authorization")
      heldBy = await openOrJoinEvent(ctx, {
        integrationId: a.integrationId, kind: "authorization_lost", boundary: "target", dedupeKey: `${a.integrationId}:authorization:quickbooks`,
        finding: { provider: "quickbooks", detail: a.detail ?? null },
        customerText: "QuickBooks stopped accepting our access. Reconnect it; your request waits and runs once.", phase: "await_customer", customerAction: true,
      });
    await ctx.db.patch(appRequests, r.id, {
      status: a.outcome,
      ...(a.result ? { result: a.result } : {}),
      ...(heldBy ? { heldBy } : {}),
      attempts: a.outcome === "running" ? r.attempts : [...r.attempts, { at: Date.now(), outcome: a.outcome, ...(a.detail ? { detail: a.detail } : {}), ...(a.correction ? { correction: a.correction } : {}) }],
      updatedAt: Date.now(),
    });
  },
});

export const setStatus = app.mutation({
  access: "mi.runtime",
  args: { integrationId: s.string(), status: s.enum(["protected", "checking"]), settings: s.record(s.unknown()) },
  handler: async (ctx, a) => {
    const i = await ctx.db.get(integrations, a.integrationId);
    if (!i) fail("NOT_FOUND", "No such integration.");
    await ctx.db.patch(integrations, i.id, { status: a.status, settings: { ...i.settings, ...a.settings } });
    if (a.status === "protected" && i.kind === "qbo_tools" && !i.settings.releaseChecked) {
      await ctx.db.patch(integrations, i.id, { settings: { ...i.settings, ...a.settings, releaseChecked: true } });
      ctx.afterCommit.work("runtime", "check-app-release", { integrationId: i.id }, { maxAttempts: 5 });
    }
  },
});

export const activeDependencyChanges = app.query({
  access: "mi.runtime",
  args: { integrationId: s.string() },
  handler: async (ctx, { integrationId }) =>
    (await ctx.db.find(corrections, { integrationId, status: "active" })).filter((c) => c.kind === "patch" && c.spec.dependency).map((c) => ({ id: c.id, spec: c.spec })),
});

/** A reviewed upstream release of the adopted application: whether to follow it is a maintenance event. */
export const openReleaseEvent = app.mutation({
  access: "mi.runtime",
  args: { integrationId: s.string(), release: s.string(), finding: s.record(s.unknown()) },
  returns: s.string(),
  handler: async (ctx, a) =>
    openOrJoinEvent(ctx, {
      integrationId: a.integrationId,
      kind: "application_change",
      boundary: "integration",
      dedupeKey: `${a.integrationId}:release:${a.release}`,
      finding: a.finding,
      customerText: "The tools your assistant uses have a new upstream release. We are checking it before anything changes for you.",
      phase: "correct",
    }),
});

export const recentRequests = app.query({
  access: "mi.runtime",
  args: { integrationId: s.string() },
  handler: async (ctx, { integrationId }) =>
    (await ctx.db.find(appRequests, { integrationId })).sort((x, y) => y.updatedAt - x.updatedAt).map((r) => ({ requestId: r.requestId, status: r.status, input: r.input, attempts: r.attempts })),
});

/** Sealed Stripe events this application received at a given API version (for replay). */
export const earlierEvents = app.query({
  access: "mi.runtime",
  args: { integrationId: s.string(), apiVersion: s.string() },
  returns: s.array(s.string()),
  handler: async (ctx, { integrationId }) => {
    const out: string[] = [];
    for (const d of await ctx.db.find(deliveries, { integrationId, status: "delivered" })) {
      if (d.heldBy) continue;
      const r = await ctx.db.get(receipts, d.receiptId);
      if (r) out.push(r.sealed);
    }
    return out;
  },
});
