/**
 * Which code of the QuickBooks-dependent application runs: the generic artifact mechanism with no bindings
 * (the adopted tool takes its QuickBooks client as an argument), the pinned dependency set linked into each
 * artifact, one instance per customer (the application caches customers and items in module state), and
 * reviewed DEPENDENCY CHANGES (changes/*.json) — e.g. upstream's next release moving node-quickbooks.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPatchCatalog, ReviewedDependencyChangeSchema, type PinnedSource, type ReviewedDependencyChange } from '@mi/managed';
import { QBO_TOOLS_APP } from './provenance.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const packageDir = join(here, '..');
export const upstreamDir = () => join(packageDir, 'upstream', 'quickbooks-mcp');
const changesDir = () => process.env.QBO_TOOLS_CHANGES_DIR ?? join(packageDir, 'changes');
export const dependencyChangeCatalog = (): ReviewedDependencyChange[] =>
  readPatchCatalog(changesDir(), ReviewedDependencyChangeSchema);

/** Installed under aliases (app-*): name the application imports → installed directory. */
const ALIASES: Record<string, string> = {
  'node-quickbooks': 'app-node-quickbooks',
  'intuit-oauth': 'app-intuit-oauth',
  '@aws-sdk/client-secrets-manager': 'app-aws-client-secrets-manager',
  '@aws-sdk/client-ssm': 'app-aws-client-ssm',
  tmp: 'app-tmp',
};

export function pinnedSource(): PinnedSource {
  const dir = (alias: string) => join(packageDir, 'node_modules', alias);
  return {
    label: 'quickbooks-mcp',
    repository: QBO_TOOLS_APP.repository,
    commit: QBO_TOOLS_APP.commit,
    dir: upstreamDir(),
    fileSha256: QBO_TOOLS_APP.fileSha256,
    support: ['package.json'],
    artifactDir: join(packageDir, '.artifacts'),
    dependencies: Object.fromEntries(
      Object.entries(QBO_TOOLS_APP.dependencies).map(([name, version]) => [name, { version, dir: dir(ALIASES[name]!) }]),
    ),
    installed: { 'node-quickbooks': { '2.0.48': dir('app-node-quickbooks'), '2.0.50': dir('app-node-quickbooks-2.0.50') } },
  };
}
