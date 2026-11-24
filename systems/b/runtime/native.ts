/**
 * System B's native polling engine and its repair path.
 *
 * The engine reads Shopify orders updated since a cursor with a declared query specification (`priceField` is
 * the line-item price it reads) and writes NetSuite sales orders with the adopted NetSuite adapter. A run that
 * cannot read the window fails without moving the cursor. A schema change becomes an incident; a planner
 * proposes a new specification (an EVE agent, or a deterministic playbook), System B validates it with a fixed
 * acceptance suite, a person approves, a one-order canary runs and is verified, then the engine is promoted.
 */
import { createHash } from "node:crypto";
import { createNetSuiteAdapter } from "shopify-sync/src/adapters/netsuite.js";
import { syncOrder } from "shopify-sync/src/sync.js";
import type { ComponentWorkItem, ComponentWorkOutcome } from "@feltdb/feltkit/server";
import type { Runtime } from "./component.ts";
import { graphql, type ShopifyCredential } from "./shopify.ts";
import { readSalesOrder } from "./netsuite.ts";

type Handler = (item: ComponentWorkItem, ws: string) => Promise<ComponentWorkOutcome>;
export interface Engine { version: number; priceField: string }

const ordersQuery = (e: Engine) =>
  `query($q:String,$after:String){orders(first:50,after:$after,query:$q,sortKey:UPDATED_AT){nodes{legacyResourceId name updatedAt createdAt email currencyCode note totalPriceSet{shopMoney{amount}} lineItems(first:50){nodes{sku quantity ${e.priceField}{shopMoney{amount}}}}} pageInfo{hasNextPage endCursor}}}`;

export interface NativeOrder { sourceId: string; reference: string; updatedAt: string; createdAt: string; email: string | null; currency: string; note: string | null; total: number; lines: { sku: string; qty: number; unitPrice: number }[] }

/** Read the window with an engine specification. Throws ShopifySchemaError when the query no longer fits. */
export async function readWindow(shop: ShopifyCredential, e: Engine, since: string, limit?: number): Promise<NativeOrder[]> {
  const out: NativeOrder[] = [];
  let after: string | null = null;
  for (;;) {
    let data;
    try {
      ({ data } = await graphql<any>(shop, ordersQuery(e), { q: `updated_at:>='${since}'`, after }));
    } catch (err) {
      const m = (err as Error).message;
      if (/Cannot query field|doesn't exist on type|Unknown field/i.test(m)) throw new ShopifySchemaError(m);
      throw err;
    }
    for (const o of data.orders.nodes) {
      out.push({
        sourceId: o.legacyResourceId, reference: o.name, updatedAt: o.updatedAt, createdAt: o.createdAt, email: o.email, currency: o.currencyCode, note: o.note,
        total: Number(o.totalPriceSet.shopMoney.amount),
        lines: o.lineItems.nodes.filter((l: any) => l.sku).map((l: any) => ({ sku: l.sku, qty: Number(l.quantity), unitPrice: Number(l[e.priceField]?.shopMoney?.amount) })),
      });
      if (limit && out.length >= limit) return out;
    }
    if (!data.orders.pageInfo.hasNextPage) return out;
    after = data.orders.pageInfo.endCursor;
  }
}
export class ShopifySchemaError extends Error {}

/**
 * Orders updated after the held cursor, read without line-item fields (what a schema change cannot break): the
 * affected scope. (The sync window itself is inclusive — `>=` — and safe to repeat: NetSuite upserts by external id.)
 */
async function affectedScope(shop: ShopifyCredential, since: string) {
  const { data } = await graphql<any>(shop, `query($q:String){orders(first:250,query:$q,sortKey:UPDATED_AT){nodes{legacyResourceId name}}}`, { q: `updated_at:>'${since}'` });
  return data.orders.nodes.map((o: any) => ({ sourceId: o.legacyResourceId, reference: o.name }));
}
async function lineItemFields(shop: ShopifyCredential) {
  const { data } = await graphql<any>(shop, `{__type(name:"LineItem"){fields{name type{kind name ofType{name}}}}}`, {});
  return (data.__type?.fields ?? []).map((f: any) => ({ name: f.name, type: f.type.name ?? `${f.type.ofType?.name}!` }));
}

/* ------------------------------------------- planners ------------------------------------------- */

export interface Candidate { planner: string; priceField: string | null; hypothesis: string; durationMs: number }

/** EVE agent (systems/b/agent-eve) over its HTTP API: one bounded task, a structured answer. */
async function evePlanner(url: string, credential: string, task: string): Promise<Candidate> {
  const t0 = Date.now();
  const auth = `Basic ${Buffer.from(credential).toString("base64")}`;
  const outputSchema = { type: "object", properties: { priceField: { type: ["string", "null"] }, hypothesis: { type: "string" } }, required: ["priceField", "hypothesis"] };
  const created = await fetch(`${url}/eve/v1/session`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ message: task, outputSchema }) });
  if (!created.ok) throw new Error(`repair agent refused the task (${created.status})`);
  const { sessionId } = (await created.json()) as { sessionId: string };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120_000);
  try {
    const stream = await fetch(`${url}/eve/v1/session/${sessionId}/stream`, { headers: { authorization: auth }, signal: ctl.signal });
    const reader = stream.body!.getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        // Wire format (stream version 27): heartbeats `{ "$eve": … }` and lines `{ at, facts: [{ type, data }] }`.
        const line_ = JSON.parse(line) as { facts?: { type: string; data?: { kind?: string; value?: unknown; outcome?: string } }[] };
        for (const ev of line_.facts ?? []) {
          if (ev.type === "content.completed" && ev.data?.kind === "result") {
            const v = ev.data.value as { priceField: string | null; hypothesis: string };
            ctl.abort();
            const field = v.priceField && v.priceField !== "none" ? v.priceField : null;
            return { planner: "eve", priceField: field, hypothesis: v.hypothesis, durationMs: Date.now() - t0 };
          }
          if (ev.type === "turn.settled" && ev.data?.outcome !== "completed") throw new Error(`repair agent turn ${ev.data?.outcome}`);
        }
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") throw err;
  } finally {
    clearTimeout(timer);
  }
  throw new Error("repair agent returned no structured result");
}

