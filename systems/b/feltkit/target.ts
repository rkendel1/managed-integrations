/**
 * Target-side changes: the destination (NetSuite, QuickBooks) changes what it accepts, and the adopted code
 * cannot meet it as configured. Three correction kinds answer them, all in the one `corrections` registry:
 *
 *   decision       a business choice only the customer may make (which subsidiary; which account), asked
 *                  with options read from the customer's own target system;
 *   configuration  that choice in the integration's settings, validated against the target before it is
 *                  switched on; it records the settings before and after, so rollback restores them exactly;
 *   patch          (when the adopted code cannot express the choice at all) a reviewed change to it, validated
 *                  over the whole path and switched on by an operator (see maintenance.ts activateCorrection).
 *
 * Held work is released only when no other change of the same integration still awaits its correction: a
 * source change and a target change are corrected together or not at all (`blockingEvents`).
 */
import { fail, s, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import { app, corrections, deliveries, events, integrations } from "./app.js";

const note = (text: string, customerVisible = false, status = "investigating") => ({ at: Date.now(), status, text, customerVisible });
const CHANGE_KINDS = ["input_contract_changed", "target_contract_change"];

/**
 * Other open changes of this integration that still await their correction (none switched on yet). Held work
 * of this integration must not be released, or a fix validated, on part of the path while one exists.
 */
export async function blockingEvents(ctx: QueryCtx | MutationCtx, integrationId: string, eventId: string) {
  const open = (await ctx.db.find(events, { integrationId })).filter((e) => e.id !== eventId && e.status !== "resolved" && CHANGE_KINDS.includes(e.kind));
  const out: { id: string; kind: string }[] = [];
  for (const e of open) {
    const fixed = (await ctx.db.find(corrections, { integrationId, status: "active" })).some((c) => c.eventId === e.id && (c.kind === "adapter" || c.kind === "patch"));
    if (!fixed) out.push({ id: e.id, kind: e.kind });
  }
  return out;
}

/** Wake the maintenance driver of every other open event of this integration (something it waits on moved). */
export async function wakeOthers(ctx: MutationCtx, integrationId: string, eventId: string) {
  for (const e of await ctx.db.find(events, { integrationId }))
    if (e.id !== eventId && e.status !== "resolved") ctx.afterCommit.work("runtime", "maintain", { eventId: e.id }, { maxAttempts: 100 });
}

/** Ask the customer a business question; the event waits for their answer. */
export const requestDecision = app.mutation({
  access: "mi.runtime",
  args: {
    eventId: s.string(),
    question: s.string(),
    options: s.array(s.object({ id: s.string(), label: s.string() })),
    setting: s.string(),
    rationale: s.string(),
    customerText: s.string(),
  },
  returns: s.string(),
  handler: async (ctx, a) => {
    const e = await ctx.db.get(events, a.eventId);
    if (!e) fail("NOT_FOUND", "No such event.");
    if (!a.options.length) fail("FAILED_PRECONDITION", "A decision needs at least one option.");
    const now = Date.now();
    const id = await ctx.db.insert(corrections, {
      integrationId: e.integrationId, eventId: e.id, kind: "decision", status: "proposed",
      scopeKey: `${e.integrationId}:decision:${e.id}:${now}`,
      spec: { setting: a.setting, options: a.options, rationale: a.rationale },
      question: { text: a.question, options: a.options.map((o) => o.label), authority: "customer" },
      history: [{ at: now, from: "none", to: "proposed", by: "runtime", note: a.rationale }],
      createdAt: now,
    });
    await ctx.db.patch(events, e.id, {
      status: "requires_action",
      phase: "await_customer",
      timeline: [...e.timeline, note(`Decision ${id} asked of the customer: ${a.question} (${a.options.map((o) => `${o.id}=${o.label}`).join(", ")})`, false, "requires_action"), note(a.customerText, true, "requires_action")],
    });
    await ctx.db.patch(integrations, e.integrationId, { status: "customer_action" });
    return id;
  },
});

/** The customer answers a decision. Only the company's own people hold `mi.decide`; staff do not. */
export const decide = app.mutation({
  access: "mi.decide",
  args: { eventId: s.string(), decisionId: s.string(), optionId: s.string() },
  returns: s.object({ status: s.string() }),
  capability: { name: "maintenance.decide", description: "Answer a business question a maintenance event is waiting on (customer only)." },
  handler: async (ctx, { eventId, decisionId, optionId }) => {
    const d = await ctx.db.get(corrections, decisionId);
    const e = await ctx.db.get(events, eventId);
    if (!d || !e || d.eventId !== eventId || d.kind !== "decision") fail("NOT_FOUND", "No such decision.");
    if (d.status !== "proposed") fail("CONFLICT", "This question was already answered.");
    const options = d.spec.options as { id: string; label: string }[];
    const chosen = options.find((o) => o.id === optionId);
    if (!chosen) fail("INVALID_ARGUMENT", `Choose one of: ${options.map((o) => o.id).join(", ")}.`);
    const by = ctx.auth.requirePrincipal().id;
    const now = Date.now();
    await ctx.db.patch(corrections, d.id, {
      status: "active",
      answer: { choice: optionId, by, at: now },
      history: [...d.history, { at: now, from: "proposed", to: "active", by, note: `chose ${chosen.label}` }],
    });
    await ctx.db.patch(events, e.id, {
      status: "investigating",
      phase: "configure",
      timeline: [...e.timeline, note(`Customer ${by} chose ${optionId} (${chosen.label}) for decision ${d.id}`), note(`You chose ${chosen.label}. We are checking it and preparing the change before switching it on.`, true)],
    });
    await ctx.db.patch(integrations, e.integrationId, { status: "maintaining" });
    ctx.afterCommit.work("runtime", "maintain", { eventId }, { maxAttempts: 100 });
    return { status: "decided" };
  },
});

const Check = s.object({ name: s.string(), result: s.enum(["passed", "failed", "not_applicable"]), detail: s.string() });

/**
 * Record a configuration or patch correction together with its validation (the runtime validated it before
 * recording). Validated → `validated`; any failed check → `rejected`. The event moves to `nextPhase`.
 */
export const recordCorrection = app.mutation({
  access: "mi.runtime",
  args: {
    eventId: s.string(),
    kind: s.enum(["configuration", "patch"]),
    scopeKey: s.string(),
    spec: s.record(s.unknown()),
    reason: s.string(),
    checks: s.array(Check),
    nextPhase: s.string(),
  },
  returns: s.object({ id: s.string(), status: s.string() }),
  handler: async (ctx, a) => {
    const e = await ctx.db.get(events, a.eventId);
    if (!e) fail("NOT_FOUND", "No such event.");
    const now = Date.now();
    const failed = a.checks.some((c) => c.result === "failed");
    const status = failed ? "rejected" : "validated";
    const id = await ctx.db.insert(corrections, {
      integrationId: e.integrationId, eventId: e.id, kind: a.kind, status, scopeKey: a.scopeKey, spec: a.spec,
      validation: { passed: !failed, checks: a.checks },
      history: [
        { at: now, from: "none", to: "proposed", by: "runtime", note: a.reason },
        { at: now, from: "proposed", to: status, by: "runtime", note: `${a.checks.filter((c) => c.result === "passed").length}/${a.checks.length} checks passed` },
      ],
      createdAt: now,
    });
    await ctx.db.patch(events, e.id, {
      phase: a.nextPhase,
      timeline: [...e.timeline, note(`${a.kind} ${id} ${status}: ${a.checks.map((c) => `${c.name}: ${c.result}`).join("; ")}`)],
    });
    return { id, status };
  },
});

/** Switch on a validated configuration: the integration's settings become `settingsAfter`. */
export const activateConfiguration = app.mutation({
  access: "mi.runtime",
  args: { correctionId: s.string(), nextPhase: s.string(), customerText: s.optional(s.string()) },
  handler: async (ctx, { correctionId, nextPhase, customerText }) => {
    const c = await ctx.db.get(corrections, correctionId);
    if (!c || c.kind !== "configuration") fail("NOT_FOUND", "No such configuration.");
    if (c.status !== "validated" || !c.validation?.passed) fail("FAILED_PRECONDITION", "Only a validated configuration can be switched on.");
    const integ = await ctx.db.get(integrations, c.integrationId);
    if (!integ) fail("NOT_FOUND", "No such integration.");
    const clash = (await ctx.db.find(corrections, { integrationId: c.integrationId, status: "active" })).find((x) => x.scopeKey === c.scopeKey);
    if (clash) await ctx.db.patch(corrections, clash.id, { status: "rolled_back", history: [...clash.history, { at: Date.now(), from: "active", to: "rolled_back", by: "runtime", note: `superseded by ${c.id}` }] });
    await ctx.db.patch(integrations, integ.id, { settings: { ...integ.settings, ...(c.spec.settingsAfter as Record<string, unknown>) } });
    await ctx.db.patch(corrections, c.id, { status: "active", history: [...c.history, { at: Date.now(), from: "validated", to: "active", by: "runtime (customer decision)" }] });
    if (c.eventId) {
      const e = await ctx.db.get(events, c.eventId);
      if (e)
        await ctx.db.patch(events, e.id, {
          phase: nextPhase,
          timeline: [...e.timeline, note(`Configuration ${c.id} switched on`), ...(customerText ? [note(customerText, true)] : [])],
        });
    }
  },
});

/** Move the event to a phase, optionally telling the customer something. */
export const setPhase = app.mutation({
  access: "mi.runtime",
  args: { eventId: s.string(), phase: s.string(), text: s.optional(s.string()), customerText: s.optional(s.string()), status: s.optional(s.enum(["investigating", "recovery", "verification", "requires_action"])) },
  handler: async (ctx, a) => {
    const e = await ctx.db.get(events, a.eventId);
    if (!e) fail("NOT_FOUND", "No such event.");
    if (e.phase === a.phase && !a.text && !a.customerText) return;
    await ctx.db.patch(events, e.id, {
      phase: a.phase,
      ...(a.status ? { status: a.status } : {}),
      timeline: [...e.timeline, ...(a.text ? [note(a.text, false, a.status ?? e.status)] : []), ...(a.customerText ? [note(a.customerText, true, a.status ?? e.status)] : [])],
    });
  },
});

/**
 * Release held work: this event's (`scope: "event"`) or every held delivery of the integration
 * (`"integration"`: the whole path is corrected). Refused while another change still awaits its correction.
 */
export const releaseHeld = app.mutation({
  access: "mi.runtime",
  args: { eventId: s.string(), scope: s.enum(["event", "integration"]), nextPhase: s.string() },
  returns: s.integer(),
  handler: async (ctx, { eventId, scope, nextPhase }) => {
    const e = await ctx.db.get(events, eventId);
    if (!e) fail("NOT_FOUND", "No such event.");
    const blocking = await blockingEvents(ctx, e.integrationId, eventId);
    if (blocking.length) fail("FAILED_PRECONDITION", `Held work waits for ${blocking.map((b) => b.kind).join(", ")} to be corrected too.`);
    const now = Date.now();
    const released: string[] = [];
    for (const d of await ctx.db.find(deliveries, { integrationId: e.integrationId, status: "held" })) {
      if (scope === "event" && d.heldBy !== eventId) continue;
      await ctx.db.patch(deliveries, d.id, { status: "queued", updatedAt: now });
      ctx.afterCommit.work("runtime", "deliver", { deliveryId: d.id }, { maxAttempts: 5 });
      released.push(d.id);
    }
    const prior = ((e.finding ?? {}).released as string[] | undefined) ?? [];
    await ctx.db.patch(events, e.id, {
      status: "recovery",
      phase: nextPhase,
      finding: { ...(e.finding ?? {}), released: [...prior, ...released] },
      timeline: [...e.timeline, note(`${released.length} held order(s) released (${scope})`, false, "recovery")],
    });
    return released.length;
  },
});
