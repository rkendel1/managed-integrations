/**
 * Corrections as operators see and act on them. Activation and rollback are people's decisions for patches
 * (an adapter that passed validation activates itself); every transition is recorded with who made it.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, corrections, integrations } from "./app.js";
import { activateCorrection } from "./maintenance.js";
import { ADOPTED } from "./integrations.js";
import { LEDGERLY } from "./ledgerly.js";

const Correction = s.object({
  id: s.string(),
  eventId: s.optional(s.string()),
  kind: s.string(),
  status: s.string(),
  spec: s.record(s.unknown()),
  validation: s.optional(s.record(s.unknown())),
  postActivation: s.optional(s.record(s.unknown())),
  history: s.array(s.object({ at: s.number(), from: s.string(), to: s.string(), by: s.string(), note: s.optional(s.string()) })),
});

export const inspect = app.query({
  access: "mi.read.evidence",
  args: { integrationId: s.string() },
  returns: s.object({ upstream: s.object({ repository: s.string(), commit: s.string(), license: s.string() }), running: s.array(s.string()), corrections: s.array(Correction) }),
  capability: { name: "adaptations.inspect", description: "The adopted code an integration runs and every correction applied to it." },
  handler: async (ctx, { integrationId }) => {
    const i = await ctx.db.get(integrations, integrationId);
    if (!i) fail("NOT_FOUND", "No such integration.");
    const all = await ctx.db.find(corrections, { integrationId });
    return {
      upstream: { ...i.upstream, license: i.kind === "ledgerly" ? LEDGERLY.license : ADOPTED.order_sync.license },
      running: all.filter((c) => c.status === "active").map((c) => `${c.kind}:${String(c.spec.adapter ?? c.spec.patch ?? c.id)}`),
      corrections: all.map((c) => ({
        id: c.id, kind: c.kind, status: c.status, spec: c.spec, history: c.history,
        ...(c.eventId ? { eventId: c.eventId } : {}),
        ...(c.validation ? { validation: c.validation } : {}),
        ...(c.postActivation ? { postActivation: c.postActivation } : {}),
      })),
    };
  },
});

export const activate = app.mutation({
  access: "mi.maintain",
  args: { correctionId: s.string(), reason: s.string({ minLength: 1, maxLength: 500 }) },
  returns: s.object({ status: s.string() }),
  capability: { name: "adaptations.activate", description: "Switch on a correction that passed validation (patches need a person)." },
  handler: async (ctx, { correctionId, reason }) => {
    await activateCorrection(ctx, correctionId, `${ctx.auth.requirePrincipal().id} (${reason})`);
    return { status: "active" };
  },
});

export const rollback = app.mutation({
  access: "mi.maintain",
  args: { correctionId: s.string(), reason: s.string({ minLength: 1, maxLength: 500 }) },
  returns: s.object({ status: s.string() }),
  capability: { name: "adaptations.rollback", description: "Switch off an active correction; the integration runs without it from the next delivery." },
  handler: async (ctx, { correctionId, reason }) => {
    const c = await ctx.db.get(corrections, correctionId);
    if (!c) fail("NOT_FOUND", "No such correction.");
    if (c.status !== "active") fail("FAILED_PRECONDITION", "Only an active correction can be rolled back.");
    await ctx.db.patch(corrections, c.id, { status: "rolled_back", history: [...c.history, { at: Date.now(), from: "active", to: "rolled_back", by: ctx.auth.requirePrincipal().id, note: reason }] });
    return { status: "rolled_back" };
  },
});

export const reject = app.mutation({
  access: "mi.maintain",
  args: { correctionId: s.string(), reason: s.string({ minLength: 1, maxLength: 500 }) },
  returns: s.object({ status: s.string() }),
  capability: { name: "adaptations.reject", description: "Reject a proposed or validated correction." },
  handler: async (ctx, { correctionId, reason }) => {
    const c = await ctx.db.get(corrections, correctionId);
    if (!c) fail("NOT_FOUND", "No such correction.");
    if (c.status !== "proposed" && c.status !== "validated") fail("FAILED_PRECONDITION", "Only a proposed or validated correction can be rejected.");
    await ctx.db.patch(corrections, c.id, { status: "rejected", history: [...c.history, { at: Date.now(), from: c.status, to: "rejected", by: ctx.auth.requirePrincipal().id, note: reason }] });
    return { status: "rejected" };
  },
});
