/**
 * Functions only the runtime component calls (role `runtime`, a member of each customer workspace). Each
 * runs in the workspace the component names, so FeltKit scopes every read and write to that customer.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, connections, corrections, deliveries, integrations, receipts, tickets } from "./app.js";
import { openOrJoinEvent } from "./maintenance.js";

const MAX_AUTOMATIC = 5;

/** Redeem a one-time ticket (connect flows). Not workspace-scoped: the ticket names the workspace. */
export const redeemTicket = app.mutation({
  access: "mi.runtime",
  args: { ticket: s.string(), purpose: s.string() },
  returns: s.object({ workspace: s.string(), subject: s.string(), principal: s.string() }),
  handler: async (ctx, { ticket, purpose }) => {
    const t = await ctx.db.get(tickets, ticket);
    if (!t || t.purpose !== purpose || t.usedAt || t.expiresAt < Date.now()) fail("NOT_FOUND", "That link has expired. Start again.");
    await ctx.db.patch(tickets, ticket, { usedAt: Date.now() });
    return { workspace: t.workspace, subject: t.subject, principal: t.principal };
  },
});

export const storeConnection = app.mutation({
  access: "mi.runtime",
  args: {
    provider: s.enum(["shopify", "netsuite", "stripe", "quickbooks"]),
    status: s.enum(["pending", "connected", "verified", "error", "revoked"]),
    account: s.optional(s.string()),
    sealed: s.optional(s.string()),
    publicKeyPem: s.optional(s.string()),
    detail: s.optional(s.string()),
  },
  handler: async (ctx, a) => {
    const [existing] = await ctx.db.find(connections, { provider: a.provider });
    const fields = {
      status: a.status,
      ...(a.account !== undefined ? { account: a.account } : {}),
      ...(a.sealed !== undefined ? { sealed: a.sealed } : {}),
      ...(a.publicKeyPem !== undefined ? { publicKeyPem: a.publicKeyPem } : {}),
      detail: a.detail,
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.patch(connections, existing.id, fields);
    else await ctx.db.insert(connections, { provider: a.provider, ...fields });
    // A restored target connection releases work that was waiting for it.
    if (a.provider === "netsuite" && a.status === "verified") {
      for (const d of await ctx.db.find(deliveries, { status: "awaiting_authorization" })) {
        await ctx.db.patch(deliveries, d.id, { status: "queued", updatedAt: Date.now() });
        ctx.afterCommit.work("runtime", "deliver", { deliveryId: d.id }, { maxAttempts: MAX_AUTOMATIC });
      }
    }
  },
});

/** Sealed connection envelopes for the component (never leaves the server: the role is runtime-only). */
export const sealedConnection = app.query({
  access: "mi.runtime",
  args: { provider: s.string() },
  handler: async (ctx, { provider }) => {
    const [c] = await ctx.db.find(connections, { provider: provider as "shopify" });
    return c && c.sealed && c.status !== "disconnected" && c.status !== "revoked" ? { sealed: c.sealed, account: c.account ?? null, status: c.status } : null;
  },
});

/** A verified Shopify orders/create event (signature and shop already checked by the component). */
export const ingestOrder = app.mutation({
  access: "mi.runtime",
  args: {
    integrationId: s.string(),
    providerEventId: s.string(),
    topic: s.string(),
    apiVersion: s.optional(s.string()),
    sourceId: s.string(),
    reference: s.string(),
    sealed: s.string(),
    origin: s.enum(["webhook", "reconciliation"]),
  },
  returns: s.object({ disposition: s.string(), deliveryId: s.optional(s.string()) }),
  handler: async (ctx, a) => {
    const integ = await ctx.db.get(integrations, a.integrationId);
    if (!integ || !integ.enabled || integ.kind !== "order_sync") fail("NOT_FOUND", "No such integration.");
    const now = Date.now();
    const seen = await ctx.db.find(receipts, { integrationId: a.integrationId, providerEventId: a.providerEventId });
    if (seen.length) return { disposition: "duplicate_webhook" };
    const receipt = (disposition: "accepted" | "already_delivered" | "ignored_topic" | "joined_recovery") =>
      ctx.db.insert(receipts, {
        integrationId: a.integrationId,
        providerEventId: a.providerEventId,
        topic: a.topic,
        ...(a.apiVersion ? { apiVersion: a.apiVersion } : {}),
        sourceId: a.sourceId,
        origin: a.origin,
        sealed: a.sealed,
        disposition,
        receivedAt: now,
      });
    if (a.topic !== "orders/create") {
      await receipt("ignored_topic");
      return { disposition: "ignored_topic" };
    }
    const idempotencyKey = `${a.integrationId}:${a.sourceId}`;
    const [existing] = await ctx.db.find(deliveries, { idempotencyKey });
    if (existing) {
      const disposition = existing.status === "delivered" ? "already_delivered" : "joined_recovery";
      await receipt(disposition);
      return { disposition, deliveryId: existing.id };
    }
    const receiptId = await receipt("accepted");
    const deliveryId = await ctx.db.insert(deliveries, {
      integrationId: a.integrationId,
      sourceId: a.sourceId,
      reference: a.reference,
      idempotencyKey,
      receiptId,
      status: "queued",
      automaticAttempts: 0,
      attempts: [],
      updatedAt: now,
    });
    ctx.afterCommit.work("runtime", "deliver", { deliveryId }, { maxAttempts: MAX_AUTOMATIC });
    return { disposition: "accepted", deliveryId };
  },
});

/** Everything the component needs to run one delivery with the adopted code. */
export const deliveryContext = app.query({
  access: "mi.runtime",
  args: { deliveryId: s.string() },
  handler: async (ctx, { deliveryId }) => {
    const d = await ctx.db.get(deliveries, deliveryId);
    if (!d) fail("NOT_FOUND", "No such delivery.");
    const r = await ctx.db.get(receipts, d.receiptId);
    const integ = await ctx.db.get(integrations, d.integrationId);
    if (!r || !integ) fail("NOT_FOUND", "Delivery without receipt or integration.");
    const active = await ctx.db.find(corrections, { integrationId: d.integrationId, status: "active" });
    return {
      delivery: { id: d.id, status: d.status, reference: d.reference, sourceId: d.sourceId, automaticAttempts: d.automaticAttempts },
      receipt: { sealed: r.sealed, apiVersion: r.apiVersion ?? null, id: r.id },
      integration: { id: integ.id, settings: integ.settings, enabled: integ.enabled },
      adapters: active.filter((c) => c.kind === "adapter").map((c) => ({ id: c.id, adapter: String(c.spec.adapter), appliesTo: (c.spec.appliesTo as string[] | undefined) ?? [] })),
    };
  },
});

/** The outcome of one attempt, recorded with what ran (upstream commit, corrections applied). */
export const recordAttempt = app.mutation({
  access: "mi.runtime",
  args: {
    deliveryId: s.string(),
    outcome: s.enum(["delivered", "rejected", "failed", "held", "awaiting_authorization"]),
    detail: s.optional(s.string()),
    destinationRef: s.optional(s.string()),
    correction: s.optional(s.string()),
    violations: s.optional(s.array(s.string())),
    apiVersion: s.optional(s.string()),
    by: s.string(),
  },
  returns: s.object({ status: s.string(), automaticAttempts: s.integer(), retry: s.boolean() }),
  handler: async (ctx, a) => {
    const d = await ctx.db.get(deliveries, a.deliveryId);
    if (!d) fail("NOT_FOUND", "No such delivery.");
    const now = Date.now();
    const automaticAttempts = a.outcome === "failed" ? d.automaticAttempts + 1 : d.automaticAttempts;
    const retry = a.outcome === "failed" && automaticAttempts < MAX_AUTOMATIC;
    let heldBy: string | undefined;
    if (a.outcome === "held") {
      heldBy = await openOrJoinEvent(ctx, {
        integrationId: d.integrationId,
        kind: "input_contract_changed",
        boundary: "source",
        dedupeKey: `${d.integrationId}:input_contract:${a.apiVersion ?? "unknown"}`,
        finding: { provider: "shopify", apiVersion: a.apiVersion ?? null, missing: a.violations ?? [], contract: "orders/create payload read by toCanonicalOrder" },
        customerText: "Shopify changed the format of new orders. We are adapting your integration; no order will be lost.",
      });
    }
    await ctx.db.patch(deliveries, d.id, {
      status: a.outcome === "failed" && retry ? "queued" : a.outcome,
      automaticAttempts,
      ...(a.destinationRef ? { destinationRef: a.destinationRef } : {}),
      lastError: a.outcome === "delivered" ? undefined : a.detail,
      heldBy: a.outcome === "held" ? heldBy : undefined,
      attempts: [...d.attempts, { at: now, outcome: a.outcome, by: a.by, ...(a.detail ? { detail: a.detail } : {}), ...(a.correction ? { correction: a.correction } : {}) }],
      updatedAt: now,
    });
    return { status: a.outcome, automaticAttempts, retry };
  },
});
