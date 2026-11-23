/**
 * The adopted code that actually runs for an integration (slice 5): "which exact code is running?".
 *
 * - With no active patch, the artifact is the installed upstream package, unmodified and hash-pinned to
 *   the adopted commit (ADOPTED.fileSha256).
 * - With active patches, the artifact is a content-addressed copy of that package with each reviewed
 *   patch applied (exact text replacement in one file, base and result sha256 checked), materialized under
 *   ARTIFACT_DIR/adopted/<id>. The installed upstream package is never modified, so the original stays
 *   identifiable and reproducible, and rolling a patch back simply selects the original artifact again.
 *
 * Patches are reviewable files in `packages/adopted-order-sync/patches/` (authored and reviewed like code;
 * never generated at runtime). The runtime only applies them, deterministically.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { UpstreamSyncResult } from 'shopify-sync/types';
import { ORIGINAL_PRECISION, upstreamDir } from './input-contract.ts';
import { ADOPTED } from './provenance.ts';

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/* ------------------------------------------------------------------ reviewed patches */

export const PatchDefinitionSchema = z.object({
  id: z.string().regex(/^p\d{4}-[a-z0-9-]+$/),
  title: z.string(),
  /** The adopted artifact it was written against. */
  artifact: z.object({ repository: z.string(), commit: z.string().length(40) }),
  file: z.string(),
  /** sha256 of the file before (must equal the pinned upstream file) and after the patch. */
  baseSha256: z.string().length(64),
  resultSha256: z.string().length(64),
  /** Exact text replaced (must occur exactly once) and its replacement. */
  find: z.string().min(1),
  replace: z.string(),
  /** The input-contract violation this patch addresses, and the precision the patched artifact preserves. */
  addresses: z.object({ path: z.string(), observed: z.enum(['precision']) }),
  precision: z.record(z.string(), z.number().int().min(0).max(8)).default({}),
  reason: z.string(),
  originalBehavior: z.string(),
  replacementBehavior: z.string(),
  providerEvidence: z.array(z.string()),
  assumptions: z.array(z.string()),
  validation: z.array(z.string()),
  rollback: z.string(),
});
export type PatchDefinition = z.infer<typeof PatchDefinitionSchema>;

const patchesDir = () =>
  process.env.ADOPTED_PATCHES_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'patches');

/** The reviewed patch catalog (files in the repository). */
export function patchCatalog(): PatchDefinition[] {
  const dir = patchesDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => PatchDefinitionSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
}

/** Applies one patch to a file's text, checking base hash, single occurrence and result hash. */
export function applyPatchText(original: string, p: PatchDefinition): string {
  if (sha256(original) !== p.baseSha256) throw new Error(`${p.id}: base file hash does not match ${p.file}`);
  const first = original.indexOf(p.find);
  if (first < 0 || original.indexOf(p.find, first + 1) >= 0)
    throw new Error(`${p.id}: the replaced text must occur exactly once in ${p.file}`);
  const result = original.slice(0, first) + p.replace + original.slice(first + p.find.length);
  if (sha256(result) !== p.resultSha256)
    throw new Error(`${p.id}: result hash does not match the reviewed patch`);
  return result;
}

/* ------------------------------------------------------------------ artifacts */

export interface UpstreamModules {
  toCanonicalOrder: (
    order: unknown,
    opts: { customerByEmail?: Record<string, string>; defaultCustomer?: string },
  ) => {
    reference: string;
    externalId: string;
    customerCode: string;
    lines: { sku: string; qty: number; unitPrice: number }[];
    [k: string]: unknown;
  };
  syncOrder: (adapter: unknown, order: unknown) => Promise<UpstreamSyncResult>;
  createNetSuiteAdapter: (o: { baseUrl: string; accessToken: string }) => unknown;
}

export interface ExecutorArtifact {
  /** adopted:<commit12> for the original; adopted:<commit12>+<patch ids> for a patched artifact. */
  id: string;
  base: { repository: string; commit: string };
  patches: { id: string; file: string; resultSha256: string }[];
  /** sha256 of every executed file in this artifact. */
  files: Record<string, string>;
  /** Field precision this artifact preserves (input contract). */
  precision: Record<string, number>;
  modules: UpstreamModules;
}

