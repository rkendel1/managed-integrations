/**
 * Runs one Stripe event with the adopted ledgerly code (jakethehoffer/ledgerly @ 3101182, MIT): its Stripe
 * expansion, its mapping to balanced journal entries, and its QuickBooks dispatcher (idempotent by its own
 * `requestid`). Our code supplies the Stripe client, a live QuickBooks grant and the account map, and checks
 * QuickBooks first so an entry the customer's earlier deployment already booked is not booked again.
 */
import Stripe from "stripe";
import { materialize, type Patch } from "./artifacts.ts";
import { QBO, type QboGrant, query } from "./quickbooks.ts";

export const UPSTREAM = { repository: "github.com/jakethehoffer/ledgerly", commit: "3101182eadc9e3a94b6d9c2f5bb2d0dd299e4090", license: "MIT" } as const;

const ENTRY = [
  "export { mapEvent } from './src/engine.js';",
  "export { expandEvent } from './src/server/expand.js';",
  "export { toQbo } from './src/exporters/qbo.js';",
  "export { qboDispatcher } from './src/server/dispatchers/qbo.js';",
  "export { dispatchIdentity } from './src/server/dispatchers/identity.js';",
  "export { ACCOUNTS } from './src/accounts.js';",
  "export { UnhandledEventError } from './src/errors.js';",
].join("\n");

/** Reviewed patches to the adopted code (exact-text replacements; see artifacts.ts). */
export const PATCHES: Record<string, Patch> = {
  "qbo-minorversion-75": {
    id: "qbo-minorversion-75",
    file: "src/server/dispatchers/qbo.ts",
    find: "const QBO_MINOR_VERSION = '70';",
    replace: "const QBO_MINOR_VERSION = '75';",
    reason: "Intuit ignores minor versions below 75 since 2025-08-01 and serves 75; declare the version actually served.",
  },
};

export interface Ledgerly {
  mapEvent(e: unknown): { entries: ReadonlyArray<any>; schedule: unknown };
  expandEvent(s: Stripe, e: unknown): Promise<unknown>;
  toQbo(entry: unknown, map: unknown): { DocNumber?: string; PrivateNote: string; Line: { Amount: number; JournalEntryLineDetail: { PostingType: string } }[] };
  qboDispatcher(c: { accessToken: string; realmId: string; accountMap: unknown; apiBase?: string; fetch?: typeof fetch; log?: unknown }): (saved: any) => Promise<void>;
  dispatchIdentity(saved: any): string;
  ACCOUNTS: Record<string, { name: string }>;
  UnhandledEventError: new (...a: any[]) => Error;
}

export const artifactFor = (patchIds: string[]) =>
  materialize<Ledgerly>({ pkg: "ledgerly", entry: "mi-entry.ts", entrySource: ENTRY, patches: patchIds.map((id) => PATCHES[id]!).filter(Boolean) });

/** The QuickBooks minor version the artifact's dispatcher declares (read from the code that runs). */
export async function declaredMinorVersion(patchIds: string[]) {
  const a = await artifactFor(patchIds);
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(`${a.dir}/src-tree/src/server/dispatchers/qbo.ts`, "utf8");
  const line = src.split("\n").findIndex((l) => /const QBO_MINOR_VERSION = '\d+'/.test(l));
  return { version: Number(/'(\d+)'/.exec(src.split("\n")[line] ?? "")?.[1] ?? NaN), at: `src/server/dispatchers/qbo.ts:${line + 1}`, artifact: a.id };
}

export function stripeClient(apiKey: string) {
  const base = new URL(process.env.STRIPE_API_BASE ?? "http://127.0.0.1:5030");
  return new Stripe(apiKey, {
    apiVersion: "2024-06-20",
    host: base.hostname,
    port: Number(base.port || (base.protocol === "https:" ? 443 : 80)),
    protocol: base.protocol.replace(":", "") as "http" | "https",
    maxNetworkRetries: 1,
  });
}

const silent = { info() {}, warn() {}, error() {} };

export interface LedgerlyResult {
  status: "booked" | "already_booked" | "not_bookable" | "rejected" | "failed" | "unauthorized";
  entries: number;
  message?: string;
  minorRequested?: string | null;
  artifact: string;
}

