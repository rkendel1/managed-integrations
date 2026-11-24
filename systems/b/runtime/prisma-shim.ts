/**
 * Stands in for the adopted application's `prisma` client (src/db/prisma.ts) when the application runs under
 * management: the same calls the application makes (`<model>.upsert / findUnique / createMany / update`),
 * recorded per run into an in-memory write set that the runtime commits to the application's own records in
 * FeltDB (one transaction per event) — or, for a validation replay, only compares. Bundled into the artifact
 * in place of the application's module; the application's code is not changed by it.
 */
type Row = Record<string, unknown>;
export interface AppStore {
  read(model: string, key: string): Row | null;
  write(model: string, key: string, row: Row): void;
}
// The host binds a store per run with AsyncLocalStorage (kept on globalThis so the bundled copy of this module
// and the host share it); concurrent runs each see their own.
const slot = Symbol.for("mi.appStore");
const store = (): AppStore => {
  const als = (globalThis as Record<symbol, { getStore(): AppStore | undefined } | undefined>)[slot];
  const s = als?.getStore();
  if (!s) throw new Error("application store is not bound for this run");
  return s;
};

const plain = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v);
const keyOf = (where: Row) => {
  const [field, value] = Object.entries(where)[0] ?? [];
  if (!field) throw new Error("unique where required");
  return { field, value: String(value) };
};

function model(name: string) {
  return {
    async upsert(args: { where: Row; create: Row; update: Row }) {
      const k = keyOf(args.where);
      const existing = store().read(name, k.value);
      const row = existing ? { ...existing, ...(plain(args.update) as Row) } : { [k.field]: k.value, ...(plain(args.create) as Row) };
      store().write(name, k.value, row);
      return row;
    },
    async findUnique(args: { where: Row }) {
      return store().read(name, keyOf(args.where).value);
    },
    async createMany(args: { data: Row[]; skipDuplicates?: boolean }) {
      let count = 0;
      for (const d of args.data) {
        const [field, value] = Object.entries(d)[0]!;
        if (store().read(name, String(value)) && args.skipDuplicates) continue;
        store().write(name, String(value), { [field]: value, ...(plain(d) as Row) });
        count++;
      }
      return { count };
    },
    async update(args: { where: Row; data: Row }) {
      const k = keyOf(args.where);
      const row = { ...(store().read(name, k.value) ?? {}), ...(plain(args.data) as Row) };
      store().write(name, k.value, row);
      return row;
    },
  };
}

export const prisma = {
  subscription: model("Subscription"),
  invoice: model("Invoice"),
  paymentIntent: model("PaymentIntent"),
  stripeEvent: model("StripeEvent"),
};