const cache = new Map<string, Promise<ExecutorArtifact>>();

async function importModules(root: string): Promise<UpstreamModules> {
  const url = (f: string) => pathToFileURL(join(root, f)).href;
  const [mapping, sync, ns] = await Promise.all([
    import(url('src/mapping.js')),
    import(url('src/sync.js')),
    import(url('src/adapters/netsuite.js')),
  ]);
  return {
    toCanonicalOrder: mapping.toCanonicalOrder,
    syncOrder: sync.syncOrder,
    createNetSuiteAdapter: ns.createNetSuiteAdapter,
  };
}

/** The artifact for a set of active patches (none → the original upstream package). Cached per id. */
export function loadArtifact(patches: readonly PatchDefinition[] = []): Promise<ExecutorArtifact> {
  const ordered = [...patches].sort((a, b) => a.id.localeCompare(b.id));
  const id = `adopted:${ADOPTED.commit.slice(0, 12)}${ordered.length ? `+${ordered.map((p) => p.id.slice(0, 5)).join('+')}` : ''}`;
  let hit = cache.get(id);
  if (!hit) {
    hit = buildArtifact(id, ordered);
    cache.set(id, hit);
    hit.catch(() => cache.delete(id));
  }
  return hit;
}

async function buildArtifact(id: string, patches: PatchDefinition[]): Promise<ExecutorArtifact> {
  const src = upstreamDir();
  const files: Record<string, string> = {};
  for (const f of Object.keys(ADOPTED.fileSha256)) files[f] = sha256(readFileSync(join(src, f)));
  const base = { repository: ADOPTED.repository, commit: ADOPTED.commit };
  if (!patches.length) {
    return {
      id,
      base,
      patches: [],
      files,
      precision: { ...ORIGINAL_PRECISION },
      modules: await importModules(src),
    };
  }
  for (const p of patches) {
    if (p.artifact.commit !== ADOPTED.commit) throw new Error(`${p.id} was written for another commit`);
  }
  // Content-addressed directory: same patches → same bytes → same directory.
  const key = sha256(JSON.stringify(patches.map((p) => [p.id, p.resultSha256])) + ADOPTED.commit).slice(
    0,
    16,
  );
  const root = resolve(
    process.env.ARTIFACT_DIR ?? './var/artifacts',
    'adopted',
    `${ADOPTED.commit.slice(0, 12)}-${key}`,
  );
  const texts = new Map<string, string>();
  for (const p of patches) {
    const before = texts.get(p.file) ?? readFileSync(join(src, p.file), 'utf8');
    texts.set(p.file, applyPatchText(before, p));
  }
  if (!existsSync(join(root, '.complete'))) {
    const tmp = `${root}.tmp-${process.pid}-${Date.now()}`;
    for (const rel of [
      'package.json',
      ...Object.keys(ADOPTED.fileSha256).filter((f) => f.startsWith('src/')),
    ]) {
      mkdirSync(dirname(join(tmp, rel)), { recursive: true });
      writeFileSync(join(tmp, rel), texts.get(rel) ?? readFileSync(join(src, rel)));
    }
    writeFileSync(join(tmp, '.complete'), id);
    mkdirSync(dirname(root), { recursive: true });
    try {
      renameSync(tmp, root);
    } catch {
      // another process materialized the same content first
    }
  }
  for (const [f, text] of texts) {
    const onDisk = sha256(readFileSync(join(root, f)));
    if (onDisk !== sha256(text)) throw new Error(`Materialized ${f} does not match the patched text`);
    files[f] = onDisk;
  }
  const precision = Object.assign({ ...ORIGINAL_PRECISION }, ...patches.map((p) => p.precision));
  return {
    id,
    base,
    patches: patches.map((p) => ({ id: p.id, file: p.file, resultSha256: p.resultSha256 })),
    files,
    precision,
    modules: await importModules(root),
  };
}
