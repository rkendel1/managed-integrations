/**
 * Shopify Admin access for one shop: OAuth (authorization code, expiring offline tokens with rotation),
 * GraphQL, webhook subscription, and the order listing reconciliation reads.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface ShopifyCredential {
  shop: string; // base URL of the shop's Admin API host, e.g. https://acme.myshopify.com
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export const API_VERSION = "2026-10";

/** Shopify's OAuth callback HMAC: hex HMAC-SHA256 over the sorted query without `hmac`. */
export function verifyCallbackHmac(query: URLSearchParams, secret: string): boolean {
  const given = query.get("hmac") ?? "";
  const message = [...query.entries()]
    .filter(([k]) => k !== "hmac" && k !== "signature")
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const expected = createHmac("sha256", secret).update(message).digest("hex");
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export async function exchangeToken(shop: string, clientId: string, secret: string, params: Record<string, string>) {
  const res = await fetch(`${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: secret, expiring: "1", ...params }),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!res.ok || !json.access_token) throw new Error(`Shopify token exchange refused (${res.status})`);
  return {
    accessToken: json.access_token,
    ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
    ...(json.expires_in ? { expiresAt: Date.now() + json.expires_in * 1000 } : {}),
    scope: json.scope ?? "",
  };
}

export class ShopifyAuthLost extends Error {}

/** A GraphQL call; refreshes once on 401 when a refresh token is held, reporting the rotated credential. */
export async function graphql<T>(
  cred: ShopifyCredential,
  query: string,
  variables: Record<string, unknown>,
  refresh?: () => Promise<ShopifyCredential>,
): Promise<{ data: T; cred: ShopifyCredential }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${cred.shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": cred.accessToken },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 401 && attempt === 0 && refresh) {
      cred = await refresh();
      continue;
    }
    if (res.status === 401) throw new ShopifyAuthLost("Shopify refused the access token");
    const json = (await res.json()) as { data?: T; errors?: unknown };
    if (!res.ok || json.errors || !json.data) throw new Error(`Shopify GraphQL ${res.status}: ${JSON.stringify(json.errors ?? "").slice(0, 200)}`);
    return { data: json.data, cred };
  }
}

export interface ListedOrder {
  legacyResourceId: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
}

/** Every order created in [from, to), oldest first. */
export async function ordersCreatedBetween(cred: ShopifyCredential, from: string, to: string, refresh?: () => Promise<ShopifyCredential>) {
  const out: ListedOrder[] = [];
  let after: string | null = null;
  for (;;) {
    const r: { data: { orders: { nodes: ListedOrder[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }; cred: ShopifyCredential } =
      await graphql(
        cred,
        `query($q:String,$after:String){orders(first:100,after:$after,query:$q,sortKey:CREATED_AT){nodes{legacyResourceId name createdAt cancelledAt} pageInfo{hasNextPage endCursor}}}`,
        { q: `created_at:>='${from}' AND created_at:<'${to}'`, after },
        refresh,
      );
    cred = r.cred;
    out.push(...r.data.orders.nodes);
    if (!r.data.orders.pageInfo.hasNextPage || !r.data.orders.pageInfo.endCursor) return { orders: out, cred };
    after = r.data.orders.pageInfo.endCursor;
  }
}

export async function subscribeOrdersCreate(cred: ShopifyCredential, callbackUrl: string) {
  const r = await graphql<{ webhookSubscriptionCreate: { webhookSubscription: { id: string } | null; userErrors: { message: string }[] } }>(
    cred,
    `mutation($cb:String!){webhookSubscriptionCreate(topic:ORDERS_CREATE,webhookSubscription:{callbackUrl:$cb,format:JSON}){webhookSubscription{id} userErrors{message}}}`,
    { cb: callbackUrl },
  );
  const errors = r.data.webhookSubscriptionCreate.userErrors;
  if (errors?.length && !errors.every((e) => /already/i.test(e.message))) throw new Error(errors.map((e) => e.message).join("; "));
  return r.data.webhookSubscriptionCreate.webhookSubscription?.id ?? "existing";
}
