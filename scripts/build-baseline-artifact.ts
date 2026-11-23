/**
 * Builds the implementation artifact for the source tree this runs in (used at image build time).
 * Writes <outDir>/<file>.mjs plus manifest.json { sourceCommit, file, sha256 }.
 */
import { writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { buildImplementationArtifact } from '@mi/maintenance';

const commit = process.env.SOURCE_COMMIT ?? '';
if (!/^[0-9a-f]{40}$/.test(commit)) {
  console.error('SOURCE_COMMIT must be the full 40-char git commit of this source tree');
  process.exit(1);
}
const outDir = resolve(process.argv[2] ?? 'baseline-artifact');
const art = await buildImplementationArtifact(resolve('.'), outDir, commit);
await writeFile(resolve(outDir, 'manifest.json'), JSON.stringify({ sourceCommit: commit, file: basename(art.path), sha256: art.sha256 }, null, 2));
console.log(`built ${art.path} sha256=${art.sha256}`);
