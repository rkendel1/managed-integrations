/** The runtime's Stripe → QuickBooks part: routes, deliveries with ledgerly, setup and the dependency check. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ComponentWorkItem, ComponentWorkOutcome } from "@feltdb/feltkit/server";
import type { Runtime } from "./component.ts";
import { AuthorizationLost } from "./netsuite.ts";
import { QBO, accountMapByName, exchangeCode, grant, listAccounts, type QboGrant } from "./quickbooks.ts";
import { PATCHES, UPSTREAM, artifactFor, declaredMinorVersion, executeEvent, stripeClient } from "./ledgerly.ts";

export const UPSTREAM_LABEL = `${UPSTREAM.repository} @ ${UPSTREAM.commit.slice(0, 12)}`;

/** Published provider facts the running code is checked against (cited; not inferred). */
export const PROVIDER_FACTS = {
  "quickbooks.minorversion": {
    minimum: 75,
    since: "2025-08-01",
    source: "https://blogs.intuit.com/2025/01/21/changes-to-our-accounting-api-that-may-impact-your-application/",
    statement: "Minor versions below 75 are no longer supported; requests are served as minor version 75.",
  },
} as const;

/** Stripe-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>, within 5 minutes. */
export function verifyStripeSignature(raw: Buffer, header: string | undefined, secret: string, toleranceS = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceS) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${raw.toString("utf8")}`).digest("hex"));
  return header.split(",").some((p) => {
    const [k, v] = p.split("=");
    const given = Buffer.from(v ?? "");
    return k === "v1" && given.length === expected.length && timingSafeEqual(given, expected);
  });
}

type Send = (res: ServerResponse, status: number, body: unknown) => void;

export function routes(rt: Runtime, h: { readBody(req: IncomingMessage): Promise<Buffer>; send: Send; signState(v: string): string; readState(s: string): string | null; publicUrl: string; qboSecret: string }) {
  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const parts = url.pathname.split("/").filter(Boolean);
    // Stripe events → /rt/hooks/stripe/<workspace>/<integrationId>
    if (req.method === "POST" && parts[1] === "hooks" && parts[2] === "stripe" && parts.length === 5) {
      const [, , , ws, integrationId] = parts as [string, string, string, string, string];
      const raw = await h.readBody(req);
      const i = await rt.call(ws, "runtime:integrationSettings", { integrationId });
      const sealed = i.settings.endpointSecret as string | undefined;
      if (!sealed || !verifyStripeSignature(raw, req.headers["stripe-signature"] as string | undefined, rt.open<string>(ws, `endpoint:${integrationId}`, sealed))) {
        h.send(res, 400, { error: "invalid signature" });
        return true;
      }
      const event = JSON.parse(raw.toString("utf8")) as { id: string; type: string };
      if (!/^evt_/.test(event.id)) {
        h.send(res, 400, { error: "not a Stripe event" });
        return true;
      }
      const r = await rt.call(ws, "runtime:ingest", {
        integrationId, providerEventId: event.id, topic: event.type, sourceId: event.id, reference: event.type,
        sealed: rt.seal(ws, "receipt", event), origin: "webhook",
      });
      h.send(res, 200, r);
      return true;
    }
    // Stripe: a restricted key, proven by reading the account.
    if (req.method === "POST" && url.pathname === "/rt/connect/stripe") {
      const body = JSON.parse((await h.readBody(req)).toString("utf8") || "{}") as { ticket?: string; apiKey?: string };
      const t = await rt.ctx.call<{ workspace: string; subject: string }>("runtime:redeemTicket", { ticket: body.ticket ?? "", purpose: "connect" });
      if (t.subject !== "stripe" || !/^(rk|sk)_(test|live)_/.test(body.apiKey ?? "")) {
        h.send(res, 400, { error: "a Stripe restricted or secret key is required" });
        return true;
      }
      const account = await stripeClient(body.apiKey!).accounts.retrieve().catch((e: Error) => e);
      if (account instanceof Error) {
        await rt.call(t.workspace, "runtime:storeConnection", { provider: "stripe", status: "error", detail: "Stripe refused the key." });
        h.send(res, 422, { error: "Stripe refused the key" });
        return true;
      }
      await rt.call(t.workspace, "runtime:storeConnection", { provider: "stripe", status: "verified", account: account.id, sealed: rt.seal(t.workspace, "connection:stripe", { apiKey: body.apiKey }) });
      h.send(res, 200, { status: "verified", account: account.id });
      return true;
    }
    // QuickBooks OAuth: start, then Intuit's redirect back.
    if (req.method === "GET" && url.pathname === "/rt/connect/quickbooks") {
      const t = await rt.ctx.call<{ workspace: string; subject: string }>("runtime:redeemTicket", { ticket: url.searchParams.get("ticket") ?? "", purpose: "connect" });
      if (t.subject !== "quickbooks") {
        h.send(res, 400, { error: "bad ticket" });
        return true;
      }
      const auth = new URL(QBO.authorizeUrl);
      auth.searchParams.set("client_id", QBO.clientId);
      auth.searchParams.set("response_type", "code");
      auth.searchParams.set("scope", "com.intuit.quickbooks.accounting");
      auth.searchParams.set("redirect_uri", `${h.publicUrl}/rt/oauth/quickbooks/callback`);
      auth.searchParams.set("state", h.signState(`${t.workspace}|qbo|${Date.now()}`));
      res.writeHead(302, { location: auth.toString() });
      res.end();
      return true;
    }
    if (req.method === "GET" && url.pathname === "/rt/oauth/quickbooks/callback") {
      const v = h.readState(url.searchParams.get("state") ?? "");
      const [ws, kind, issued] = (v ?? "").split("|");
      if (!v || kind !== "qbo" || !ws || Date.now() - Number(issued) > 10 * 60_000) {
        h.send(res, 400, { error: "expired or forged state" });
        return true;
      }
      if (url.searchParams.get("error")) {
        await rt.call(ws, "runtime:storeConnection", { provider: "quickbooks", status: "error", detail: `QuickBooks: ${url.searchParams.get("error")}` });
        res.writeHead(302, { location: `${h.publicUrl}/app/connections` });
        res.end();
        return true;
      }
      const g = await exchangeCode(h.qboSecret, url.searchParams.get("code") ?? "", `${h.publicUrl}/rt/oauth/quickbooks/callback`, url.searchParams.get("realmId") ?? "");
      await rt.call(ws, "runtime:storeConnection", { provider: "quickbooks", status: "verified", account: g.realmId, sealed: rt.seal(ws, "connection:quickbooks", g), detail: "Connected." });
      res.writeHead(302, { location: `${h.publicUrl}/app/connections` });
      res.end();
      return true;
    }
    return false;
  };
}

async function stripeKey(rt: Runtime, ws: string) {
  const c = await rt.call<{ sealed: string } | null>(ws, "runtime:sealedConnection", { provider: "stripe" });
  if (!c) throw new Error("Stripe is not connected");
  return rt.open<{ apiKey: string }>(ws, "connection:stripe", c.sealed).apiKey;
}

/** One ledgerly delivery: returns the outcome to record. */
export async function deliver(rt: Runtime, ws: string, c: any, qboSecret: string, record: (o: string, x?: Record<string, unknown>) => Promise<{ retry: boolean }>): Promise<ComponentWorkOutcome> {
  const event = rt.open<{ id: string; type: string }>(ws, "receipt", c.receipt.sealed);
  const patches: { id: string; patch: string }[] = c.patches ?? [];
  const correction = patches.map((p) => p.id).join(",") || undefined;
  let g: QboGrant;
  try {
    g = await grant(rt, ws, qboSecret);
  } catch (err) {
    if (err instanceof AuthorizationLost) {
      await record("awaiting_authorization", { detail: err.message, ...(correction ? { correction } : {}) });
      return { outcome: "done" };
    }
    throw err;
  }
  const accountMap = c.integration.settings.accountMap as Record<string, { qboId: string; name: string }> | undefined;
  if (!accountMap) return { outcome: "retry", error: { message: "account map not set up yet" }, retryInMs: 2000 };
  const key = await stripeKey(rt, ws);
  let r = await executeEvent(event, key, g, accountMap, patches.map((p) => p.patch));
  if (r.status === "unauthorized") {
    try {
      g = await grant(rt, ws, qboSecret, true);
      r = await executeEvent(event, key, g, accountMap, patches.map((p) => p.patch));
    } catch (err) {
      if (err instanceof AuthorizationLost) {
        await record("awaiting_authorization", { detail: err.message, ...(correction ? { correction } : {}) });
        return { outcome: "done" };
      }
      throw err;
    }
  }
  const detail = `ledgerly ${r.status}: ${r.entries} entr${r.entries === 1 ? "y" : "ies"}${r.minorRequested ? `; minorversion=${r.minorRequested}` : ""}; artifact ${r.artifact}${r.message ? `; ${r.message}` : ""}`;
  const extra = { detail, ...(correction ? { correction } : {}), destinationRef: event.id };
  if (r.status === "booked" || r.status === "already_booked" || r.status === "not_bookable") {
    await record("delivered", extra);
    return { outcome: "done", receipt: { status: r.status, entries: r.entries, minorRequested: r.minorRequested ?? null } };
  }
  if (r.status === "unauthorized") {
    await record("awaiting_authorization", extra);
    return { outcome: "done" };
  }
  if (r.status === "rejected") {
    // QuickBooks refuses entries that use an inactive account (Intuit error 610). Confirmed from QuickBooks' own
    // chart of accounts: a mapped account the customer made inactive is a target-side change, not a bad entry.
    const accounts = await listAccounts(g);
    const inactive = Object.entries(accountMap)
      .map(([code, m]) => ({ code, ...m, account: accounts.find((a) => a.Id === m.qboId) }))
      .filter((x) => x.account && x.account.Active === false)
      .map((x) => ({ code: x.code, qboId: x.qboId, name: x.name, type: x.account!.AccountType }));
    if (inactive.length) {
      await record("held", {
        detail,
        ...(correction ? { correction } : {}),
        target: {
          provider: "quickbooks", contract: "quickbooks.journalentry.write",
          finding: { observed: { code: /\b610\b/.test(r.message ?? "") ? "610" : null, message: r.message ?? null }, inactiveAccounts: inactive },
          customerText: `QuickBooks no longer accepts entries to ${inactive.map((x) => x.name).join(", ")} (made inactive). Your Stripe transactions are held safely; nothing is lost.`,
        },
      });
      return { outcome: "done", receipt: { held: inactive.map((x) => x.qboId) } };
    }
  }
  const rec = await record(r.status === "rejected" ? "rejected" : "failed", extra);
  return rec.retry ? { outcome: "retry", error: { message: r.message ?? "failed" } } : { outcome: "done" };
}

type Handler = (item: ComponentWorkItem, ws: string) => Promise<ComponentWorkOutcome>;

export function workers(get: () => Runtime, qboSecret: () => string, publicUrl: string): Record<string, Handler> {
  return {
    async "ledgerly-setup"(item, ws) {
      const rt = get();
      const integrationId = String(item.input.integrationId);
      const g = await grant(rt, ws, qboSecret());
      const L = (await artifactFor([])).module;
      const { map, missing } = await accountMapByName(g, L.ACCOUNTS);
      const stripe = stripeClient(await stripeKey(rt, ws));
      const endpoint = await stripe.webhookEndpoints.create({ url: `${publicUrl}/rt/hooks/stripe/${ws}/${integrationId}`, enabled_events: ["*"] });
      await rt.call(ws, "ledgerly:setSettings", {
        integrationId,
        status: "protected",
        settings: {
          accountMap: map,
          accountMapSource: "account_names",
          unmappedAccounts: missing,
          endpointId: endpoint.id,
          endpointSecret: rt.seal(ws, `endpoint:${integrationId}`, endpoint.secret),
        },
      });
      return { outcome: "done", receipt: { mapped: Object.keys(map).length, missing, endpoint: endpoint.id } };
    },
    /** Read the code that runs and compare it with the provider's published contract. */
    async "check-contracts"(item, ws) {
      const rt = get();
      const integrationId = String(item.input.integrationId);
      const patches = (await rt.call<string[]>(ws, "ledgerly:activePatches", { integrationId }));
      const m = await declaredMinorVersion(patches);
      const fact = PROVIDER_FACTS["quickbooks.minorversion"];
      if (m.version < fact.minimum) {
        await rt.call(ws, "ledgerly:openProviderEvent", {
          integrationId,
          contract: "quickbooks.minorversion",
          finding: {
            provider: "quickbooks", contract: "quickbooks.minorversion", declared: m.version, at: m.at, artifact: m.artifact,
            minimum: fact.minimum, since: fact.since, source: fact.source, statement: fact.statement,
            location: [m.at], summary: `${UPSTREAM.repository} @ ${UPSTREAM.commit.slice(0, 7)} requests minorversion ${m.version}; QuickBooks serves ${fact.minimum} since ${fact.since}`,
            patch: Object.values(PATCHES).find((p) => p.file === m.at.split(":")[0])?.id ?? null,
          },
        });
      }
      return { outcome: "done", receipt: { declared: m.version, minimum: fact.minimum } };
    },
  };
}
