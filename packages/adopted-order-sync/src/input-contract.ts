/**
 * The adopted code's INPUT contract: the fields of a Shopify `orders/create` payload that upstream
 * `src/mapping.js#toCanonicalOrder` reads, with what each must look like. Upstream does not validate
 * its input: a missing `price` becomes `NaN` and is sent to NetSuite as a null rate. This module lets
 * the adoption boundary see that before upstream runs.
 *
 * Each rule names the exact upstream expression it protects; `locateUpstreamReads` finds it in the
 * installed (hash-pinned) upstream file, so the contract cannot drift from the code silently.
 *
 * Also here: input compatibility rules — the only correction the adoption boundary can apply without
 * modifying upstream. A rule copies a value the provider now sends under a new path to the path
 * upstream reads, only when that path is absent. Rules are per-integration configuration, added only
 * by the maintenance lifecycle after validation (see maintenance.ts).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ADOPTED } from './provenance.ts';

type Kind = 'integer' | 'string' | 'decimal_string' | 'number';

export interface ContractField {
  /** Payload path; `[]` marks the line array. */
  path: string;
  kind: Kind;
  /** For line fields: checked only on lines upstream keeps (lines with a SKU). */
  requiredOnSkuLines?: boolean;
  required?: boolean;
  /** Plain-language name, used when the field is described to a customer. */
  label: string;
  /** The upstream expression that reads it, and where. */
  upstream: { file: 'src/mapping.js'; expression: string; effect: string };
}

export const UPSTREAM_INPUT_CONTRACT: readonly ContractField[] = [
  {
    path: 'id',
    label: 'the order number',
    kind: 'integer',
    required: true,
    upstream: { file: 'src/mapping.js', expression: 'shopifyOrder.id', effect: 'NetSuite externalId' },
  },
  {
    path: 'name',
    label: 'the order name',
    kind: 'string',
    required: true,
    upstream: { file: 'src/mapping.js', expression: 'shopifyOrder.name', effect: 'NetSuite otherRefNum' },
  },
  {
    path: 'currency',
    label: 'the order currency',
    kind: 'string',
    required: true,
    upstream: { file: 'src/mapping.js', expression: 'shopifyOrder.currency', effect: 'NetSuite currency' },
  },
  {
    path: 'line_items',
    label: 'the order lines',
    kind: 'number', // presence of the array is checked separately
    required: true,
    upstream: { file: 'src/mapping.js', expression: 'shopifyOrder.line_items', effect: 'NetSuite lines' },
  },
  {
    path: 'line_items[].quantity',
    label: 'the quantity of each order line',
    kind: 'number',
    requiredOnSkuLines: true,
    upstream: { file: 'src/mapping.js', expression: 'l.quantity', effect: 'NetSuite line quantity' },
  },
  {
    path: 'line_items[].price',
    label: 'the unit price of each order line',
    kind: 'decimal_string',
    requiredOnSkuLines: true,
    upstream: {
      file: 'src/mapping.js',
      expression: 'l.price',
      effect: 'NetSuite line rate (upstream: round2(Number(l.price)); absent → NaN → null rate)',
    },
  },
];

export interface ContractViolation {
  path: string;
  expected: string;
  /**
   * precision: more decimal places than the artifact preserves (upstream rounds prices to 2);
   * conflict: a field and its documented replacement are both present and disagree.
   */
  observed: 'absent' | 'null' | 'wrong_type' | 'precision' | 'conflict';
  /** How many lines (for line fields) or 1. */
  occurrences: number;
}

const KIND_TEXT: Record<Kind, string> = {
  integer: 'integer',
  string: 'non-empty string',
  decimal_string: 'decimal string (e.g. "19.99")',
  number: 'number',
};

function matches(kind: Kind, v: unknown): boolean {
  switch (kind) {
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'string':
      return typeof v === 'string' && v.length > 0;
    case 'decimal_string':
      return (
        (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) || (typeof v === 'number' && Number.isFinite(v))
      );
    case 'number':
      return (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^\d+$/.test(v));
  }
}

