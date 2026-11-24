/** Stripe → QuickBooks with the adopted ledgerly code: adoption and the runtime's records for it. */
import { fail, s } from "@feltdb/feltkit";
import { app, connections, corrections, integrations } from "./app.js";
import { openOrJoinEvent } from "./maintenance.js";

export const LEDGERLY = { repository: "github.com/jakethehoffer/ledgerly", commit: "3101182eadc9e3a94b6d9c2f5bb2d0dd299e4090", license: "MIT" } as const;

/** Put the company's Stripe → QuickBooks bookkeeping under management (Stripe and QuickBooks connected). */
export const adopt = app.mutation({
  access: "mi.configure",
  returns: s.string(),
  handler: async (ctx) => {
    if ((await ctx.db.find(integrations, { kind: "ledgerly" })).length) fail("CONFLICT", "Stripe → QuickBooks is already under management.");
    for (const provider of ["stripe", "quickbooks"] as const) {
      const [c] = await ctx.db.find(connections, { provider });
      if (!c || c.status !== "verified") fail("FAILED_PRECONDITION", `Connect ${provider === "stripe" ? "Stripe" : "QuickBooks"} first.`);
    }
    const id = await ctx.db.insert(integrations, {
      kind: "ledgerly",
      enabled: true,
      settings: {},
      status: "checking",
      upstream: { repository: LEDGERLY.repository, commit: LEDGERLY.commit },
      createdAt: Date.now(),
    });
    // Map ledgerly's accounts to the company's chart of accounts and subscribe to Stripe events.
    ctx.afterCommit.work("runtime", "ledgerly-setup", { integrationId: id }, { maxAttempts: 20 });
    return id;
  },
});

/* --------------------------------------------- runtime --------------------------------------------- */

export const settings = app.query({
  access: "mi.runtime",
  args: { integrationId: s.string() },
  handler: async (ctx, { integrationId }) => {
    const i = await ctx.db.get(integrations, integrationId);
    if (!i || i.kind !== "ledgerly") fail("NOT_FOUND", "No such integration.");
    return { id: i.id, enabled: i.enabled, settings: i.settings };
  },
});

export const setSettings = app.mutation({
  access: "mi.runtime",
  args: { integrationId: s.string(), settings: s.record(s.unknown()), status: s.optional(s.enum(["protected", "checking", "customer_action"])) },
  handler: async (ctx, a) => {
    const i = await ctx.db.get(integrations, a.integrationId);
    if (!i) fail("NOT_FOUND", "No such integration.");
    await ctx.db.patch(integrations, i.id, { settings: { ...i.settings, ...a.settings }, ...(a.status ? { status: a.status } : {}) });
    // Once set up, check the running code against the providers' published contracts.
    if (a.settings.accountMap && !i.settings.accountMap) ctx.afterCommit.work("runtime", "check-contracts", { integrationId: i.id }, { maxAttempts: 5 });
  },
});

export const activePatches = app.query({
  access: "mi.runtime",
  args: { integrationId: s.string() },
  returns: s.array(s.string()),
  handler: async (ctx, { integrationId }) =>
    (await ctx.db.find(corrections, { integrationId, status: "active" })).filter((c) => c.kind === "patch").map((c) => String(c.spec.patch)),
});

/** A provider contract the running code no longer meets (found by reading the running artifact). */
export const openProviderEvent = app.mutation({
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
      customerText: "QuickBooks retired something your bookkeeping code relied on. We are updating it; your books are unaffected.",
      phase: "correct",
    }),
});
