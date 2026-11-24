/**
 * Scenario harness for System B: drives the running application only through its public surfaces
 * (FeltKit's client over HTTP, the runtime component's routes, MCP) and the provider simulators. It never
 * opens the application's state directly.
 */
import { createClient, type FeltKitClient } from "@feltdb/feltkit/client";
import { writeFileSync, mkdirSync } from "node:fs";

export const B = process.env.MI_B_URL ?? "http://127.0.0.1:3100";
export const FX = {
  shopify: process.env.FX_SHOPIFY ?? "http://127.0.0.1:5010",
  shopify2: process.env.FX_SHOPIFY2 ?? "http://127.0.0.1:5011",
  shopify3: process.env.FX_SHOPIFY3 ?? "http://127.0.0.1:5012",
  netsuite: process.env.FX_NETSUITE ?? "http://127.0.0.1:5020",
  stripe: process.env.FX_STRIPE ?? "http://127.0.0.1:5030",
  qbo: process.env.FX_QBO ?? "http://127.0.0.1:5040",
};

const started = Date.now();
const steps: { n: string; text: string; ms: number; data?: unknown }[] = [];
export function step(n: string | number, text: string, data?: unknown) {
  steps.push({ n: String(n), text, ms: Date.now() - started, ...(data === undefined ? {} : { data }) });
  console.log(`  ${String(n).padStart(3)}  ${text}`);
}
export function finish(name: string) {
  const dir = process.env.MI_EVIDENCE_DIR ?? "../../docs/evidence/runs/system-b";
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${name}-${started}.json`;
  writeFileSync(file, JSON.stringify({ scenario: name, system: "B", startedAt: new Date(started).toISOString(), ms: Date.now() - started, steps }, null, 2));
  console.log(`DONE in ${Math.round((Date.now() - started) / 1000)}s — evidence: ${file}`);
}
export function expect(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`FAILED: ${message}`);
    process.exit(1);
  }
}

export async function wait<T>(what: string, probe: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await probe().catch(() => null);
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

export async function json(url: string, init: RequestInit & { body?: any } = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...(init.body !== undefined && typeof init.body !== "string" ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

export function client(): FeltKitClient {
  return createClient({ url: B, session: "bearer" });
}

/** A customer company: an account, its workspace, and the runtime admitted to it. */
export async function company(name: string, email: string) {
  const c = client();
  await c.signUp({ email, password: `${name}-scenario-password-1`, name });
  const tenant = await c.createTenant(name);
  await c.switchTenant(tenant.id);
  await c.addMember("component:runtime", "runtime");
  return { c, workspace: tenant.id };
}

/** Connect a Shopify shop through B's OAuth flow (follows the redirects a browser would). */
export async function connectShopify(c: FeltKitClient, api: any, shop: string) {
  const { ticket } = await c.mutation(api.connections.begin, { provider: "shopify" });
  let url = `${B}/rt/connect/shopify?ticket=${ticket}&shop=${encodeURIComponent(shop)}`;
  for (let hops = 0; hops < 5; hops++) {
    const res = await fetch(url, { redirect: "manual" });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      if (loc.endsWith("/app/connections")) return;
      url = loc;
      continue;
    }
    throw new Error(`Shopify connect stopped at ${res.status}: ${await res.text()}`);
  }
}

/** Connect NetSuite (machine-to-machine): B generates the key pair; the simulator gets the public key. */
export async function connectNetSuite(c: FeltKitClient, api: any) {
  const { ticket } = await c.mutation(api.connections.begin, { provider: "netsuite" });
  const r = await json(`${B}/rt/connect/netsuite`, {
    method: "POST",
    body: { ticket, accountDomain: FX.netsuite, clientId: "fixture-netsuite-client-id", certificateId: "fixture-cert-id" },
  });
  if (r.status !== 200) throw new Error(`NetSuite connect: ${r.status} ${JSON.stringify(r.body)}`);
  await json(`${FX.netsuite}/__fixture/public-key`, { method: "POST", body: { pem: r.body.publicKeyPem } });
  await c.mutation(api.connections.verify, { provider: "netsuite" });
  await wait("NetSuite verified", async () => (await c.query(api.connections.list)).find((x: any) => x.provider === "netsuite" && x.status === "verified"));
}

/** A company with the Shopify → NetSuite order sync under management and its webhook subscribed. */
export async function adoptedCompany(api: any, name: string, shopUrl: string) {
  const run = Date.now().toString(36);
  await json(`${FX.netsuite}/__fixture/config`, { method: "POST", body: { oneWorld: false } });
  const co = await company(name, `ops-${run}@${name.toLowerCase()}.test`);
  await connectShopify(co.c, api, shopUrl);
  await connectNetSuite(co.c, api);
  const integrationId: string = await co.c.mutation(api.integrations.adoptOrderSync, { defaultCustomer: "WEB" });
  await wait("orders/create subscription", async () => {
    const st = await json(`${shopUrl}/__fixture/state`);
    return st.body.subscriptions.some((x: { callbackUrl: string }) => x.callbackUrl.includes(integrationId));
  });
  return { ...co, integrationId, run };
}

export const netsuiteRecords = async (legacyId: string) =>
  ((await json(`${FX.netsuite}/__fixture/state`)).body.salesOrders as { externalId: string | null; id: string; item: { items: { rate: number }[] } }[]).filter(
    (r) => r.externalId === `shopify-${legacyId}`,
  );

/**
 * A member of the provider's staff, invited into the company's workspace as `operator` and accepting it.
 * Development: staff are FeltKit dev identities (which may accept invitations in development). Production
 * requires an account whose verified address is the invited one (FeltKit refuses otherwise).
 */
export async function staff(owner: FeltKitClient, workspace: string, devId = "staff-1") {
  const { link } = await owner.invite({ email: `${devId}@staff.mi.test`, role: "operator", send: false });
  const token = new URLSearchParams(new URL(link, B).hash.slice(1)).get("feltkit-invitation") ?? "";
  const s = client();
  await s.signInAsDevUser(devId);
  await s.acceptInvitation(token);
  await s.switchTenant(workspace);
  return s;
}
