/**
 * Executes one Shopify order with the adopted upstream code (Milo-ai-HQ/shopify-erp-order-sync @ d01b51d,
 * MIT): its mapping (`toCanonicalOrder`), its NetSuite adapter and its `syncOrder`. Our code decides only
 * what the upstream code is given: the customer's settings, a NetSuite token, and — when a correction is
 * active — the payload as the upstream code expects it.
 */
import { toCanonicalOrder } from "shopify-sync/src/mapping.js";
import { createNetSuiteAdapter } from "shopify-sync/src/adapters/netsuite.js";
import { syncOrder } from "shopify-sync/src/sync.js";
import { materialize, type Patch } from "./artifacts.ts";
import oneWorld from "./patches/netsuite-oneworld-subsidiary.json" with { type: "json" };

export const UPSTREAM = {
  repository: "github.com/Milo-ai-HQ/shopify-erp-order-sync",
  commit: "d01b51d95993598580cdcffda6537a6f20a10a3a",
  license: "MIT",
} as const;

/** The webhook payload contract the adopted code was written against (what `toCanonicalOrder` reads). */
export const INPUT_CONTRACT = {
  apiVersions: ["2026-10"],
  required: ["id", "name", "line_items[].sku", "line_items[].quantity", "line_items[].price"],
};

export interface Payload {
  id: number | string;
  name: string;
  line_items?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

/** Fields of the input contract the payload does not carry (an empty list means the upstream code can run). */
export function contractViolations(p: Payload): string[] {
  const out: string[] = [];
  if (p.id === undefined) out.push("id");
  if (!p.name) out.push("name");
  const lines = Array.isArray(p.line_items) ? p.line_items : [];
  if (!lines.length) out.push("line_items");
  for (const field of ["sku", "quantity", "price"])
    if (lines.some((l) => l[field] === undefined || l[field] === null)) out.push(`line_items[].${field}`);
  return out;
}

/**
 * Adapters: reviewed, declarative payload corrections applied before the upstream mapping. Each is named by
 * what it fixes, so a correction record names its adapter and nothing executable is stored in the database.
 */
export const ADAPTERS: Record<string, { description: string; apply(p: Payload): Payload }> = {
  "line-price-from-price-set": {
    description: "Shopify 2027-01 no longer sends line_items[].price; take it from price_set.shop_money.amount.",
    apply: (p) => ({
      ...p,
      line_items: (p.line_items ?? []).map((l) => {
        const set = l.price_set as { shop_money?: { amount?: string } } | undefined;
        return l.price !== undefined || !set?.shop_money?.amount ? l : { ...l, price: set.shop_money.amount };
      }),
    }),
  },
};

export interface ExecutionResult {
  status: "created" | "duplicate" | "rejected" | "failed";
  erpOrder?: { id?: string; number?: string };
  reference: string;
  message?: string;
}

/**
 * Reviewed patches to the adopted order sync (exact-text replacements of the pinned source; see artifacts.ts).
 * Each says which provider requirement it addresses, so maintenance can find the patch for a refusal.
 */
export const ORDER_SYNC_PATCHES: Record<string, Patch & { addresses: { provider: string; contract: string; requiredField: string } }> = {
  [oneWorld.id]: oneWorld,
};

const ENTRY = [
  "export { toCanonicalOrder } from './src/mapping.js';",
  "export { createNetSuiteAdapter } from './src/adapters/netsuite.js';",
  "export { syncOrder } from './src/sync.js';",
].join("\n");

export interface OrderSyncModule {
  toCanonicalOrder: typeof toCanonicalOrder;
  createNetSuiteAdapter(o: { baseUrl: string; accessToken: string; subsidiaryId?: string }): unknown;
  syncOrder(adapter: unknown, order: unknown): Promise<unknown>;
}

export const orderSyncSpec = (patchIds: string[]) => ({
  pkg: "shopify-sync", entry: "mi-entry.js", entrySource: ENTRY,
  patches: patchIds.map((id) => ORDER_SYNC_PATCHES[id]!).filter(Boolean),
});

/** The code that runs: the pinned install itself, or a patched artifact built beside it (never modifying it). */
export async function orderSyncCode(patchIds: string[]): Promise<{ id: string; module: OrderSyncModule }> {
  if (!patchIds.length) return { id: `pinned:${UPSTREAM.commit.slice(0, 12)}`, module: { toCanonicalOrder, createNetSuiteAdapter, syncOrder } };
  const a = await materialize<OrderSyncModule>(orderSyncSpec(patchIds));
  return { id: a.id, module: a.module };
}

export async function execute(
  payload: Payload,
  settings: { defaultCustomer?: string; customerByEmail?: Record<string, string>; subsidiaryId?: string },
  netsuite: { baseUrl: string; accessToken: string },
  patchIds: string[] = [],
): Promise<ExecutionResult & { artifact: string }> {
  const code = await orderSyncCode(patchIds);
  const order = code.module.toCanonicalOrder(payload, {
    defaultCustomer: settings.defaultCustomer ?? "WEB",
    customerByEmail: settings.customerByEmail ?? {},
  });
  // The original adapter takes { baseUrl, accessToken } only; the subsidiary is passed only to patched code.
  const adapter = code.module.createNetSuiteAdapter({ ...netsuite, ...(patchIds.length && settings.subsidiaryId ? { subsidiaryId: settings.subsidiaryId } : {}) });
  return { ...((await code.module.syncOrder(adapter, order)) as ExecutionResult), artifact: code.id };
}

/** "Please enter value(s) for: Subsidiary" → "Subsidiary": a field the target now requires. */
export function requiredFieldOf(message: string | undefined): string | null {
  return /Please enter value\(s\) for: ([A-Za-z ]+)/.exec(message ?? "")?.[1]?.trim() ?? null;
}
