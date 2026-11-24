/**
 * The pinned ledgerly engine, loaded through our artifact loader (the code our executor runs), reproduces
 * upstream's own golden QuickBooks outputs (vendored from the same commit), and the installed package is
 * exactly the pinned upstream code.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pinnedDrift } from '@mi/managed';
import { loadLedgerly, pinnedSource } from '../src/artifact.ts';

const dir = join(import.meta.dirname, 'upstream-fixtures');
const names = readdirSync(dir)
  .filter((f) => f.endsWith('.qbo.json'))
  .map((f) => f.replace('.qbo.json', ''));
const TEST_MAP = Object.fromEntries(
  [
    '1000',
    '1010',
    '1100',
    '1200',
    '2000',
    '2100',
    '2200',
    '4000',
    '4100',
    '4900',
    '6000',
    '6100',
    '6200',
    '7000',
  ].map((c) => [c, { qboId: `qbo-${c}`, name: `QBO ${c}` }]),
);

describe('adopted ledgerly (pinned)', () => {
  it('the installed package is exactly the pinned upstream code', () => {
    expect(pinnedDrift(pinnedSource())).toEqual([]);
  });
  it(`reproduces upstream's ${names.length} golden QuickBooks outputs through our loader`, async () => {
    const { id, modules } = await loadLedgerly();
    expect(id).toBe('ledgerly:3101182eadc9');
    expect(names.length).toBe(29);
    for (const n of names) {
      const event = JSON.parse(readFileSync(join(dir, `${n}.event.json`), 'utf8'));
      const expected = JSON.parse(readFileSync(join(dir, `${n}.qbo.json`), 'utf8'));
      const r = modules.mapEvent(event);
      expect(modules.toQbo(r.entries[0]!, TEST_MAP), n).toEqual(expected);
    }
  });
});