/** Captures the QuickBooks requests the dispatcher makes (and sends them, unless `dryRun`). */
function capturing(dryRun: boolean, seen: { url: string; body: string }[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), body: String(init?.body ?? "") });
    if (dryRun) return new Response(JSON.stringify({ JournalEntry: { Id: "dry-run" } }), { status: 200, headers: { "content-type": "application/json" } });
    return fetch(url, init);
  }) as typeof fetch;
}

export async function executeEvent(
  event: { id: string; type: string },
  stripeKey: string,
  qbo: QboGrant,
  accountMap: Record<string, { qboId: string; name: string }>,
  patchIds: string[],
  options: { dryRun?: boolean } = {},
): Promise<LedgerlyResult & { requests: { url: string; body: string }[] }> {
  const a = await artifactFor(patchIds);
  const L = a.module;
  const requests: { url: string; body: string }[] = [];
  let mapped;
  try {
    mapped = L.mapEvent(await L.expandEvent(stripeClient(stripeKey), event));
  } catch (err) {
    if (err instanceof L.UnhandledEventError) return { status: "not_bookable", entries: 0, message: `${event.type} is not an accounting event`, artifact: a.id, requests };
    return { status: "failed", entries: 0, message: (err as Error).message, artifact: a.id, requests };
  }
  if (!mapped.entries.length) return { status: "not_bookable", entries: 0, artifact: a.id, requests };

  // Already in QuickBooks (an earlier deployment of the same code, or a retry): skip those entries.
  const docs = [...new Set(mapped.entries.map((e: any) => L.toQbo(e, accountMap).DocNumber).filter(Boolean))] as string[];
  const existing = options.dryRun
    ? { status: 200, body: {} as any }
    : await query<{ QueryResponse?: { JournalEntry?: { DocNumber: string; PrivateNote: string }[] } }>(qbo, `select * from JournalEntry where DocNumber in (${docs.map((d) => `'${d}'`).join(", ")})`);
  if (existing.status === 401) return { status: "unauthorized", entries: 0, artifact: a.id, requests };
  const booked = new Set((existing.body.QueryResponse?.JournalEntry ?? []).map((j) => `${j.DocNumber}|${j.PrivateNote}`));
  const dispatch = L.qboDispatcher({ accessToken: qbo.accessToken, realmId: qbo.realmId, accountMap, apiBase: QBO.apiBase, fetch: capturing(Boolean(options.dryRun), requests), log: silent });
  let sent = 0;
  for (const [i, entry] of mapped.entries.entries()) {
    const q = L.toQbo(entry, accountMap);
    if (booked.has(`${q.DocNumber}|${q.PrivateNote}`)) continue;
    try {
      await dispatch({ id: i, eventId: event.id, subscriptionId: "", entry, status: "pending", attempts: 0, lastAttemptedAt: null, nextAttemptAt: null, lastError: null });
      sent++;
    } catch (err) {
      const m = (err as Error).message;
      const minor = requests.at(-1) ? new URL(requests.at(-1)!.url).searchParams.get("minorversion") : null;
      if (/returned 401/.test(m)) return { status: "unauthorized", entries: sent, message: m, artifact: a.id, requests, minorRequested: minor };
      if (/returned (4\d\d)/.test(m) && !/returned 429/.test(m)) return { status: "rejected", entries: sent, message: m, artifact: a.id, requests, minorRequested: minor };
      return { status: "failed", entries: sent, message: m, artifact: a.id, requests, minorRequested: minor };
    }
  }
  const minorRequested = requests.length ? new URL(requests.at(-1)!.url).searchParams.get("minorversion") : null;
  return { status: sent ? "booked" : "already_booked", entries: sent, artifact: a.id, requests, minorRequested };
}

/** How many journal entries the adopted code makes for an event (expansion reads Stripe; nothing is sent). */
export async function entriesFor(event: { id: string; type: string }, stripeKey: string, patchIds: string[] = []): Promise<number> {
  const L = (await artifactFor(patchIds)).module;
  try {
    return L.mapEvent(await L.expandEvent(stripeClient(stripeKey), event)).entries.length;
  } catch (err) {
    if (err instanceof L.UnhandledEventError) return 0;
    throw err;
  }
}
