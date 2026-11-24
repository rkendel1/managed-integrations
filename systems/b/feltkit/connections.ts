/**
 * Customer connections. A secret never passes through a function: the person's browser gets a one-time
 * ticket here and presents it, with the secret or an OAuth redirect, to the runtime component, which seals
 * the secret and stores only the envelope (runtime:storeConnection).
 */
import { fail, s } from "@feltdb/feltkit";
import { app, connections, tickets } from "./app.js";

const Connection = s.object({
  provider: s.string(),
  status: s.string(),
  account: s.optional(s.string()),
  publicKeyPem: s.optional(s.string()),
  detail: s.optional(s.string()),
  updatedAt: s.number(),
});

export const list = app.query({
  access: "mi.read",
  returns: s.array(Connection),
  capability: { name: "connections.list", description: "This company's provider connections (never a secret)." },
  handler: async (ctx) =>
    (await ctx.db.find(connections, {})).map(({ provider, status, account, publicKeyPem, detail, updatedAt }) => ({
      provider,
      status,
      ...(account ? { account } : {}),
      ...(publicKeyPem ? { publicKeyPem } : {}),
      ...(detail ? { detail } : {}),
      updatedAt,
    })),
});

/** A one-time ticket (10 minutes) for connecting `provider` through the runtime component. */
export const begin = app.mutation({
  access: "mi.connect",
  args: { provider: s.enum(["shopify", "netsuite", "stripe", "quickbooks"]) },
  returns: s.object({ ticket: s.string(), expiresAt: s.number() }),
  handler: async (ctx, { provider }) => {
    const tenant = ctx.auth.tenant;
    if (!tenant) fail("FAILED_PRECONDITION", "Work in your company to connect a provider.");
    const expiresAt = Date.now() + 10 * 60_000;
    const ticket = await ctx.db.insert(tickets, {
      workspace: tenant.id,
      purpose: "connect",
      subject: provider,
      principal: ctx.auth.requirePrincipal().id,
      expiresAt,
    });
    return { ticket, expiresAt };
  },
});

export const disconnect = app.mutation({
  access: "mi.connect",
  args: { provider: s.enum(["shopify", "netsuite", "stripe", "quickbooks"]) },
  handler: async (ctx, { provider }) => {
    const [c] = await ctx.db.find(connections, { provider });
    if (!c) fail("NOT_FOUND", "No such connection.");
    await ctx.db.patch(connections, c.id, { status: "disconnected", sealed: undefined, updatedAt: Date.now() });
  },
});

/** Check a connection against the provider now (the runtime asks for a token / makes a read). */
export const verify = app.mutation({
  access: "mi.connect",
  args: { provider: s.enum(["netsuite"]) },
  handler: async (ctx, { provider }) => {
    const [c] = await ctx.db.find(connections, { provider });
    if (!c || !c.sealed) fail("NOT_FOUND", "Connect it first.");
    ctx.afterCommit.work("runtime", "verify-connection", { provider }, { maxAttempts: 3 });
  },
});
