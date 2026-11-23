/**
 * Immutable implementation artifacts. The versioned implementation (src/implementation/**) is
 * bundled with esbuild into one self-contained ESM file, content-addressed by sha256 and
 * registered as an IntegrationVersion. Workers load artifacts only after checksum verification.
 */
import { mkdir, readFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { integrationVersions, type Db } from '@mi/database';
import { sha256Hex } from '@mi/integration-shopify-netsuite';

export const IMPLEMENTATION_ENTRY = 'packages/integration-shopify-netsuite/src/implementation/index.ts';

export async function buildImplementationArtifact(treeDir: string, artifactDir: string, sourceCommit: string): Promise<{ path: string; sha256: string }> {
  await mkdir(artifactDir, { recursive: true });
  const tmp = join(resolve(artifactDir), `.build-${sourceCommit.slice(0, 12)}-${Date.now()}.mjs`);
  await build({
    entryPoints: [join(treeDir, IMPLEMENTATION_ENTRY)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile: tmp,
    // Resolve the tree's own workspace packages; third-party deps from its node_modules.
    alias: { '@mi/contracts': join(treeDir, 'packages/contracts/src/index.ts') },
    nodePaths: [join(treeDir, 'node_modules/.pnpm/node_modules')],
    banner: { js: `// integration implementation artifact — source commit ${sourceCommit}` },
    legalComments: 'none',
    logLevel: 'silent',
  });
  const sha256 = sha256Hex(await readFile(tmp));
  const finalPath = join(resolve(artifactDir), `impl-${sourceCommit.slice(0, 12)}-${sha256.slice(0, 12)}.mjs`);
  await rename(tmp, finalPath);
  return { path: finalPath, sha256 };
}

export function versionIdFor(sourceCommit: string): string {
  return `impl-${sourceCommit.slice(0, 12)}`;
}

/** Registers an IntegrationVersion. Idempotent: an existing id must match the checksum exactly. */
export async function registerVersion(
  db: Db,
  p: { sourceCommit: string; artifactPath: string; artifactSha256: string; releaseState: string; parentVersionId?: string | null },
): Promise<string> {
  const id = versionIdFor(p.sourceCommit);
  const inserted = await db
    .insert(integrationVersions)
    .values({ id, sourceCommit: p.sourceCommit, artifactPath: p.artifactPath, artifactSha256: p.artifactSha256, releaseState: p.releaseState, parentVersionId: p.parentVersionId ?? null })
    .onConflictDoNothing()
    .returning();
  if (!inserted.length) {
    const existing = (await db.select().from(integrationVersions)).find((v) => v.id === id);
    if (existing && existing.artifactSha256 !== p.artifactSha256) {
      // Rebuilds of the same commit must be byte-identical; anything else is refused.
      throw new Error(`Version ${id} already registered with a different artifact checksum`);
    }
  }
  return id;
}

/**
 * Builds and registers the implementation at `commit` (e.g. the initial deployment) in a
 * throwaway worktree with dependencies installed offline.
 */
export async function buildVersionFromCommit(
  db: Db,
  p: { repoDir: string; workDir: string; artifactDir: string; commit: string; releaseState: string; parentVersionId?: string | null },
): Promise<string> {
  const { git } = await import('./exec.ts');
  const { installOffline } = await import('./sandbox.ts');
  const sha = (await git(p.repoDir, ['rev-parse', `${p.commit}^{commit}`])).trim();
  const tree = join(resolve(p.workDir), `build-${sha.slice(0, 12)}-${Date.now()}`);
  await mkdir(resolve(p.workDir), { recursive: true });
  await git(p.repoDir, ['worktree', 'add', '-q', '--detach', tree, sha]);
  try {
    const inst = await installOffline(tree);
    if (inst.code !== 0) throw new Error(`offline install failed: ${inst.stderr.slice(-400)}`);
    const art = await buildImplementationArtifact(tree, p.artifactDir, sha);
    return await registerVersion(db, { sourceCommit: sha, artifactPath: art.path, artifactSha256: art.sha256, releaseState: p.releaseState, parentVersionId: p.parentVersionId ?? null });
  } finally {
    await git(p.repoDir, ['worktree', 'remove', '--force', tree]).catch(() => undefined);
  }
}
