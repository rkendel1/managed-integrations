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
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * A reviewed change of one dependency of the adopted code (slice 7): e.g. the provider client library the
 * application uses moves to another version. Like a patch it is authored and reviewed, never generated, and
 * selecting it produces a different artifact (its id names the change); rolling it back selects the pinned
 * dependency set again.
 */
export const ReviewedDependencyChangeSchema = z.object({
  id: z.string().regex(/^d\d{4}-[a-z0-9.-]+$/),
  title: z.string(),
  artifact: z.object({ repository: z.string(), commit: z.string().length(40) }),
  dependency: z.string(),
  from: z.string(),
  to: z.string(),
  reason: z.string(),
  originalBehavior: z.string(),
  replacementBehavior: z.string(),
  /** Where the change comes from: upstream's own release, the dependency's changelog, the provider. */
  evidence: z.array(z.string()),
  assumptions: z.array(z.string()),
  validation: z.array(z.string()),
  rollback: z.string(),
});
export type ReviewedDependencyChange = z.infer<typeof ReviewedDependencyChangeSchema>;

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
  /**
   * Where materialized copies live (default ARTIFACT_DIR/<label>). An application whose code imports
   * packages needs this inside its host package, so those imports resolve to the host's pinned versions.
   */
  artifactDir?: string;
  /**
   * Deployment bindings (slice 7): executed upstream files the deployment REPLACES as a whole — the
   * application's own database client or environment loader — because the host provides them. The upstream
   * file stays pinned by sha256 above (so a change upstream is still detected); the binding's text is part of
   * every artifact and its sha256 is recorded. Never used for behaviour: that is what patches are for.
   */
  bindings?: Readonly<Record<string, { content: string; reason: string }>>;
  /**
   * The dependency set the code runs with, by import name (slice 7): each is linked into the artifact's own
   * node_modules, so "which client library version runs" is part of the artifact, not of the host.
   */
  dependencies?: Readonly<Record<string, { version: string; dir: string }>>;
  /** Installed alternatives a reviewed dependency change may select: name → version → directory. */
  installed?: Readonly<Record<string, Readonly<Record<string, string>>>>;
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

export function artifactId(
  src: PinnedSource,
  patches: readonly ReviewedPatch[],
  dependencyChanges: readonly ReviewedDependencyChange[] = [],
): string {
  const ids = [...patches.map((p) => p.id), ...dependencyChanges.map((d) => d.id)].sort();
  return `${src.label}:${src.commit.slice(0, 12)}${ids.length ? `+${ids.map((i) => i.slice(0, 5)).join('+')}` : ''}`;
}

export interface MaterializedArtifact {
  id: string;
  /** Directory the modules are imported from: the installed package, or the content-addressed copy. */
  root: string;
  base: { repository: string; commit: string };
  patches: { id: string; file: string; resultSha256: string }[];
  /** sha256 of every executed file in this artifact. */
  files: Record<string, string>;
  /** Deployment bindings in this artifact (file → sha256 of the binding text). */
  bindings: Record<string, string>;
  /** The dependency set it runs with (name → version), and the reviewed changes that produced it. */
  dependencies: Record<string, string>;
  dependencyChanges: { id: string; dependency: string; from: string; to: string }[];
}

/**
 * The artifact for a set of patches and dependency changes (none, and no bindings or dependency set → the
 * installed package itself). Refuses patches written for another commit, patches that do not apply exactly,
 * dependency changes that do not start from the pinned version or select an uninstalled one, and installed
 * files that drifted from the pin. `instance` gives one integration its own copy (module singletons of an
 * adopted application — its database client, its provider client — must not be shared between customers).
 */
