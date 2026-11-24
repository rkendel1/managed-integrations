/**
 * Maintenance events: a change at a boundary that the integration must absorb. Opened by the runtime when it
 * holds work, advanced by the runtime component (investigate → correct → validate → recover → verify →
 * account), decided by people where only they can decide.
 */
import { fail, s } from "@feltdb/feltkit";
import type { MutationCtx } from "@feltdb/feltkit";
import { app, appRequests, corrections, deliveries, events, integrations, receipts, reconItems, reconRuns } from "./app.js";

type Boundary = "source" | "target" | "provider" | "integration" | "combined";

/** Open the event for this change, or join the one already open (one event per change, not per order). */
export async function openOrJoinEvent(
  ctx: MutationCtx,
  e: { integrationId: string; kind: string; boundary: Boundary; dedupeKey: string; finding: Record<string, unknown>; customerText: string; phase?: string; customerAction?: boolean },
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
    ...(e.phase ? { phase: e.phase } : {}),
    ...(e.customerAction ? { status: "requires_action" as const } : {}),
    finding: e.finding,
    timeline: [
      { at: now, status: "detected", text: e.customerText, customerVisible: true },
      { at: now, status: "detected", text: `Detected at the ${e.boundary} boundary: ${JSON.stringify(e.finding)}`, customerVisible: false },
    ],
    openedAt: now,
  });
  await ctx.db.patch(integrations, e.integrationId, { status: e.customerAction ? "customer_action" : "maintaining" });
  if (!e.customerAction) ctx.afterCommit.work("runtime", "maintain", { eventId: id }, { maxAttempts: 100 });
  return id;
}