const observedOf = (v: unknown): ContractViolation['observed'] =>
  v === undefined ? 'absent' : v === null ? 'null' : 'wrong_type';

/**
 * Precision the ORIGINAL artifact preserves, per field: upstream `mapping.js` computes
 * `round2(Number(l.price))`, so a price with more than 2 decimals is silently rounded. A reviewed patch
 * may declare a different precision for the artifact it produces (see artifact.ts).
 */
export const ORIGINAL_PRECISION: Readonly<Record<string, number>> = { 'line_items[].price': 2 };

const decimals = (v: unknown): number => {
  const m = String(v).match(/\.(\d+)$/);
  return m ? m[1]!.replace(/0+$/, '').length : 0;
};

/** Checks a payload against the adopted input contract. Empty result = the artifact can map it correctly. */
export function checkInputContract(
  payload: unknown,
  opts: { precision?: Readonly<Record<string, number>> } = {},
): ContractViolation[] {
  const precision = opts.precision ?? ORIGINAL_PRECISION;
  const out: ContractViolation[] = [];
  const o = (payload ?? {}) as Record<string, unknown>;
  for (const f of UPSTREAM_INPUT_CONTRACT) {
    if (f.path === 'line_items') {
      if (!Array.isArray(o['line_items']))
        out.push({ path: f.path, expected: 'array', observed: observedOf(o['line_items']), occurrences: 1 });
      continue;
    }
    if (!f.path.startsWith('line_items[].')) {
      const v = o[f.path];
      if (f.required && !matches(f.kind, v))
        out.push({ path: f.path, expected: KIND_TEXT[f.kind], observed: observedOf(v), occurrences: 1 });
      continue;
    }
    const key = f.path.slice('line_items[].'.length);
    const lines = Array.isArray(o['line_items']) ? (o['line_items'] as Record<string, unknown>[]) : [];
    const bad = lines.filter((l) => l && l['sku'] && !matches(f.kind, l[key]));
    if (bad.length)
      out.push({
        path: f.path,
        expected: KIND_TEXT[f.kind],
        observed: observedOf(bad[0]![key]),
        occurrences: bad.length,
      });
    const max = precision[f.path];
    if (max != null && !bad.length) {
      const lossy = lines.filter((l) => l && l['sku'] && decimals(l[key]) > max);
      if (lossy.length)
        out.push({
          path: f.path,
          expected: `at most ${max} decimal places (the running code rounds to ${max})`,
          observed: 'precision',
          occurrences: lossy.length,
        });
    }
  }
  return out;
}

/** Key paths of a payload (values excluded — no customer data), `[]` for arrays. Sorted. */
export function shapeOf(payload: unknown): string[] {
  const paths = new Set<string>();
  const walk = (v: unknown, prefix: string) => {
    if (Array.isArray(v)) {
      for (const e of v) walk(e, `${prefix}[]`);
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, c] of Object.entries(v)) {
        const p = prefix ? `${prefix}.${k}` : k;
        paths.add(p);
        walk(c, p);
      }
    }
  };
  walk(payload, '');
  return [...paths].sort();
}

/* ------------------------------------------------------------------ compatibility rules */

const PATH = /^[a-z_]+(\[\])?(\.[a-z_]+)*$/;
/** A field-moved adapter: the provider now sends the value upstream reads under another path. */
export const FieldMovedSpecSchema = z.object({
  type: z.literal('field_moved'),
  /** Path upstream reads (a contract field). */
  target: z.string().regex(PATH),
  /** Path the provider now sends the same value under. Same array level as `target`. */
  source: z.string().regex(PATH),
});
export type FieldMovedSpec = z.infer<typeof FieldMovedSpecSchema>;

const get = (o: unknown, path: string[]): unknown =>
  path.reduce<unknown>(
    (v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined),
    o,
  );

/** A usable scalar: non-empty string or finite number. Objects, arrays, null and '' are never copied. */
const usable = (v: unknown) =>
  (typeof v === 'string' && v.trim() !== '') || (typeof v === 'number' && Number.isFinite(v));
