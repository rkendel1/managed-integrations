/**
 * QuickBooks Online for one company (realm): OAuth 2.0 authorization code grant, access tokens renewed with
 * rotating refresh tokens (one renewal at a time per workspace, the rotated grant sealed again at once), and
 * the reads we need. `invalid_grant` means the customer's authorization is gone: the connection becomes
 * `revoked` and work waits for the customer instead of being retried.
 */
import type { Runtime } from "./component.ts";
import { AuthorizationLost } from "./netsuite.ts";

export const QBO = {
  clientId: process.env.QBO_CLIENT_ID ?? "qbo-fixture-client",
  authorizeUrl: process.env.QBO_AUTHORIZE_URL ?? "http://127.0.0.1:5040/connect/oauth2",
  tokenUrl: process.env.QBO_TOKEN_URL ?? "http://127.0.0.1:5040/oauth2/v1/tokens/bearer",
  apiBase: process.env.QBO_API_BASE ?? "http://127.0.0.1:5040",
};

export interface QboGrant {
  realmId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

async function tokenRequest(secret: string, params: Record<string, string>) {
  const res = await fetch(QBO.tokenUrl, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${QBO.clientId}:${secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(params),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  return { ok: res.ok && Boolean(json.access_token), json };
}

export async function exchangeCode(secret: string, code: string, redirectUri: string, realmId: string): Promise<QboGrant> {
  const r = await tokenRequest(secret, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
  if (!r.ok) throw new Error(`QuickBooks refused the authorization (${r.json.error ?? "no token"})`);
  return { realmId, accessToken: r.json.access_token!, refreshToken: r.json.refresh_token!, expiresAt: Date.now() + (r.json.expires_in ?? 3600) * 1000 };
}

const renewing = new Map<string, Promise<QboGrant>>();

/** A live grant for the workspace: renewed (once, even when many callers ask) when close to expiry. */
export async function grant(rt: Runtime, ws: string, secret: string, force = false): Promise<QboGrant> {
  const c = await rt.call<{ sealed: string; status: string } | null>(ws, "runtime:sealedConnection", { provider: "quickbooks" });
  if (!c) throw new AuthorizationLost("QuickBooks is not connected");
  const g = rt.open<QboGrant>(ws, "connection:quickbooks", c.sealed);
  if (!force && g.expiresAt - Date.now() > 120_000) return g;
  const inflight = renewing.get(ws);
  if (inflight) return inflight;
  const p = (async () => {
    const r = await tokenRequest(secret, { grant_type: "refresh_token", refresh_token: g.refreshToken });
    if (!r.ok) {
      if (r.json.error === "invalid_grant") {
        await rt.call(ws, "runtime:storeConnection", { provider: "quickbooks", status: "revoked", detail: "QuickBooks no longer accepts our authorization. Reconnect QuickBooks." });
        throw new AuthorizationLost("QuickBooks authorization revoked");
      }
      throw new Error(`QuickBooks token renewal failed (${r.json.error ?? "unknown"})`);
    }
    const next: QboGrant = { realmId: g.realmId, accessToken: r.json.access_token!, refreshToken: r.json.refresh_token!, expiresAt: Date.now() + (r.json.expires_in ?? 3600) * 1000 };
    await rt.call(ws, "runtime:storeConnection", { provider: "quickbooks", status: "verified", sealed: rt.seal(ws, "connection:quickbooks", next) });
    return next;
  })().finally(() => renewing.delete(ws));
  renewing.set(ws, p);
  return p;
}

export async function query<T>(g: QboGrant, q: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${QBO.apiBase}/v3/company/${encodeURIComponent(g.realmId)}/query?query=${encodeURIComponent(q)}&minorversion=75`, {
    headers: { authorization: `Bearer ${g.accessToken}`, accept: "application/json" },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

/** ledgerly account code → QuickBooks account, matched by the account names ledgerly uses. */
export async function accountMapByName(g: QboGrant, ledgerlyAccounts: Record<string, { name: string }>) {
  const r = await query<{ QueryResponse?: { Account?: { Id: string; Name: string; Active?: boolean }[] } }>(g, "select * from Account where Active in (true, false)");
  const byName = new Map((r.body.QueryResponse?.Account ?? []).map((a) => [a.Name, a]));
  const map: Record<string, { qboId: string; name: string }> = {};
  const missing: string[] = [];
  for (const [code, def] of Object.entries(ledgerlyAccounts)) {
    const a = byName.get(def.name);
    if (a) map[code] = { qboId: a.Id, name: a.Name };
    else missing.push(def.name);
  }
  return { map, missing };
}
