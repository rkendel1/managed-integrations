/**
 * The integration runtime: a FeltKit component (docs/COMPONENTS.md) running in the application's process.
 *
 *  - Routes under /rt/: provider webhooks (provider-specific signatures, which FeltKit's inbound webhooks
 *    do not verify: docs/experiment/FINDINGS.md F5), OAuth callbacks and connect forms (reached with one-time
 *    tickets, never a FeltKit session).
 *  - Custody of customer provider secrets (sealed with `credential-ref:mi-keyring`; FINDINGS F4).
 *  - Durable work recorded by mutations (`ctx.afterCommit.work("runtime", kind, input)`): claimed with a
 *    lease, settled with an outcome; FeltKit retries, fences and recovers it.
 *
 * It acts only by calling the application's functions as `component:runtime`, in the customer's workspace.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { defineComponent, type ComponentContext } from "@feltdb/feltkit/server";
import { verifyShopifyHmac } from "shopify-sync/src/webhook.js";
import { createSealer, type Sealer } from "./seal.ts";
import { exchangeToken, verifyCallbackHmac, subscribeOrdersCreate, type ShopifyCredential } from "./shopify.ts";
import { accessToken, AuthorizationLost, forgetToken, newKeyPair, type NetSuiteCredential } from "./netsuite.ts";
import { ADAPTERS, UPSTREAM, contractViolations, execute, type Payload } from "./order-sync.ts";
import { handlers as maintenanceHandlers } from "./maintain.ts";
import { handlers as reconcileHandlers } from "./reconcile.ts";
import * as ledgerly from "./ledgerly-runtime.ts";
import { handlers as onboardingHandlers } from "./onboarding.ts";
import * as apps from "./apps-runtime.ts";

const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID ?? "fixture-shopify-client-id";
const PUBLIC_URL = (process.env.MI_PUBLIC_URL ?? "http://127.0.0.1:3100").replace(/\/$/, "");

export interface Runtime {
  ctx: ComponentContext;
  sealer: Sealer;
  shopifySecret: string;
  call<T = any>(workspace: string, fn: string, args?: object): Promise<T>;
  open<T>(workspace: string, purpose: string, sealed: string): T;
  seal(workspace: string, purpose: string, value: unknown): string;
  netsuite(workspace: string): Promise<{ cred: NetSuiteCredential; token: string } | null>;
  shopify(workspace: string): Promise<ShopifyCredential | null>;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 512 * 1024) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export default defineComponent(async (ctx) => {
  const keyring = await ctx.credential("mi-keyring");
  const shopifySecret = (await ctx.credential("shopify-client-secret")) ?? "";
  if (!keyring || !shopifySecret) {
    return { health: () => ({ state: "unconfigured", detail: "Set credential-ref:mi-keyring and credential-ref:shopify-client-secret." }) };
  }
  const qboSecret = (await ctx.credential("qbo-client-secret")) ?? "";
  const sealer = createSealer(keyring);
  const stateKey = ctx.derive("oauth-state");

  const rt: Runtime & { qboSecret: string } = {
    ctx,
    qboSecret,
    sealer,
    shopifySecret,
    call: (workspace, fn, args = {}) => ctx.call(fn, args, { tenant: workspace }),
    open: (workspace, purpose, sealed) => JSON.parse(sealer.open(sealed, `${workspace}:${purpose}`)),
    seal: (workspace, purpose, value) => sealer.seal(JSON.stringify(value), `${workspace}:${purpose}`),
    async netsuite(workspace) {
      const c = await rt.call<{ sealed: string; status: string } | null>(workspace, "runtime:sealedConnection", { provider: "netsuite" });
      if (!c) return null;
      const cred = rt.open<NetSuiteCredential>(workspace, "connection:netsuite", c.sealed);
      return { cred, token: await accessToken(workspace, cred) };
    },
    async shopify(workspace) {
      const c = await rt.call<{ sealed: string } | null>(workspace, "runtime:sealedConnection", { provider: "shopify" });
      return c ? rt.open<ShopifyCredential>(workspace, "connection:shopify", c.sealed) : null;
    },
  };

  const signState = (v: string) => `${v}.${createHmac("sha256", stateKey).update(v).digest("base64url")}`;
  const readState = (s: string) => {
    const i = s.lastIndexOf(".");
    const v = s.slice(0, i);
    const mac = Buffer.from(s.slice(i + 1));
    const expected = Buffer.from(createHmac("sha256", stateKey).update(v).digest("base64url"));
    return i > 0 && mac.length === expected.length && timingSafeEqual(mac, expected) ? v : null;
  };

  const ledgerlyRoutes = ledgerly.routes(rt, { readBody, send, signState, readState, publicUrl: PUBLIC_URL, qboSecret });

  async function request(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", PUBLIC_URL);
    const parts = url.pathname.split("/").filter(Boolean); // ["rt", ...]
    try {
      if (await ledgerlyRoutes(req, res, url)) return;
      // Shopify orders/create → /rt/hooks/shopify/<workspace>/<integrationId>
      if (req.method === "POST" && parts[1] === "hooks" && parts[2] === "shopify" && parts.length === 5) {
        const [, , , workspace, integrationId] = parts as [string, string, string, string, string];
        const raw = await readBody(req);
        const h = (n: string) => (req.headers[n] as string | undefined) ?? undefined;
        if (!verifyShopifyHmac(raw, h("x-shopify-hmac-sha256"), shopifySecret)) return send(res, 401, { error: "invalid signature" });
        // The connected shop (recorded from Shopify's OAuth callback) must be the sender.
        const c = await rt.call<{ account: string | null } | null>(workspace, "runtime:sealedConnection", { provider: "shopify" });
        if (!c || c.account !== h("x-shopify-shop-domain")) return send(res, 401, { error: "unknown shop" });
        const webhookId = h("x-shopify-webhook-id");
        if (!webhookId) return send(res, 400, { error: "missing X-Shopify-Webhook-Id" });
        const payload = JSON.parse(raw.toString("utf8")) as Payload;
        const result = await rt.call(workspace, "runtime:ingest", {
          integrationId,
          providerEventId: webhookId,
          topic: h("x-shopify-topic") ?? "",
          ...(h("x-shopify-api-version") ? { apiVersion: h("x-shopify-api-version") } : {}),
          sourceId: String(payload.id),
          reference: String(payload.name),
          sealed: rt.seal(workspace, "receipt", payload),
          origin: "webhook",
        });
        return send(res, 200, result);
      }
      // Shopify OAuth start: /rt/connect/shopify?ticket=&shop=https://…
      if (req.method === "GET" && url.pathname === "/rt/connect/shopify") {
        const shop = url.searchParams.get("shop") ?? "";
        const t = await ctx.call<{ workspace: string; subject: string }>("runtime:redeemTicket", { ticket: url.searchParams.get("ticket") ?? "", purpose: "connect" });
        if (t.subject !== "shopify" || !/^https?:\/\//.test(shop)) return send(res, 400, { error: "bad request" });
        const state = signState(`${t.workspace}|${encodeURIComponent(shop)}|${randomBytes(8).toString("hex")}|${Date.now()}`);
        const auth = new URL(`${shop}/admin/oauth/authorize`);
        auth.searchParams.set("client_id", SHOPIFY_CLIENT_ID);
        auth.searchParams.set("scope", "read_orders");
        auth.searchParams.set("redirect_uri", `${PUBLIC_URL}/rt/oauth/shopify/callback`);
        auth.searchParams.set("state", state);
        res.writeHead(302, { location: auth.toString() });
        res.end();
        return;
      }
      if (req.method === "GET" && url.pathname === "/rt/oauth/shopify/callback") {
        if (!verifyCallbackHmac(url.searchParams, shopifySecret)) return send(res, 401, { error: "invalid callback signature" });
        const v = readState(url.searchParams.get("state") ?? "");
        const [workspace, shopEnc, , issued] = (v ?? "").split("|");
        if (!v || !workspace || !shopEnc || Date.now() - Number(issued) > 10 * 60_000) return send(res, 400, { error: "expired or forged state" });
        const shop = decodeURIComponent(shopEnc);
        const token = await exchangeToken(shop, SHOPIFY_CLIENT_ID, shopifySecret, { code: url.searchParams.get("code") ?? "" });
        if (!token.scope.split(",").includes("read_orders")) return send(res, 403, { error: "read_orders was not granted" });
        const cred: ShopifyCredential = { shop, accessToken: token.accessToken, ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}), ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}) };
        await rt.call(workspace, "runtime:storeConnection", { provider: "shopify", status: "verified", account: url.searchParams.get("shop") ?? "", sealed: rt.seal(workspace, "connection:shopify", cred) });
        res.writeHead(302, { location: `${PUBLIC_URL}/app/connections` });
        res.end();
        return;
      }
      // NetSuite machine-to-machine: we generate the key pair; the customer registers the public key.
      if (req.method === "POST" && url.pathname === "/rt/connect/netsuite") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as Record<string, string>;
        const t = await ctx.call<{ workspace: string; subject: string }>("runtime:redeemTicket", { ticket: body.ticket ?? "", purpose: "connect" });
        if (t.subject !== "netsuite" || !body.accountDomain || !body.clientId || !body.certificateId) return send(res, 400, { error: "accountDomain, clientId and certificateId are required" });
        const { privateKeyPem, publicKeyPem } = newKeyPair();
        const cred: NetSuiteCredential = { accountDomain: body.accountDomain.replace(/\/$/, ""), clientId: body.clientId, certificateId: body.certificateId, privateKeyPem };
        forgetToken(t.workspace);
        await rt.call(t.workspace, "runtime:storeConnection", { provider: "netsuite", status: "pending", account: cred.accountDomain, sealed: rt.seal(t.workspace, "connection:netsuite", cred), publicKeyPem, detail: "Register this public key on the NetSuite integration record, then verify." });
        return send(res, 200, { publicKeyPem });
      }
      return send(res, 404, { error: "not found" });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      const status = e.code === "NOT_FOUND" ? 404 : e.code === "FORBIDDEN" || e.code === "UNAUTHORIZED" ? 403 : 500;
      ctx.log.warn(`rt ${req.method} ${url.pathname}: ${e.code ?? ""} ${e.message ?? err}`);
      return send(res, status, { error: status === 500 ? "internal error" : e.message });
    }
  }

  /* ----------------------------------------- durable work ----------------------------------------- */

  type Item = Awaited<ReturnType<typeof ctx.work.claim>>[number];
  const workers: Record<string, (item: Item, workspace: string) => Promise<Parameters<typeof ctx.work.finish>[1]>> = {
    async deliver(item, ws) {
      const deliveryId = String(item.input.deliveryId);
      const c = await rt.call(ws, "runtime:deliveryContext", { deliveryId });
      if (c.delivery.status === "delivered") return { outcome: "done", receipt: { skipped: "already delivered" } };
      if (c.integration.kind === "stripe_app") {
        const by = "runtime (stripe-webhooks-subscriptions-node-ts @ 4812d259e7e8)";
        return apps.deliverStripeApp(rt, ws, c, (outcome, extra = {}) => rt.call(ws, "runtime:recordAttempt", { deliveryId, outcome, by, ...extra }));
      }
      if (c.integration.kind === "ledgerly") {
        const by = `runtime (${ledgerly.UPSTREAM_LABEL})`;
        return ledgerly.deliver(rt, ws, c, qboSecret, (outcome, extra = {}) => rt.call(ws, "runtime:recordAttempt", { deliveryId, outcome, by, ...extra }));
      }
      let payload = rt.open<Payload>(ws, "receipt", c.receipt.sealed);
      const applied: string[] = [];
      for (const a of c.adapters as { id: string; adapter: string; appliesTo: string[] }[]) {
        if (a.appliesTo.length && !a.appliesTo.includes(c.receipt.apiVersion ?? "")) continue;
        const adapter = ADAPTERS[a.adapter];
        if (adapter) {
          payload = adapter.apply(payload);
          applied.push(a.id);
        }
      }
      const by = `runtime (${UPSTREAM.repository} @ ${UPSTREAM.commit.slice(0, 12)})`;
      const record = (outcome: string, extra: Record<string, unknown> = {}) =>
        rt.call<{ retry: boolean }>(ws, "runtime:recordAttempt", { deliveryId, outcome, by, ...(applied.length ? { correction: applied.join(",") } : {}), ...extra });
      const violations = contractViolations(payload);
      if (violations.length) {
        await record("held", { violations, apiVersion: c.receipt.apiVersion ?? "unknown", detail: `Input contract: payload lacks ${violations.join(", ")}` });
        return { outcome: "done", receipt: { held: violations } };
      }
      let ns: Awaited<ReturnType<Runtime["netsuite"]>>;
      try {
        ns = await rt.netsuite(ws);
      } catch (err) {
        if (err instanceof AuthorizationLost) {
          await record("awaiting_authorization", { detail: err.message });
          return { outcome: "done", receipt: { awaiting: "netsuite authorization" } };
        }
        throw err;
      }
      if (!ns) {
        await record("awaiting_authorization", { detail: "NetSuite is not connected" });
        return { outcome: "done" };
      }
      const result = await execute(payload, c.integration.settings, { baseUrl: ns.cred.accountDomain, accessToken: ns.token });
      if (result.status === "created" || result.status === "duplicate") {
        await record("delivered", { destinationRef: String(result.erpOrder?.id ?? ""), detail: `upstream: ${result.status}` });
        return { outcome: "done", receipt: { upstream: result } };
      }
      if (result.status === "rejected" && /invalid login/i.test(result.message ?? "")) {
        forgetToken(ws);
        await record("awaiting_authorization", { detail: result.message });
        return { outcome: "done" };
      }
      const r = await record(result.status, { detail: result.message ?? result.status });
      return r.retry ? { outcome: "retry", error: { message: result.message ?? "failed" } } : { outcome: "done", receipt: { upstream: result } };
    },
    async "verify-connection"(item, ws) {
      const provider = String(item.input.provider);
      if (provider === "netsuite") {
        forgetToken(ws);
        try {
          const ns = await rt.netsuite(ws);
          await rt.call(ws, "runtime:storeConnection", { provider, status: ns ? "verified" : "error", detail: ns ? "Token issued." : "Not connected." });
        } catch (err) {
          await rt.call(ws, "runtime:storeConnection", { provider, status: "error", detail: (err as Error).message });
        }
      }
      return { outcome: "done" };
    },
    async subscribe(item, ws) {
      const shop = await rt.shopify(ws);
      if (!shop) return { outcome: "retry", error: { message: "Shopify not connected" }, retryInMs: 5000 };
      const id = await subscribeOrdersCreate(shop, `${PUBLIC_URL}/rt/hooks/shopify/${ws}/${String(item.input.integrationId)}`);
      return { outcome: "done", receipt: { subscription: id } };
    },
    ...maintenanceHandlers(() => rt),
    ...reconcileHandlers(() => rt),
    ...ledgerly.workers(() => rt, () => qboSecret, PUBLIC_URL),
    ...onboardingHandlers(() => rt, () => qboSecret),
    ...apps.workers(() => rt, () => qboSecret, PUBLIC_URL),
  };

  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      let items: Item[] = [];
      try {
        items = await ctx.work.claim({ kinds: Object.keys(workers), limit: 8, leaseMs: 120_000 });
      } catch (err) {
        ctx.log.error(`work claim failed: ${(err as Error).message}`);
      }
      await Promise.all(
        items.map(async (item) => {
          const ws = item.tenantId;
          try {
            if (!ws) throw new Error("work without a workspace");
            await ctx.work.finish(item, await workers[item.kind]!(item, ws));
          } catch (err) {
            ctx.log.warn(`work ${item.kind} ${item.id}: ${(err as Error).message}`);
            await ctx.work.finish(item, { outcome: "retry", error: { message: (err as Error).message } }).catch(() => undefined);
          }
        }),
      );
      if (!items.length) await new Promise((r) => setTimeout(r, 250));
    }
  })();

  return {
    request,
    health: () => ({ state: "ready" }),
    close: async () => {
      stopped = true;
      await loop;
    },
  };
});
