import { fail, s, type MutationCtx } from "@feltdb/feltkit";
import { app, integrations } from "./app.js";

export const ADOPTED = {
  order_sync: { repository: "github.com/Milo-ai-HQ/shopify-erp-order-sync", commit: "d01b51d95993598580cdcffda6537a6f20a10a3a", license: "MIT" },
} as const;

/** The company's integrations, with the adopted code each one runs. */
export const list = app.query({
  access: "mi.read",
  returns: s.object({
    company: s.nullable(s.object({ id: s.string(), name: s.string() })),
    integrations: s.array(s.object({ id: s.string(), kind: s.string(), enabled: s.boolean(), status: s.string(), upstream: s.object({ repository: s.string(), commit: s.string() }) })),
  }),
  capability: { name: "integrations.list", description: "Integrations this company has under management." },
  handler: async (ctx) => {
    const tenant = ctx.auth.tenant;
    return {
      company: tenant ? { id: tenant.id, name: tenant.name } : null,
      integrations: (await ctx.db.find(integrations, {})).map((i) => ({ id: i.id, kind: i.kind, enabled: i.enabled, status: i.status, upstream: i.upstream })),
    };
  },
});

/**
 * Put the Shopify → NetSuite order sync under management with the customer's settings (the adopted code's
 * own configuration model: defaultCustomer, customerByEmail).
 */
export async function createOrderSync(ctx: MutationCtx, a: { defaultCustomer?: string; customerByEmail?: Record<string, string> }) {
    const [existing] = await ctx.db.find(integrations, { kind: "order_sync" });
    if (existing) fail("CONFLICT", "The order sync is already under management.");
    const id = await ctx.db.insert(integrations, {
      kind: "order_sync",
      enabled: true,
      settings: { defaultCustomer: a.defaultCustomer ?? "WEB", customerByEmail: a.customerByEmail ?? {} },
      status: "protected",
      upstream: { repository: ADOPTED.order_sync.repository, commit: ADOPTED.order_sync.commit },
      createdAt: Date.now(),
    });
    // Subscribe to the shop's orders/create webhook, delivered to the runtime's route for this workspace.
    ctx.afterCommit.work("runtime", "subscribe", { integrationId: id }, { maxAttempts: 10 });
    return id;
}

export const adoptOrderSync = app.mutation({
  access: "mi.configure",
  args: { defaultCustomer: s.optional(s.string()), customerByEmail: s.optional(s.record(s.string())) },
  returns: s.string(),
  handler: async (ctx, a) => createOrderSync(ctx, a),
});

export const updateSettings = app.mutation({
  access: "mi.configure",
  args: { integrationId: s.string(), defaultCustomer: s.optional(s.string()), customerByEmail: s.optional(s.record(s.string())), enabled: s.optional(s.boolean()) },
  handler: async (ctx, a) => {
    const i = await ctx.db.get(integrations, a.integrationId);
    if (!i) fail("NOT_FOUND", "No such integration.");
    await ctx.db.patch(integrations, i.id, {
      settings: { ...i.settings, ...(a.defaultCustomer ? { defaultCustomer: a.defaultCustomer } : {}), ...(a.customerByEmail ? { customerByEmail: a.customerByEmail } : {}) },
      ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
    });
  },
});
