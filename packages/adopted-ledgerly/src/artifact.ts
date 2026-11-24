/**
 * Which ledgerly code runs (generic artifact mechanism from @mi/managed, integration-specific modules).
 * The installed package is never modified; reviewed patches (patches/*.json) apply to a content-addressed
 * copy. Rolling a patch back selects the original artifact again.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type Stripe from 'stripe';
import { z } from 'zod';
import { materializeArtifact, readPatchCatalog, ReviewedPatchSchema, type PinnedSource } from '@mi/managed';
import { LEDGERLY } from './provenance.ts';

export const upstreamDir = () =>
  join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'ledgerly');

/** A reviewed patch for ledgerly: generic fields plus the provider dependency it addresses. */
export const LedgerlyPatchSchema = ReviewedPatchSchema.extend({
  addresses: z.object({ provider: z.string(), dependency: z.string(), change: z.string() }),
});
export type LedgerlyPatch = z.infer<typeof LedgerlyPatchSchema>;

const patchesDir = () =>
  process.env.LEDGERLY_PATCHES_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'patches');
export const patchCatalog = (): LedgerlyPatch[] => readPatchCatalog(patchesDir(), LedgerlyPatchSchema);

export function pinnedSource(): PinnedSource {
  return {
    label: 'ledgerly',
    repository: LEDGERLY.repository,
    commit: LEDGERLY.commit,
    dir: upstreamDir(),
    fileSha256: LEDGERLY.fileSha256,
    support: ['package.json'],
  };
}

/* ------------------------------------------------------------------ upstream module shapes (the parts we call) */

export interface LedgerlyLine {
  accountCode: string;
  side: 'debit' | 'credit';
  amount: number;
  memo?: string;
}
export interface LedgerlyEntry {
  date: string;
  currency: string;
  memo: string;
  sourceEventId: string;
  sourceEventType: string;
  sourceObjectId?: string;
  lines: LedgerlyLine[];
}
export interface LedgerlyMapResult {
  entries: LedgerlyEntry[];
  schedule: { entries: LedgerlyEntry[] } | null;
}
export type QboAccountMap = Record<string, { qboId: string; name: string }>;
export interface QboJournalEntryPayload {
  TxnDate: string;
  DocNumber?: string;
  PrivateNote: string;
  CurrencyRef: { value: string };
  Line: {
    Amount: number;
    Description?: string;
    JournalEntryLineDetail: { PostingType: 'Debit' | 'Credit'; AccountRef: { value: string; name: string } };
  }[];
}
export interface LedgerlyModules {
  mapEvent(event: unknown): LedgerlyMapResult;
  expandEvent(stripe: Stripe, event: unknown): Promise<unknown>;
  toQbo(entry: LedgerlyEntry, accountMap: QboAccountMap): QboJournalEntryPayload;
  qboDispatcher(config: {
    accessToken: string;
    realmId: string;
    accountMap: QboAccountMap;
    apiBase?: string;
    fetch?: typeof globalThis.fetch;
    log?: {
      info(...a: unknown[]): void;
      warn(...a: unknown[]): void;
      error(...a: unknown[]): void;
      debug?(...a: unknown[]): void;
    };
  }): (saved: { id: number | string; entry: LedgerlyEntry; subscriptionId?: string | null }) => Promise<void>;
  checkBalance(entry: LedgerlyEntry): { debitTotal: number; creditTotal: number; balanced: boolean };
  ACCOUNTS: Record<string, { code: string; name: string }>;
  MissingExpansionError: new (...a: never[]) => Error & { field: string };
  UnhandledEventError: new (...a: never[]) => Error & { eventType: string };
}

export interface LedgerlyArtifact {
  /** ledgerly:<commit12> for the original; ledgerly:<commit12>+<patch ids> when patched. */
  id: string;
  base: { repository: string; commit: string };
  patches: { id: string; file: string; resultSha256: string }[];
  files: Record<string, string>;
  modules: LedgerlyModules;
}

const cache = new Map<string, Promise<LedgerlyArtifact>>();

async function importModules(root: string): Promise<LedgerlyModules> {
  const url = (f: string) => pathToFileURL(join(root, f)).href;
  const [engine, expand, qbo, dispatcher, journal, accounts, errors] = await Promise.all([
    import(url('src/engine.ts')),
    import(url('src/server/expand.ts')),
    import(url('src/exporters/qbo.ts')),
    import(url('src/server/dispatchers/qbo.ts')),
    import(url('src/journal.ts')),
    import(url('src/accounts.ts')),
    import(url('src/errors.ts')),
  ]);
  return {
    mapEvent: engine.mapEvent,
    expandEvent: expand.expandEvent,
    toQbo: qbo.toQbo,
    qboDispatcher: dispatcher.qboDispatcher,
    checkBalance: journal.checkBalance,
    ACCOUNTS: accounts.ACCOUNTS,
    MissingExpansionError: errors.MissingExpansionError,
    UnhandledEventError: errors.UnhandledEventError,
  };
}

export function loadLedgerly(patches: readonly LedgerlyPatch[] = []): Promise<LedgerlyArtifact> {
  const ordered = [...patches].sort((a, b) => a.id.localeCompare(b.id));
  const key = ordered.map((p) => p.id).join('+');
  let hit = cache.get(key);
  if (!hit) {
    hit = (async () => {
      const m = materializeArtifact(pinnedSource(), ordered);
      return {
        id: m.id,
        base: m.base,
        patches: m.patches,
        files: m.files,
        modules: await importModules(m.root),
      };
    })();
    cache.set(key, hit);
    hit.catch(() => cache.delete(key));
  }
  return hit;
}