export function materializeArtifact(
  src: PinnedSource,
  patches: readonly ReviewedPatch[],
  opts: { dependencyChanges?: readonly ReviewedDependencyChange[]; instance?: string } = {},
): MaterializedArtifact {
  const ordered = [...patches].sort((a, b) => a.id.localeCompare(b.id));
  const changes = [...(opts.dependencyChanges ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  const id = artifactId(src, ordered, changes);
  const drift = pinnedDrift(src);
  if (drift.length)
    throw new Error(`Installed upstream differs from the pin: ${drift.map((d) => d.file).join(', ')}`);
  const files: Record<string, string> = { ...src.fileSha256 };
  const base = { repository: src.repository, commit: src.commit };
  const bindings = Object.fromEntries(
    Object.entries(src.bindings ?? {}).map(([f, b]) => [f, sha256(b.content)]),
  );
  const deps = new Map(Object.entries(src.dependencies ?? {}).map(([n, d]) => [n, { ...d }]));
  for (const c of changes) {
    if (c.artifact.commit !== src.commit) throw new Error(`${c.id} was written for another commit`);
    const cur = deps.get(c.dependency);
    if (!cur) throw new Error(`${c.id} changes ${c.dependency}, which is not in the pinned dependency set`);
    if (cur.version !== c.from) throw new Error(`${c.id} starts from ${c.dependency} ${c.from}, but ${cur.version} is pinned`);
    const dir = src.installed?.[c.dependency]?.[c.to];
    if (!dir || !existsSync(dir)) throw new Error(`${c.id}: ${c.dependency} ${c.to} is not installed`);
    deps.set(c.dependency, { version: c.to, dir });
  }
  const dependencies = Object.fromEntries([...deps].map(([n, d]) => [n, d.version]));
  const result = {
    id,
    base,
    patches: ordered.map((p) => ({ id: p.id, file: p.file, resultSha256: p.resultSha256 })),
    dependencies,
    dependencyChanges: changes.map((c) => ({ id: c.id, dependency: c.dependency, from: c.from, to: c.to })),
  };
  if (!ordered.length && !changes.length && !Object.keys(bindings).length && !deps.size && !opts.instance)
    return { ...result, root: src.dir, files, bindings };
  for (const p of ordered) {
    if (p.artifact.commit !== src.commit) throw new Error(`${p.id} was written for another commit`);
    if (!(p.file in src.fileSha256))
      throw new Error(`${p.id} changes ${p.file}, which is not an executed file`);
    if (p.file in bindings) throw new Error(`${p.id} changes ${p.file}, which the deployment binds`);
  }
  const key = sha256(
    JSON.stringify([ordered.map((p) => [p.id, p.resultSha256]), bindings, dependencies]) + src.commit,
  ).slice(0, 16);
  const root = resolve(
    src.artifactDir ?? join(process.env.ARTIFACT_DIR ?? './var/artifacts', src.label),
    `${src.commit.slice(0, 12)}-${key}`,
    ...(opts.instance ? [opts.instance] : []),
  );
  const texts = new Map<string, string>();
  for (const p of ordered) {
    const before = texts.get(p.file) ?? readFileSync(join(src.dir, p.file), 'utf8');
    texts.set(p.file, applyPatchText(before, p));
  }
  for (const [f, b] of Object.entries(src.bindings ?? {})) texts.set(f, b.content);
  if (!existsSync(join(root, '.complete'))) {
    const tmp = `${root}.tmp-${process.pid}-${Date.now()}`;
    for (const rel of [...(src.support ?? []), ...Object.keys(src.fileSha256)]) {
      if (!existsSync(join(src.dir, rel))) continue;
      mkdirSync(dirname(join(tmp, rel)), { recursive: true });
      writeFileSync(join(tmp, rel), texts.get(rel) ?? readFileSync(join(src.dir, rel)));
    }
    for (const [name, d] of deps) {
      const link = join(tmp, 'node_modules', name);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(resolve(d.dir), link, 'dir');
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
  for (const [name, d] of deps) {
    const pkg = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')) as { version: string };
    if (pkg.version !== d.version) throw new Error(`Artifact links ${name} ${pkg.version}, expected ${d.version}`);
  }
  return { ...result, root, files, bindings };
}

/* ------------------------------------------------------------------ application host bindings */

/**
 * What a deployment binding resolves to at run time. A binding file is static text (so it can be pinned):
 * it asks the host for its values by its own location, `globalThis.__miAppHost.bind(import.meta.url)`, and
 * the host answers with what was registered for that artifact instance (its database delegate, its
 * environment). Nothing secret is written to disk.
 */
export interface AppHost {
  register(root: string, values: Record<string, unknown>): void;
  /** `url`: the binding file's import.meta.url (ESM) or __filename (CommonJS). */
  bind(url: string): Record<string, unknown>;
}
export function appHost(): AppHost {
  const g = globalThis as { __miAppHost?: AppHost };
  if (!g.__miAppHost) {
    const roots = new Map<string, Record<string, unknown>>();
    g.__miAppHost = {
      register: (root, values) => void roots.set(resolve(root), values),
      bind(url) {
        const file = url.startsWith('file:') ? fileURLToPath(url) : resolve(url);
        const hit = [...roots.entries()]
          .filter(([r]) => file.startsWith(`${r}/`))
          .sort((a, b) => b[0].length - a[0].length)[0];
        if (!hit) throw new Error(`No application host registered for ${file}`);
        return hit[1];
      },
    };
  }
  return g.__miAppHost;
}
