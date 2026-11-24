import { fail, s } from "@feltdb/feltkit";
import { app, deliveries, integrations } from "./app.js";
import { ADOPTED } from "./integrations.js";

const Summary = s.object({
  id: s.string(),
  reference: s.string(),
  sourceId: s.string(),
  status: s.string(),
  destinationRef: s.optional(s.string()),
  reason: s.optional(s.string()),
  attempts: s.integer(),
  updatedAt: s.number(),
});

export const list = app.query({
  access: "mi.read",
  args: { integrationId: s.string() },
  returns: s.object({ integration: s.object({ id: s.string(), kind: s.string(), executor: s.object({ repository: s.string(), commit: s.string(), license: s.string() }) }), deliveries: s.array(Summary) }),
  capability: { name: "deliveries.list", description: "Deliveries of an integration with their current outcome." },
  handler: async (ctx, { integrationId }) => {
    const i = await ctx.db.get(integrations, integrationId);
    if (!i) fail("NOT_FOUND", "No such integration.");
    const rows = await ctx.db.find(deliveries, { integrationId }, { orderBy: [{ field: "updatedAt", direction: "desc" }] });
    return {
      integration: { id: i.id, kind: i.kind, executor: { ...i.upstream, license: ADOPTED.order_sync.license } },
      deliveries: rows.map((d) => ({
        id: d.id,
        reference: d.reference,
        sourceId: d.sourceId,
        status: d.status,
        ...(d.destinationRef ? { destinationRef: d.destinationRef } : {}),
        ...(d.lastError ? { reason: d.lastError } : {}),
        attempts: d.attempts.length,
        updatedAt: d.updatedAt,
      })),
    };
  },
});

export const get = app.query({
  access: "mi.read",
  args: { deliveryId: s.string() },
  returns: s.object({
    id: s.string(),
    integrationId: s.string(),
    sourceId: s.string(),
    reference: s.string(),
    status: s.string(),
    automaticAttempts: s.integer(),
    destinationRef: s.optional(s.string()),
    lastError: s.optional(s.string()),
    heldBy: s.optional(s.string()),
    attempts: s.array(s.object({ at: s.number(), outcome: s.string(), by: s.string(), detail: s.optional(s.string()), correction: s.optional(s.string()) })),
    updatedAt: s.number(),
  }),
  capability: { name: "deliveries.get", description: "One delivery with its full attempt history." },
  handler: async (ctx, { deliveryId }) => {
    const d = await ctx.db.get(deliveries, deliveryId);
    if (!d) fail("NOT_FOUND", "No such delivery.");
    return {
      id: d.id, integrationId: d.integrationId, sourceId: d.sourceId, reference: d.reference, status: d.status,
      automaticAttempts: d.automaticAttempts, attempts: d.attempts, updatedAt: d.updatedAt,
      ...(d.destinationRef ? { destinationRef: d.destinationRef } : {}),
      ...(d.lastError ? { lastError: d.lastError } : {}),
      ...(d.heldBy ? { heldBy: d.heldBy } : {}),
    };
  },
});

/** Run a failed, rejected or held delivery again. Refused while it is queued or running, and once delivered. */
export const retry = app.mutation({
  access: "mi.operate",
  args: { deliveryId: s.string(), reason: s.string({ minLength: 1, maxLength: 500 }) },
  returns: s.object({ status: s.string(), previousStatus: s.string() }),
  capability: { name: "deliveries.retry", description: "Re-run a failed, rejected or stuck delivery (a duplicate request is refused)." },
  handler: async (ctx, { deliveryId, reason }) => {
    const d = await ctx.db.get(deliveries, deliveryId);
    if (!d) fail("NOT_FOUND", "No such delivery.");
    if (d.status === "queued" || d.status === "running") fail("CONFLICT", "This delivery is already being worked on.");
    if (d.status === "delivered") fail("CONFLICT", "This delivery has already been delivered.");
    const by = ctx.auth.requirePrincipal().id;
    await ctx.db.patch(deliveries, d.id, {
      status: "queued",
      attempts: [...d.attempts, { at: Date.now(), outcome: "retry_requested", by, detail: reason }],
      updatedAt: Date.now(),
    });
    ctx.afterCommit.work("runtime", "deliver", { deliveryId: d.id }, { maxAttempts: 5 });
    return { status: "queued", previousStatus: d.status };
  },
});
