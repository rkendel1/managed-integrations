/**
 * Maintenance events: a change at a boundary that the integration must absorb. Opened by the runtime when it
 * holds work, advanced by the runtime component (investigate → correct → validate → recover → verify →
 * account), decided by people where only they can decide.
 */
import { fail, s } from "@feltdb/feltkit";
import type { MutationCtx } from "@feltdb/feltkit";
import { app, corrections, deliveries, events, integrations } from "./app.js";

type Boundary = "source" | "target" | "provider" | "integration" | "combined";

/** Open the event for this change, or join the one already open (one event per change, not per order). */
export async function openOrJoinEvent(
  ctx: MutationCtx,
  e: { integrationId: string; kind: string; boundary: Boundary; dedupeKey: string; finding: Record<string, unknown>; customerText: string },
): Promise<string> {
  const open = (await ctx.db.find(events, { dedupeKey: e.dedupeKey })).find((x) => x.status !== "resolved");
  if (open) return open.id;
  const now = Date.now();
  const id = await ctx.db.insert(events, {
    integrationId: e.integrationId,
    kind: e.kind,
    boundary: e.boundary,
    status: "detected",
    dedupeKey: e.dedupeKey,
    finding: e.finding,
    timeline: [
      { at: now, status: "detected", text: e.customerText, customerVisible: true },
      { at: now, status: "detected", text: `Detected at the ${e.boundary} boundary: ${JSON.stringify(e.finding)}`, customerVisible: false },
    ],
    openedAt: now,
  });
  await ctx.db.patch(integrations, e.integrationId, { status: "maintaining" });
  ctx.afterCommit.work("runtime", "maintain", { eventId: id }, { maxAttempts: 10 });
  return id;
}

const TimelineEntry = s.object({ at: s.number(), status: s.string(), text: s.string() });
const CustomerEvent = s.object({
  id: s.string(),
  integrationId: s.string(),
  status: s.string(),
  headline: s.string(),
  timeline: s.array(TimelineEntry),
  accounting: s.optional(s.object({ affected: s.integer(), delivered: s.integer(), unresolved: s.integer(), duplicates: s.integer() })),
  customerAction: s.boolean(),
  openedAt: s.number(),
  resolvedAt: s.optional(s.number()),
});

/** The customer's view: outcome and timeline only; no internals. */
export const get = app.query({
  access: "mi.read",
  args: { eventId: s.string() },
  returns: CustomerEvent,
  capability: { name: "maintenance.events.get", description: "What changed, what we did, and whether anything is needed from you." },
  handler: async (ctx, { eventId }) => {
    const e = await ctx.db.get(events, eventId);
    if (!e) fail("NOT_FOUND", "No such event.");
    const pending = await ctx.db.find(corrections, { eventId, kind: "decision", status: "proposed" });
    const visible = e.timeline.filter((t) => t.customerVisible).map(({ at, status, text }) => ({ at, status, text }));
    return {
      id: e.id,
      integrationId: e.integrationId,
      status: e.status === "resolved" ? "completed" : pending.some((p) => p.question?.authority === "customer") ? "customer_action" : "in_progress",
      headline: visible[0]?.text ?? "",
      timeline: visible,
      ...(e.accounting ? { accounting: e.accounting } : {}),
      customerAction: pending.some((p) => p.question?.authority === "customer"),
      openedAt: e.openedAt,
      ...(e.resolvedAt ? { resolvedAt: e.resolvedAt } : {}),
    };
  },
});

/** The operator's evidence: the full record behind the event, corrections and held work. */
export const evidence = app.query({
  access: "mi.read.evidence",
  args: { eventId: s.string() },
  returns: s.object({ event: s.record(s.unknown()), corrections: s.array(s.record(s.unknown())), affectedDeliveries: s.array(s.record(s.unknown())) }),
  capability: { name: "maintenance.events.evidence", description: "Operator evidence behind a maintenance event." },
  handler: async (ctx, { eventId }) => {
    const e = await ctx.db.get(events, eventId);
    if (!e) fail("NOT_FOUND", "No such event.");
    const fixes = (await ctx.db.find(corrections, { integrationId: e.integrationId })).filter((c) => c.eventId === eventId);
    const held = await ctx.db.find(deliveries, { integrationId: e.integrationId });
    return { event: e, corrections: fixes, affectedDeliveries: held.filter((d) => d.heldBy === eventId || d.attempts.some((x) => x.correction && fixes.some((f) => f.id === x.correction))) };
  },
});

export const list = app.query({
  access: "mi.read",
  args: { integrationId: s.optional(s.string()) },
  handler: async (ctx, { integrationId }) =>
    (await ctx.db.find(events, integrationId ? { integrationId } : {})).map((e) => ({ id: e.id, integrationId: e.integrationId, kind: e.kind, boundary: e.boundary, status: e.status, openedAt: e.openedAt, resolvedAt: e.resolvedAt ?? null })),
});