const same = (a: unknown, b: unknown) =>
  usable(a) &&
  usable(b) &&
  (Number.isFinite(Number(a)) && Number.isFinite(Number(b))
    ? Number(a) === Number(b)
    : String(a) === String(b));

export interface AdapterConflict {
  target: string;
  source: string;
  line: number | null;
}

/**
 * Applies field-moved adapters to a parsed payload. Pure and idempotent (applying twice changes nothing).
 * - target absent, source usable → copied;
 * - target and source both present and equal → nothing to do;
 * - target and source both present and DIFFERENT → conflict (never resolved silently: the order is held);
 * - source missing, null, empty or not a scalar → nothing copied (the contract check then reports it).
 */
export function applyInputCompat(
  payload: unknown,
  rules: readonly Pick<FieldMovedSpec, 'target' | 'source'>[],
): {
  payload: unknown;
  applied: { target: string; source: string; count: number }[];
  conflicts: AdapterConflict[];
} {
  const out = structuredClone(payload) as Record<string, unknown>;
  const applied: { target: string; source: string; count: number }[] = [];
  const conflicts: AdapterConflict[] = [];
  for (const r of rules) {
    let count = 0;
    const [tHead, tRest] = r.target.split('[].') as [string, string | undefined];
    const [sHead, sRest] = r.source.split('[].') as [string, string | undefined];
    const one = (holder: Record<string, unknown>, tKey: string, sPath: string[], line: number | null) => {
      const t = holder[tKey];
      const v = get(holder, sPath);
      if (t !== undefined && t !== null && t !== '') {
        if (v !== undefined && v !== null && !same(t, v))
          conflicts.push({ target: r.target, source: r.source, line });
        return;
      }
      if (usable(v)) {
        holder[tKey] = v;
        count++;
      }
    };
    if (tRest !== undefined) {
      if (sRest === undefined || sHead !== tHead || !Array.isArray(out[tHead])) continue;
      (out[tHead] as Record<string, unknown>[]).forEach((line, i) => {
        if (line && typeof line === 'object') one(line, tRest, sRest.split('.'), i);
      });
    } else {
      one(out, r.target, r.source.split('.'), null);
    }
    if (count) applied.push({ target: r.target, source: r.source, count });
  }
  return { payload: out, applied, conflicts };
}

/** Conflicts as contract violations (so the guard holds the order). */
export function conflictViolations(conflicts: AdapterConflict[]): ContractViolation[] {
  const by = new Map<string, number>();
  for (const c of conflicts) by.set(c.target, (by.get(c.target) ?? 0) + 1);
  return [...by].map(([path, n]) => ({
    path,
    expected: 'the field and its documented replacement to agree',
    observed: 'conflict' as const,
    occurrences: n,
  }));
}

/* ------------------------------------------------------------------ upstream code references */

export function upstreamDir(): string {
  return dirname(createRequire(import.meta.url).resolve(`${ADOPTED.packageName}/package.json`));
}

export interface UpstreamRead {
  file: string;
  line: number;
  code: string;
  fileSha256: string;
  /** The installed file is byte-identical to the pinned upstream commit. */
  matchesPinnedCommit: boolean;
}

/** Finds where upstream reads a contract field, in the installed (pinned) upstream file. */
export function locateUpstreamRead(field: ContractField): UpstreamRead[] {
  const file = field.upstream.file;
  const buf = readFileSync(join(upstreamDir(), file));
  const sha = createHash('sha256').update(buf).digest('hex');
  const re = new RegExp(`\\b${field.upstream.expression.replace(/\./g, '\\.')}\\b(?!_)`);
  return buf
    .toString('utf8')
    .split('\n')
    .flatMap((code, i) =>
      re.test(code)
        ? [
            {
              file,
              line: i + 1,
              code: code.trim(),
              fileSha256: sha,
              matchesPinnedCommit: sha === ADOPTED.fileSha256[file],
            },
          ]
        : [],
    );
}
