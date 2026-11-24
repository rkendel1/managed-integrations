/**
 * Executes one Shopify order with the adopted upstream code (Milo-ai-HQ/shopify-erp-order-sync @ d01b51d,
 * MIT): its mapping (`toCanonicalOrder`), its NetSuite adapter and its `syncOrder`. Our code decides only
 * what the upstream code is given: the customer's settings, a NetSuite token, and — when a correction is
 * active — the payload as the upstream code expects it.
 */
import { toCanonicalOrder } from "shopify-sync/src/mapping.js";
import { createNetSuiteAdapter } from "shopify-sync/src/adapters/netsuite.js";
import { syncOrder } from "shopify-sync/src/sync.js";

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

export async function execute(
  payload: Payload,
  settings: { defaultCustomer?: string; customerByEmail?: Record<string, string> },
  netsuite: { baseUrl: string; accessToken: string },
): Promise<ExecutionResult> {
  const order = toCanonicalOrder(payload, {
    defaultCustomer: settings.defaultCustomer ?? "WEB",
    customerByEmail: settings.customerByEmail ?? {},
  });
  const adapter = createNetSuiteAdapter(netsuite);
  return (await syncOrder(adapter, order)) as ExecutionResult;
}
