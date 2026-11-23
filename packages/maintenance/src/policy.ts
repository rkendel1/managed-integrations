/**
 * Repair workspace policy. The maintenance agent may only change the versioned implementation
 * and add regression tests. Everything else — acceptance tests, fixtures, contracts, engine,
 * reliability, schema, dependencies — is protected and owned by humans.
 */
import { posix } from 'node:path';

export const AGENT_EDITABLE_PREFIXES = [
  'packages/integration-shopify-netsuite/src/implementation/',
  'packages/integration-shopify-netsuite/test/regression/',
] as const;

/** Files that define "correct": hashed at validation time to prove they were not altered. */
export const PROTECTED_SUITE_PREFIXES = [
  'packages/integration-shopify-netsuite/test/acceptance/',
  'packages/test-fixtures/src/',
  'test/support/',
  'packages/contracts/src/',
  'packages/integration-shopify-netsuite/src/implementation-api.ts',
  'vitest.config.ts',
] as const;

/** Paths never readable by the agent (secrets, local env, VCS internals). */
const READ_DENY = [/(^|\/)\.env(\..*)?$/, /(^|\/)\.git(\/|$)/, /(^|\/)node_modules(\/|$)/, /\.pem$/, /\.key$/, /(^|\/)var\//, /(^|\/)\.maintenance\//];

export class PolicyViolation extends Error {}

/** Normalises a repo-relative path and rejects traversal / absolute paths. */
export function normalizeRepoPath(p: string): string {
  if (typeof p !== 'string' || !p.length || p.includes('\0')) throw new PolicyViolation('Invalid path');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw new PolicyViolation('Absolute paths are not permitted');
  const n = posix.normalize(p.replace(/\\/g, '/'));
  if (n.startsWith('../') || n === '..') throw new PolicyViolation('Path traversal is not permitted');
  return n;
}

export function isAgentEditable(p: string): boolean {
  const n = normalizeRepoPath(p);
  return AGENT_EDITABLE_PREFIXES.some((pre) => n.startsWith(pre)) && /\.(ts|md)$/.test(n);
}

export function isProtected(p: string): boolean {
  const n = normalizeRepoPath(p);
  return PROTECTED_SUITE_PREFIXES.some((pre) => n === pre || n.startsWith(pre));
}

export function assertReadable(p: string): string {
  const n = normalizeRepoPath(p);
  if (READ_DENY.some((re) => re.test(n))) throw new PolicyViolation(`Reading ${n} is not permitted`);
  return n;
}

export function assertEditable(p: string): string {
  const n = normalizeRepoPath(p);
  if (!isAgentEditable(n)) throw new PolicyViolation(`Editing ${n} is not permitted: only ${AGENT_EDITABLE_PREFIXES.join(', ')}`);
  return n;
}

/** Test targets the agent may run. Commands are fixed; the agent chooses only the target and profile. */
export const TEST_TARGETS = {
  acceptance: ['node', 'node_modules/vitest/vitest.mjs', 'run', 'packages/integration-shopify-netsuite/test/acceptance'],
  regression: ['node', 'node_modules/vitest/vitest.mjs', 'run', 'packages/integration-shopify-netsuite/test/regression', '--passWithNoTests'],
  unit: ['node', 'node_modules/vitest/vitest.mjs', 'run', 'packages/integration-shopify-netsuite/test/unit', '--passWithNoTests'],
  typecheck: ['node', 'node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
} as const;
export type TestTarget = keyof typeof TEST_TARGETS;

export const FIXTURE_PROFILES = ['baseline', 'drift'] as const;
export type FixtureProfile = (typeof FIXTURE_PROFILES)[number];
