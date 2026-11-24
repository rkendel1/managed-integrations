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
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { UpstreamSyncResult } from 'shopify-sync/types';
import {
  applyPatchText as applyReviewedPatch,
  materializeArtifact,
  readPatchCatalog,
  ReviewedPatchSchema,
  type PinnedSource,
} from '@mi/managed';
import { ORIGINAL_PRECISION, upstreamDir } from './input-contract.ts';
import { ADOPTED } from './provenance.ts';

/* ------------------------------------------------------------------ reviewed patches */

/** A reviewed patch for this integration: the generic fields plus the input-contract violation it addresses. */
export const PatchDefinitionSchema = ReviewedPatchSchema.extend({
  /** The input-contract violation this patch addresses, and the precision the patched artifact preserves. */
  addresses: z.union([
    z.object({ path: z.string(), observed: z.enum(['precision']) }),
    // slice 7: a target (NetSuite) requirement the adopted code cannot meet
    z.object({ provider: z.string(), contract: z.string(), requiredField: z.string() }),
  ]),
  precision: z.record(z.string(), z.number().int().min(0).max(8)).default({}),
});
export type PatchDefinition = z.infer<typeof PatchDefinitionSchema>;

const patchesDir = () =>
  process.env.ADOPTED_PATCHES_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'patches');

/** The reviewed patch catalog (files in the repository). */
export function patchCatalog(): PatchDefinition[] {
  return readPatchCatalog(patchesDir(), PatchDefinitionSchema);
}

export const applyPatchText = (original: string, p: PatchDefinition): string =>
  applyReviewedPatch(original, p);

export function pinnedSource(): PinnedSource {
  return {
    label: 'adopted',
    repository: ADOPTED.repository,
    commit: ADOPTED.commit,
    dir: upstreamDir(),
    fileSha256: ADOPTED.fileSha256,
    support: ['package.json'],
  };
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
  createNetSuiteAdapter: (o: { baseUrl: string; accessToken: string; subsidiaryId?: string }) => unknown;
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
  const key = ordered.map((p) => p.id).join('+');
  let hit = cache.get(key);
  if (!hit) {
    hit = buildArtifact(ordered);
    cache.set(key, hit);
    hit.catch(() => cache.delete(key));
  }
  return hit;
}

async function buildArtifact(patches: PatchDefinition[]): Promise<ExecutorArtifact> {
  const m = materializeArtifact(pinnedSource(), patches);
  return {
    id: m.id,
    base: m.base,
    patches: m.patches,
    files: m.files,
    precision: Object.assign({ ...ORIGINAL_PRECISION }, ...patches.map((p) => p.precision)),
    modules: await importModules(m.root),
  };
}