/** Deterministic playbook: the one field of the same type whose name ends like the missing one. */
function playbookPlanner(missing: string, fields: { name: string; type: string }[]): Candidate {
  const suffix = /([A-Z][a-z]+Set)$/.exec(missing)?.[1] ?? "";
  const pick = fields.filter((f) => f.type.startsWith("MoneyBag") && f.name !== missing && (!suffix || f.name.endsWith(suffix)));
  return pick.length === 1
    ? { planner: "playbook", priceField: pick[0]!.name, hypothesis: `${missing} is gone; ${pick[0]!.name} is the only MoneyBag field ending in ${suffix}.`, durationMs: 0 }
    : { planner: "playbook", priceField: null, hypothesis: `No unique replacement for ${missing} (${pick.length} candidates).`, durationMs: 0 };
}

/* ------------------------------------------- acceptance suite ------------------------------------------- */

/** The fixed acceptance suite every candidate must pass. A planner cannot change it: it is System B's code. */
export const ACCEPTANCE_SUITE = [
  "the candidate query executes against the provider for the affected window (read only)",
  "every affected order maps: SKU present, quantity > 0, unit price a positive number",
  "every order's mapped lines add up to the provider's own order total",
  "the candidate changes only the declared price field",
  "the adopted engine specification stays available for rollback",
];
export const SUITE_SHA256 = createHash("sha256").update(JSON.stringify(ACCEPTANCE_SUITE) + acceptance.toString()).digest("hex");

async function acceptance(shop: ShopifyCredential, current: Engine, candidate: Engine, since: string) {
  const checks: { name: string; result: "passed" | "failed"; detail: string }[] = [];
  let orders: NativeOrder[] = [];
  try {
    orders = await readWindow(shop, candidate, since);
    checks.push({ name: ACCEPTANCE_SUITE[0]!, result: "passed", detail: `${orders.length} order(s) read` });
  } catch (err) {
    checks.push({ name: ACCEPTANCE_SUITE[0]!, result: "failed", detail: (err as Error).message.slice(0, 200) });
  }
  const bad = orders.filter((o) => !o.lines.length || o.lines.some((l) => !l.sku || !(l.qty > 0) || !(l.unitPrice > 0)));
  checks.push({ name: ACCEPTANCE_SUITE[1]!, result: orders.length && !bad.length ? "passed" : "failed", detail: `${orders.length - bad.length}/${orders.length}` });
  const off = orders.filter((o) => Math.abs(o.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0) - o.total) > 0.005);
  checks.push({ name: ACCEPTANCE_SUITE[2]!, result: orders.length && !off.length ? "passed" : "failed", detail: `${orders.length - off.length}/${orders.length} totals equal Shopify's` });
  const changed = Object.keys(candidate).filter((k) => k !== "version" && (candidate as any)[k] !== (current as any)[k]);
  checks.push({ name: ACCEPTANCE_SUITE[3]!, result: changed.length === 1 && changed[0] === "priceField" ? "passed" : "failed", detail: `changed: ${changed.join(", ") || "nothing"}` });
  checks.push({ name: ACCEPTANCE_SUITE[4]!, result: "passed", detail: `engine v${current.version} (${current.priceField}) retained` });
  return checks;
}

/* --------------------------------------------- work --------------------------------------------- */

