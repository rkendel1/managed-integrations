/**
 * Adopted code artifacts (generic; extracted from slice 5). Answers "which exact code is running?" for any
 * adopted integration:
 *
 * - the ORIGINAL artifact is the installed upstream package, never modified, hash-pinned per file;
 * - a PATCHED artifact is a content-addressed copy of that package with reviewed patches applied (exact
 *   text, single occurrence, base and result sha256 checked), materialized under ARTIFACT_DIR. Rolling a
 *   patch back selects the original again.
 *
 * Integration-specific: which files are executed, which modules are imported from them, and any extra
 * fields a reviewed patch carries (each integration extends ReviewedPatchSchema).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Fields every reviewed patch has, whatever the integration. */
export const ReviewedPatchSchema = z.object({
  id: z.string().regex(/^p\d{4}-[a-z0-9-]+$/),
  title: z.string(),
  /** The adopted artifact it was written against. */
  artifact: z.object({ repository: z.string(), commit: z.string().length(40) }),
  file: z.string(),
  baseSha256: z.string().length(64),
  resultSha256: z.string().length(64),
  find: z.string().min(1),
  replace: z.string(),
  reason: z.string(),
  originalBehavior: z.string(),
  replacementBehavior: z.string(),
  providerEvidence: z.array(z.string()),
  assumptions: z.array(z.string()),
  validation: z.array(z.string()),
  rollback: z.string(),
});
export type ReviewedPatch = z.infer<typeof ReviewedPatchSchema>;

/** Reads a directory of reviewed patch files (authored and reviewed like code; never generated). */
export function readPatchCatalog<T extends ReviewedPatch>(dir: string, schema: z.ZodType<T>): T[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => schema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
}

/** Applies one patch to a file's text, checking base hash, single occurrence and result hash. */
export function applyPatchText(original: string, p: ReviewedPatch): string {
  if (sha256(original) !== p.baseSha256) throw new Error(`${p.id}: base file hash does not match ${p.file}`);
  const first = original.indexOf(p.find);
  if (first < 0 || original.indexOf(p.find, first + 1) >= 0)
    throw new Error(`${p.id}: the replaced text must occur exactly once in ${p.file}`);
  const result = original.slice(0, first) + p.replace + original.slice(first + p.find.length);
  if (sha256(result) !== p.resultSha256)
    throw new Error(`${p.id}: result hash does not match the reviewed patch`);
  return result;
}

export interface PinnedSource {
  /** Short label used in artifact ids, e.g. "adopted" or "ledgerly". */
  label: string;
  repository: string;
  commit: string;
  /** Directory of the installed (unmodified) upstream package. */
  dir: string;
  /** sha256 of every executed upstream file, from an independent checkout at `commit`. */
  fileSha256: Readonly<Record<string, string>>;
  /** Extra files to copy into a patched artifact (e.g. package.json). */
  support?: readonly string[];
}

/** Files whose installed bytes differ from the pin. Empty means the installed package is the adopted code. */
export function pinnedDrift(src: PinnedSource): { file: string; expected: string; actual: string }[] {
  const out: { file: string; expected: string; actual: string }[] = [];
  for (const [file, expected] of Object.entries(src.fileSha256)) {
    const p = join(src.dir, file);
    const actual = existsSync(p) ? sha256(readFileSync(p)) : 'missing';
    if (actual !== expected) out.push({ file, expected, actual });
  }
  return out;
}

export function artifactId(src: PinnedSource, patches: readonly ReviewedPatch[]): string {
  const ordered = [...patches].sort((a, b) => a.id.localeCompare(b.id));
  return `${src.label}:${src.commit.slice(0, 12)}${ordered.length ? `+${ordered.map((p) => p.id.slice(0, 5)).join('+')}` : ''}`;
}

export interface MaterializedArtifact {
  id: string;
  /** Directory the modules are imported from: the installed package, or the content-addressed copy. */
  root: string;
  base: { repository: string; commit: string };
  patches: { id: string; file: string; resultSha256: string }[];
  /** sha256 of every executed file in this artifact. */
  files: Record<string, string>;
}

/**
 * The artifact for a set of patches (none → the installed package). Refuses patches written for another
 * commit, patches that do not apply exactly, and installed files that drifted from the pin.
 */
export function materializeArtifact(
  src: PinnedSource,
  patches: readonly ReviewedPatch[],
): MaterializedArtifact {
  const ordered = [...patches].sort((a, b) => a.id.localeCompare(b.id));
  const id = artifactId(src, ordered);
  const drift = pinnedDrift(src);
  if (drift.length)
    throw new Error(`Installed upstream differs from the pin: ${drift.map((d) => d.file).join(', ')}`);
  const files: Record<string, string> = { ...src.fileSha256 };
  const base = { repository: src.repository, commit: src.commit };
  if (!ordered.length) return { id, root: src.dir, base, patches: [], files };
  for (const p of ordered) {
    if (p.artifact.commit !== src.commit) throw new Error(`${p.id} was written for another commit`);
    if (!(p.file in src.fileSha256))
      throw new Error(`${p.id} changes ${p.file}, which is not an executed file`);
  }
  const key = sha256(JSON.stringify(ordered.map((p) => [p.id, p.resultSha256])) + src.commit).slice(0, 16);
  const root = resolve(
    process.env.ARTIFACT_DIR ?? './var/artifacts',
    src.label,
    `${src.commit.slice(0, 12)}-${key}`,
  );
  const texts = new Map<string, string>();
  for (const p of ordered) {
    const before = texts.get(p.file) ?? readFileSync(join(src.dir, p.file), 'utf8');
    texts.set(p.file, applyPatchText(before, p));
  }
  if (!existsSync(join(root, '.complete'))) {
    const tmp = `${root}.tmp-${process.pid}-${Date.now()}`;
    for (const rel of [...(src.support ?? []), ...Object.keys(src.fileSha256)]) {
      if (!existsSync(join(src.dir, rel))) continue;
      mkdirSync(dirname(join(tmp, rel)), { recursive: true });
      writeFileSync(join(tmp, rel), texts.get(rel) ?? readFileSync(join(src.dir, rel)));
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
  return {
    id,
    root,
    base,
    patches: ordered.map((p) => ({ id: p.id, file: p.file, resultSha256: p.resultSha256 })),
    files,
  };
}
