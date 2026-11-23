import { describe, expect, it } from 'vitest';
import { assertEditable, assertReadable, isAgentEditable, normalizeRepoPath, PolicyViolation } from '../src/policy.ts';
import { parseFieldChanges } from '../src/planners.ts';

describe('repair workspace policy', () => {
  it('allows only implementation and regression-test edits', () => {
    expect(isAgentEditable('packages/integration-shopify-netsuite/src/implementation/mapping.ts')).toBe(true);
    expect(isAgentEditable('packages/integration-shopify-netsuite/test/regression/x.test.ts')).toBe(true);
    for (const p of [
      'packages/integration-shopify-netsuite/test/acceptance/sync.test.ts',
      'packages/integration-shopify-netsuite/src/engine.ts',
      'packages/contracts/src/index.ts',
      'packages/test-fixtures/src/shopify-fixture.ts',
      'package.json',
      'pnpm-lock.yaml',
      'packages/integration-shopify-netsuite/src/implementation/../engine.ts',
    ]) {
      expect(() => assertEditable(p)).toThrow(PolicyViolation);
    }
  });
  it('rejects traversal and absolute paths, and secret files for reading', () => {
    expect(() => normalizeRepoPath('../etc/passwd')).toThrow(PolicyViolation);
    expect(() => normalizeRepoPath('/etc/passwd')).toThrow(PolicyViolation);
    expect(() => assertReadable('.env')).toThrow(PolicyViolation);
    expect(() => assertReadable('deploy/.env.production')).toThrow(PolicyViolation);
    expect(() => assertReadable('.git/config')).toThrow(PolicyViolation);
    expect(assertReadable('packages/contracts/src/index.ts')).toBe('packages/contracts/src/index.ts');
  });
  it('parses provider field-change tables', () => {
    const doc = '| Type | Removed field | Replacement field | Notes |\n|---|---|---|---|\n| LineItem | oldField | newField | x |';
    expect(parseFieldChanges(doc)).toEqual([{ type: 'LineItem', removed: 'oldField', replacement: 'newField' }]);
  });
});