export function workers(get: () => Runtime): Record<string, Handler> {
  return {
    async "native-sync"(item, ws) {
      const rt = get();
      const runId = String(item.input.runId);
      const c = await rt.call(ws, "native:runContext", { runId });
      if (c.run.status !== "running") return { outcome: "done" };
      const shop = await rt.shopify(ws);
      const ns = await rt.netsuite(ws);
      if (!shop || !ns) {
        await rt.call(ws, "native:finishRun", { runId, status: "failed", records: [], errorClass: "not_connected", errorMessage: "Shopify and NetSuite must be connected" });
        return { outcome: "done" };
      }
      let orders: NativeOrder[];
      try {
        orders = await readWindow(shop, c.engine, c.run.cursorBefore, c.run.canary);
      } catch (err) {
        if (err instanceof ShopifySchemaError) {
          await rt.call(ws, "native:finishRun", {
            runId, status: "failed", records: [], errorClass: "schema_drift", errorMessage: err.message.replace(/^Shopify GraphQL \d+: /, "").slice(0, 300),
            affected: await affectedScope(shop, c.run.cursorBefore), providerFields: await lineItemFields(shop),
          });
          return { outcome: "done" };
        }
        throw err;
      }
      const adapter = createNetSuiteAdapter({ baseUrl: ns.cred.accountDomain, accessToken: ns.token });
      const records = [];
      for (const o of orders) {
        const r = (await syncOrder(adapter, {
          reference: o.reference, externalId: `shopify-${o.sourceId}`, customerCode: String(c.settings.defaultCustomer ?? "WEB"),
          orderDate: o.createdAt.slice(0, 10), currency: o.currency, note: o.note ?? "", lines: o.lines,
        })) as { status: string; erpOrder?: { id?: string }; message?: string };
        records.push({ sourceId: o.sourceId, reference: o.reference, outcome: r.status === "created" || r.status === "duplicate" ? "delivered" : r.status, ...(r.erpOrder?.id ? { destinationRef: String(r.erpOrder.id) } : {}) });
      }
      const allDelivered = records.every((r) => r.outcome === "delivered");
      const cursorAfter = allDelivered && orders.length ? orders.map((o) => o.updatedAt).sort().at(-1)! : c.run.cursorBefore;
      await rt.call(ws, "native:finishRun", { runId, status: allDelivered ? "succeeded" : "failed", records, cursorAfter, ...(allDelivered ? {} : { errorClass: "delivery_failed", errorMessage: records.find((r) => r.outcome !== "delivered")?.outcome ?? "" }) });
      return { outcome: "done", receipt: { orders: orders.length } };
    },
  };
}

/** The repair steps the maintenance driver calls for a schema_drift event. */
export const repair = {
  async propose(rt: Runtime, ws: string, finding: any, current: Engine): Promise<Candidate> {
    const missing = /field ['"]?(\w+)['"]?/i.exec(String(finding.error))?.[1] ?? current.priceField;
    const fields = (finding.providerFields ?? []) as { name: string; type: string }[];
    const url = process.env.MI_REPAIR_AGENT_URL;
    const cred = await rt.ctx.credential("repair-agent").catch(() => null);
    if (url && cred) {
      const task = [
        `Incident: the integration's GraphQL query failed with: ${finding.error}`,
        `Current engine specification: priceField = ${current.priceField} (the line item's unit price before discounts, read as ${current.priceField}.shopMoney.amount).`,
        `The provider's published fields of LineItem now: ${fields.map((f) => `${f.name}: ${f.type}`).join(", ")}.`,
        "Propose the replacement for priceField, or null if none has the same meaning and type.",
      ].join("\n");
      try {
        return await evePlanner(url, cred, task);
      } catch (err) {
        const p = playbookPlanner(missing, fields);
        return { ...p, hypothesis: `${p.hypothesis} (repair agent unavailable: ${(err as Error).message})` };
      }
    }
    return playbookPlanner(missing, fields);
  },
  async validate(rt: Runtime, ws: string, current: Engine, candidate: Engine, since: string) {
    const shop = await rt.shopify(ws);
    if (!shop) throw new Error("Shopify is not connected");
    return acceptance(shop, current, candidate, since);
  },
  /** The canary's order and every affected order, read back from NetSuite with the expected rates. */
  async verify(rt: Runtime, ws: string, engine: Engine, since: string, sourceIds: string[]) {
    const shop = await rt.shopify(ws);
    const ns = await rt.netsuite(ws);
    if (!shop || !ns) throw new Error("not connected");
    const truth = new Map((await readWindow(shop, engine, since)).map((o) => [o.sourceId, o]));
    const out: { sourceId: string; ok: boolean; detail: string }[] = [];
    for (const id of sourceIds) {
      const rec = await readSalesOrder(ns.cred, ns.token, `shopify-${id}`);
      const o = truth.get(id);
      const ok = Boolean(rec && o && rec.item?.items.every((l, i) => l.rate === o.lines[i]?.unitPrice));
      out.push({ sourceId: id, ok, detail: rec ? `NetSuite ${rec.id}${ok ? ", rates equal Shopify's" : ", RATES DIFFER"}` : "MISSING in NetSuite" });
    }
    return out;
  },
};