/** The customer reconnected a target: its access events continue (recover what was lost, verify, account). */
export async function resumeAccessEvents(ctx: MutationCtx, provider: string) {
  for (const e of await ctx.db.find(events, { kind: "authorization_lost" })) {
    if (e.status === "resolved" || (e.finding as { provider?: string } | undefined)?.provider !== provider) continue;
    await ctx.db.patch(events, e.id, {
      status: "recovery",
      phase: "recover",
      timeline: [
        ...e.timeline,
        { at: Date.now(), status: "recovery", text: `${provider} reconnected by the customer`, customerVisible: false },
        { at: Date.now(), status: "recovery", text: "Thanks for reconnecting. We are delivering everything that waited and checking nothing was missed.", customerVisible: true },
      ],
    });
    await ctx.db.patch(integrations, e.integrationId, { status: "maintaining" });
    ctx.afterCommit.work("runtime", "maintain", { eventId: e.id }, { maxAttempts: 100 });
  }
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
      status: e.status === "resolved" ? "completed" : e.phase === "await_customer" || pending.some((p) => p.question?.authority === "customer") ? "customer_action" : "in_progress",
      headline: visible[0]?.text ?? "",
      timeline: visible,
      ...(e.accounting ? { accounting: e.accounting } : {}),
      customerAction: e.phase === "await_customer" || pending.some((p) => p.question?.authority === "customer"),
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

/* ------------------------------------------- runtime driver ------------------------------------------- */

const note = (text: string, customerVisible = false, status = "investigating") => ({ at: Date.now(), status, text, customerVisible });

/** Everything the driver needs about one event: the event, its corrections, and the work it holds. */
export const eventContext = app.query({
  access: "mi.runtime",
  args: { eventId: s.string() },
  handler: async (ctx, { eventId }) => {
    const e = await ctx.db.get(events, eventId);
    if (!e) fail("NOT_FOUND", "No such event.");
    const fixes = (await ctx.db.find(corrections, { integrationId: e.integrationId })).filter((c) => c.eventId === eventId);
    const all = await ctx.db.find(deliveries, { integrationId: e.integrationId });
    const affected = all.filter((d) => d.heldBy === eventId);
    const sealed = [];
    for (const d of affected) {
      const r = await ctx.db.get(receipts, d.receiptId);
      if (r) sealed.push({ deliveryId: d.id, sourceId: d.sourceId, sealed: r.sealed, apiVersion: r.apiVersion ?? null });
    }
    const integ = await ctx.db.get(integrations, e.integrationId);
    const lastDelivered = all.filter((d) => d.status === "delivered").sort((x, y) => y.updatedAt - x.updatedAt)[0];
    const lastReceipt = lastDelivered ? await ctx.db.get(receipts, lastDelivered.receiptId) : null;
    const heldRequests = (await ctx.db.find(appRequests, { integrationId: e.integrationId })).filter((r) => r.heldBy === eventId);
    return {
      heldRequests: heldRequests.map((r) => ({ requestId: r.requestId, status: r.status, result: r.result ?? null })),
      integrationKind: integ?.kind ?? null,
      lastDeliveredReceipt: lastReceipt ? lastReceipt.sealed : null,
      deliveredAttemptsSince: all.flatMap((d) => d.attempts.filter((a) => a.outcome === "delivered" && a.at >= e.openedAt).map((a) => ({ deliveryId: d.id, at: a.at, correction: a.correction ?? null, detail: a.detail ?? null }))),
      event: { id: e.id, kind: e.kind, integrationId: e.integrationId, status: e.status, phase: e.phase ?? "investigate", finding: e.finding ?? {}, openedAt: e.openedAt, reconRunId: e.reconRunId ?? null },
      corrections: fixes.map((c) => ({ id: c.id, kind: c.kind, status: c.status, spec: c.spec, validation: c.validation ?? null })),
      affected: affected.map((d) => ({ id: d.id, sourceId: d.sourceId, reference: d.reference, status: d.status, destinationRef: d.destinationRef ?? null })),
      receipts: sealed,
    };
  },
});

export const recordInvestigation = app.mutation({
  access: "mi.runtime",
  args: { eventId: s.string(), location: s.array(s.string()), summary: s.string() },
  handler: async (ctx, { eventId, location, summary }) => {
    const e = await ctx.db.get(events, eventId);
    if (!e) fail("NOT_FOUND", "No such event.");
    await ctx.db.patch(events, eventId, {
      status: "investigating",
      phase: "correct",
      finding: { ...(e.finding ?? {}), location, summary },
      timeline: [...e.timeline, note(`Investigated: ${summary} (adopted code reads it at ${location.join(", ")})`)],
    });
  },
});

export const proposeCorrection = app.mutation({
  access: "mi.runtime",
  args: { eventId: s.string(), kind: s.enum(["adapter", "patch", "configuration", "unsupported"]), scopeKey: s.string(), spec: s.record(s.unknown()), reason: s.string() },
  returns: s.string(),
  handler: async (ctx, a) => {
    const e = await ctx.db.get(events, a.eventId);
    if (!e) fail("NOT_FOUND", "No such event.");
    const now = Date.now();
    const status = a.kind === "unsupported" ? "unsupported" : "proposed";
    const id = await ctx.db.insert(corrections, {
      integrationId: e.integrationId, eventId: a.eventId, kind: a.kind, status, scopeKey: a.scopeKey, spec: a.spec,
      history: [{ at: now, from: "none", to: status, by: "runtime", note: a.reason }], createdAt: now,
    });
    await ctx.db.patch(events, a.eventId, {
      phase: a.kind === "unsupported" ? "requires_action" : "validate",
      ...(a.kind === "unsupported" ? { status: "requires_action" } : {}),
      timeline: [...e.timeline, note(`Correction ${id} proposed (${a.kind}): ${a.reason}`, false, a.kind === "unsupported" ? "requires_action" : "investigating")],
    });
    return id;
  },
});

export const recordValidation = app.mutation({
  access: "mi.runtime",
  args: { correctionId: s.string(), checks: s.array(s.object({ name: s.string(), result: s.enum(["passed", "failed", "not_applicable"]), detail: s.string() })) },
  handler: async (ctx, { correctionId, checks }) => {
    const c = await ctx.db.get(corrections, correctionId);
    if (!c || (c.status !== "proposed" && c.status !== "validating")) fail("FAILED_PRECONDITION", "Correction is not awaiting validation.");
    const passed = checks.every((x) => x.result === "passed");
    const failed = checks.some((x) => x.result === "failed");
    const to = failed ? "rejected" : "validated";
    await ctx.db.patch(corrections, c.id, {
      status: to,
      validation: { passed, checks },
      history: [...c.history, { at: Date.now(), from: c.status, to, by: "runtime", note: `${checks.filter((x) => x.result === "passed").length}/${checks.length} checks passed` }],
    });
    if (c.eventId) {
      const e = await ctx.db.get(events, c.eventId);
      if (e)
        await ctx.db.patch(events, e.id, {
          phase: failed ? "requires_action" : passed ? "activate" : "requires_action",
          ...(failed || !passed ? { status: "requires_action" } : {}),
          timeline: [...e.timeline, note(`Validation of ${c.id}: ${failed ? "failed" : passed ? "passed" : "needs a decision"} — ${checks.map((x) => `${x.name}: ${x.result}`).join("; ")}`)],
        });
    }
  },
});

/**
 * Activate a validated correction: one active correction per scope; held work for its event is released.
 * Used by the runtime (an adapter that passed validation) and by operators (adaptations.activate).
 */
export async function activateCorrection(ctx: MutationCtx, correctionId: string, by: string) {
  const c = await ctx.db.get(corrections, correctionId);
  if (!c) fail("NOT_FOUND", "No such correction.");
  if (c.status !== "validated" || !c.validation?.passed) fail("FAILED_PRECONDITION", "Only a correction that passed validation can be activated.");
  const clash = (await ctx.db.find(corrections, { integrationId: c.integrationId, status: "active" })).find((x) => x.scopeKey === c.scopeKey);
  if (clash) fail("CONFLICT", `Correction ${clash.id} is already active for this scope.`);
  const now = Date.now();
  await ctx.db.patch(corrections, c.id, { status: "active", history: [...c.history, { at: now, from: c.status, to: "active", by }] });
  if (c.eventId && c.kind === "patch") {
    // A patch changes what the adopted code sends; it is verified on the next real request.
    const e = await ctx.db.get(events, c.eventId);
    if (e) {
      await ctx.db.patch(events, e.id, {
        status: "verification",
        phase: "verify_patch",
        timeline: [...e.timeline, note(`Patch ${c.id} activated by ${by}; verifying on the next request`, false, "verification")],
      });
      ctx.afterCommit.work("runtime", "maintain", { eventId: e.id }, { maxAttempts: 100 });
    }
    return;
  }
  if (c.eventId) {
    const e = await ctx.db.get(events, c.eventId);
    if (e) {
      let released = 0;
      for (const d of await ctx.db.find(deliveries, { integrationId: c.integrationId, status: "held" })) {
        if (d.heldBy !== e.id) continue;
        await ctx.db.patch(deliveries, d.id, { status: "queued", updatedAt: now });
        ctx.afterCommit.work("runtime", "deliver", { deliveryId: d.id }, { maxAttempts: 5 });
        released++;
      }
      await ctx.db.patch(events, e.id, {
        status: "recovery",
        phase: "recover",
        timeline: [
          ...e.timeline,
          note(`Correction ${c.id} activated by ${by}; ${released} held order(s) released`, false, "recovery"),
          note("We adapted your integration to the change. Orders that were held are being delivered now.", true, "recovery"),
        ],
      });
    }
  }
}

export const activateValidated = app.mutation({
  access: "mi.runtime",
  args: { correctionId: s.string() },
  handler: async (ctx, { correctionId }) => activateCorrection(ctx, correctionId, "runtime (adapter auto-activation)"),
});

/** Start the recovery reconciliation for the event's window (as the runtime, for maintenance). */
export const startRecovery = app.mutation({
  access: "mi.runtime",
  args: { eventId: s.string() },
  handler: async (ctx, { eventId }) => {
    const e = await ctx.db.get(events, eventId);
    if (!e) fail("NOT_FOUND", "No such event.");
    const runId = await ctx.db.insert(reconRuns, {
      integrationId: e.integrationId, status: "running", counts: {}, requestedBy: "runtime (maintenance)", startedAt: Date.now(),
      window: { from: new Date(e.openedAt - 3600_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() },
    });
    ctx.afterCommit.work("runtime", "reconcile", { runId }, { maxAttempts: 5 });
    await ctx.db.patch(events, eventId, { phase: "await_recover", reconRunId: runId, timeline: [...e.timeline, note(`Reconciliation ${runId} started for the event window`, false, "recovery")] });
  },
});

/** Recover every order the recovery run found missing (maintenance-owned, so no person is asked). */
export const recoverMissing = app.mutation({
  access: "mi.runtime",
  args: { eventId: s.string() },
  returns: s.integer(),
  handler: async (ctx, { eventId }) => {
    const e = await ctx.db.get(events, eventId);
    if (!e?.reconRunId) fail("FAILED_PRECONDITION", "No recovery run.");
    let n = 0;
    for (const item of await ctx.db.find(reconItems, { runId: e.reconRunId, classification: "missing_delivery" })) {
      if (item.recovery !== "none") continue;
      await ctx.db.patch(reconItems, item.id, { recovery: "requested" });
      ctx.afterCommit.work("runtime", "recover", { itemId: item.id }, { maxAttempts: 5 });
      n++;
    }
    await ctx.db.patch(events, eventId, { phase: "verify", timeline: [...e.timeline, note(`${n} lost order(s) found and sent for recovery`, false, "recovery")] });
    return n;
  },
});

export const recoveryItems = app.query({
  access: "mi.runtime",
  args: { eventId: s.string() },
  handler: async (ctx, { eventId }) => {
    const e = await ctx.db.get(events, eventId);
    if (!e?.reconRunId) return { run: null, items: [] };
    const run = await ctx.db.get(reconRuns, e.reconRunId);
    const items = await ctx.db.find(reconItems, { runId: e.reconRunId });
    return { run: run ? { status: run.status } : null, items: items.map((i) => ({ id: i.id, sourceId: i.sourceId, classification: i.classification, recovery: i.recovery, deliveryId: i.deliveryId ?? null, verifiedAt: i.verifiedAt ?? null })) };
  },
});

/** Close the event with its accounting; resolved only when nothing is unresolved or duplicated. */
export const recordAccounting = app.mutation({
  access: "mi.runtime",
  args: { eventId: s.string(), affected: s.integer(), delivered: s.integer(), unresolved: s.integer(), duplicates: s.integer(), checks: s.array(s.string()), doneText: s.optional(s.string()) },
  handler: async (ctx, a) => {
    const e = await ctx.db.get(events, a.eventId);
    if (!e) fail("NOT_FOUND", "No such event.");
    const ok = a.unresolved === 0 && a.duplicates === 0;
    const now = Date.now();
    await ctx.db.patch(events, e.id, {
      accounting: { affected: a.affected, delivered: a.delivered, unresolved: a.unresolved, duplicates: a.duplicates },
      status: ok ? "resolved" : "requires_action",
      phase: ok ? "done" : "requires_action",
      ...(ok ? { resolvedAt: now } : {}),
      timeline: [
        ...e.timeline,
        note(`Verification: ${a.checks.join("; ")}`, false, "verification"),
        ok
          ? note(a.doneText ?? `Completed: all ${a.affected} affected order(s) are in NetSuite exactly once with Shopify's prices. Nothing was lost and nothing is needed from you.`, true, "resolved")
          : note(`${a.unresolved} order(s) still need attention; our team has it.`, true, "requires_action"),
      ],
    });
    if (ok) await ctx.db.patch(integrations, e.integrationId, { status: "verified" });
  },
});

/** After a patch is active: the request that proves it (from a real delivery), recorded on the correction. */
export const recordPostActivation = app.mutation({
  access: "mi.runtime",
  args: {
    eventId: s.string(), correctionId: s.string(), observed: s.record(s.unknown()),
    accounting: s.optional(s.object({ affected: s.integer(), delivered: s.integer(), unresolved: s.integer(), duplicates: s.integer() })),
    doneText: s.optional(s.string()),
  },
  handler: async (ctx, a) => {
    const c = await ctx.db.get(corrections, a.correctionId);
    const e = await ctx.db.get(events, a.eventId);
    if (!c || !e) fail("NOT_FOUND", "No such correction or event.");
    const now = Date.now();
    await ctx.db.patch(corrections, c.id, { postActivation: { ...a.observed, at: now } });
    await ctx.db.patch(events, e.id, {
      status: "resolved",
      phase: "done",
      resolvedAt: now,
      accounting: a.accounting ?? { affected: 0, delivered: 0, unresolved: 0, duplicates: 0 },
      timeline: [
        ...e.timeline,
        note(`Verified after activation: ${JSON.stringify(a.observed)}`, false, "verification"),
        note(a.doneText ?? "Done: your bookkeeping code is updated and verified on a real posting. Nothing was missed.", true, "resolved"),
      ],
    });
    await ctx.db.patch(integrations, e.integrationId, { status: "verified" });
  },
});

/** The patch-awaiting-operator state is visible to the driver (it stops there until an operator acts). */
export const awaitOperator = app.mutation({
  access: "mi.runtime",
  args: { eventId: s.string(), correctionId: s.string() },
  handler: async (ctx, { eventId, correctionId }) => {
    const e = await ctx.db.get(events, eventId);
    if (!e) fail("NOT_FOUND", "No such event.");
    await ctx.db.patch(events, eventId, { phase: "await_operator", timeline: [...e.timeline, note(`Patch ${correctionId} validated; waiting for an operator to review and activate it`)] });
  },
});
