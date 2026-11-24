/**
 * The application's own database, hosted (deployment binding for src/db/prisma.ts). Each Prisma model the
 * application uses is a delegate over app_records scoped to one managed integration; the unique key of each
 * model is the field the application addresses it by. Only the calls the application makes are implemented —
 * anything else throws, so an upstream change that needs more is caught by validation, not silently ignored.
 */
import { and, eq, sql } from 'drizzle-orm';
import { appRecords, type Db } from '@mi/database';

export const MODELS = {
  stripeEvent: { model: 'StripeEvent', key: 'stripeEventId' },
  subscription: { model: 'Subscription', key: 'stripeSubscriptionId' },
  invoice: { model: 'Invoice', key: 'stripeInvoiceId' },
  paymentIntent: { model: 'PaymentIntent', key: 'stripePaymentIntentId' },
} as const;
export type ModelName = keyof typeof MODELS;

type Rec = Record<string, unknown>;
const dates = (r: Rec) =>
  JSON.parse(JSON.stringify(r, (_k, v) => (v instanceof Date ? v.toISOString() : v))) as Rec;
const revive = (r: Rec): Rec =>
  Object.fromEntries(
    Object.entries(r).map(([k, v]) => [
      k,
      typeof v === 'string' && /At$|End$/.test(k) && !Number.isNaN(Date.parse(v)) ? new Date(v) : v,
    ]),
  );

interface Backend {
  get(model: string, key: string): Promise<Rec | null>;
  put(model: string, key: string, data: Rec, mode: 'insert' | 'upsert'): Promise<number>;
  all(model: string): Promise<Rec[]>;
}

function delegates(b: Backend) {
  const delegate = (name: ModelName) => {
    const { model, key } = MODELS[name];
    const keyOf = (where: Rec) => {
      const v = where[key];
      if (typeof v !== 'string') throw new Error(`${model}: only lookups by ${key} are supported`);
      return v;
    };
    const now = () => new Date();
    return {
      async findUnique({ where }: { where: Rec }) {
        return b.get(model, keyOf(where));
      },
      async upsert({ where, create, update }: { where: Rec; create: Rec; update: Rec }) {
        const k = keyOf(where);
        const existing = await b.get(model, k);
        const data = existing
          ? { ...existing, ...update, updatedAt: now() }
          : { id: crypto.randomUUID(), ...create, createdAt: now(), updatedAt: now() };
        await b.put(model, k, data, 'upsert');
        return data;
      },
      async createMany({ data, skipDuplicates }: { data: Rec[]; skipDuplicates?: boolean }) {
        let count = 0;
        for (const d of data) {
          const row = { id: crypto.randomUUID(), status: 'received', attemptCount: 0, receivedAt: now(), ...d };
          const n = await b.put(model, keyOf(d), row, 'insert');
          if (!n && !skipDuplicates) throw new Error(`${model}: unique constraint failed on ${key}`);
          count += n;
        }
        return { count };
      },
      async update({ where, data }: { where: Rec; data: Rec }) {
        const k = keyOf(where);
        const existing = await b.get(model, k);
        if (!existing) throw new Error(`${model}: record to update not found`);
        const next: Rec = { ...existing };
        for (const [f, v] of Object.entries(data)) {
          if (v && typeof v === 'object' && !(v instanceof Date) && 'increment' in (v as Rec))
            next[f] = Number(next[f] ?? 0) + Number((v as { increment: number }).increment);
          else next[f] = v;
        }
        if ('updatedAt' in existing) next['updatedAt'] = now();
        await b.put(model, k, next, 'upsert');
        return next;
      },
    };
  };
  return {
    prisma: {
      stripeEvent: delegate('stripeEvent'),
      subscription: delegate('subscription'),
      invoice: delegate('invoice'),
      paymentIntent: delegate('paymentIntent'),
    },
    get: (name: ModelName, key: string) => b.get(MODELS[name].model, key),
    all: (name: ModelName) => b.all(MODELS[name].model),
  };
}

/** One store per integration, used by the binding and by our verification and recovery. */
export function appStore(db: Db, integrationId: string) {
  const scope = (model: string) => and(eq(appRecords.integrationId, integrationId), eq(appRecords.model, model));
  return {
    ...delegates({
      async get(model, key) {
        const [row] = await db.select().from(appRecords).where(and(scope(model), eq(appRecords.key, key)));
        return row ? revive(row.data as Rec) : null;
      },
      async put(model, key, data, mode) {
        const q = db.insert(appRecords).values({ integrationId, model, key, data: dates(data) });
        if (mode === 'insert') return (await q.onConflictDoNothing().returning()).length;
        await q.onConflictDoUpdate({
          target: [appRecords.integrationId, appRecords.model, appRecords.key],
          set: { data: dates(data), updatedAt: new Date() },
        });
        return 1;
      },
      async all(model) {
        return (await db.select().from(appRecords).where(scope(model))).map((r) => revive(r.data as Rec));
      },
    }),
    async count() {
      const [r] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(appRecords)
        .where(eq(appRecords.integrationId, integrationId));
      return r?.n ?? 0;
    },
  };
}
export type AppStore = ReturnType<typeof appStore>;

/** The same delegates over memory: validation replays run the application without touching its data. */
export function memoryStore() {
  const m = new Map<string, Rec>();
  return delegates({
    get: async (model, key) => (m.has(`${model}:${key}`) ? revive(dates(m.get(`${model}:${key}`)!)) : null),
    async put(model, key, data, mode) {
      if (mode === 'insert' && m.has(`${model}:${key}`)) return 0;
      m.set(`${model}:${key}`, dates(data));
      return 1;
    },
    all: async (model) => [...m.entries()].filter(([k]) => k.startsWith(`${model}:`)).map(([, v]) => revive(v)),
  });
}
