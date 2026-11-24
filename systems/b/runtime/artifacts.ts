/**
 * Adopted-code artifacts. An artifact is the pinned upstream source, optionally with reviewed patches
 * applied, bundled by esbuild into one module and identified by its content hash. The pinned install in
 * node_modules is never modified: a patch produces a new artifact beside it, and rollback is loading the
 * previous one. Each patch is an exact-text replacement whose before/after the reviewer approved; a patch
 * whose `find` text does not occur exactly once refuses to apply.
 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface Patch {
  id: string;
  file: string;
  find: string;
  replace: string;
  reason: string;
}

export interface ArtifactSpec {
  /** npm package name of the adopted code (installed from its pinned commit). */
  pkg: string;
  /** Module exporting what we call, relative to the package root. */
  entry: string;
  /** When the upstream has no single module exporting what we call: our entry, written into the copy (re-exports only). */
  entrySource?: string;
  patches: Patch[];
}

export interface Artifact<T> {
  id: string;
  dir: string;
  manifest: { pkg: string; upstream: { version: string; resolved: string | null }; patches: { id: string; file: string; sha256Before: string; sha256After: string }[]; bundleSha256: string };
  module: T;
}

const root = process.env.MI_ARTIFACT_DIR ?? join(process.cwd(), ".feltkit", "artifacts");
const loaded = new Map<string, Artifact<any>>();
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export async function materialize<T>(spec: ArtifactSpec): Promise<Artifact<T>> {
  // The installed copy (a package's `exports` may hide package.json from require.resolve).
  const pkgDir = join(process.cwd(), "node_modules", spec.pkg);
  if (!existsSync(join(pkgDir, "package.json"))) throw new Error(`${spec.pkg} is not installed`);
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version: string; _resolved?: string };
  const lock = JSON.parse(readFileSync(join(process.cwd(), "package-lock.json"), "utf8")) as { packages: Record<string, { resolved?: string }> };
  const resolved = lock.packages[`node_modules/${spec.pkg}`]?.resolved ?? null;
  const id = sha(JSON.stringify({ pkg: spec.pkg, resolved, entry: spec.entry, entrySource: spec.entrySource ?? null, patches: spec.patches })).slice(0, 16);
  const hit = loaded.get(id);
  if (hit) return hit;

  const dir = join(root, `${spec.pkg}-${id}`);
  const out = join(dir, "artifact.mjs");
  const patches: Artifact<T>["manifest"]["patches"] = [];
  if (!existsSync(out)) {
    mkdirSync(dir, { recursive: true });
    cpSync(pkgDir, join(dir, "src-tree"), { recursive: true, filter: (p) => !p.includes(`${pkgDir}/node_modules`) });
    if (spec.entrySource) writeFileSync(join(dir, "src-tree", spec.entry), spec.entrySource);
    for (const p of spec.patches) {
      const file = join(dir, "src-tree", p.file);
      const before = readFileSync(file, "utf8");
      const at = before.indexOf(p.find);
      if (at < 0 || before.indexOf(p.find, at + 1) >= 0) throw new Error(`patch ${p.id}: the reviewed text does not occur exactly once in ${p.file}`);
      const after = before.slice(0, at) + p.replace + before.slice(at + p.find.length);
      writeFileSync(file, after);
      patches.push({ id: p.id, file: p.file, sha256Before: sha(before), sha256After: sha(after) });
    }
    await build({
      entryPoints: [join(dir, "src-tree", spec.entry)],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      outfile: out,
      // Third-party dependencies of the adopted code stay the application's installed copies.
      packages: "external",
      logLevel: "silent",
    });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ pkg: spec.pkg, upstream: { version: pkgJson.version, resolved }, patches, bundleSha256: sha(readFileSync(out)) }, null, 2));
  }
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Artifact<T>["manifest"];
  if (manifest.bundleSha256 !== sha(readFileSync(out))) throw new Error(`artifact ${id} was modified after it was built`);
  const module = (await import(pathToFileURL(out).href)) as T;
  const artifact = { id, dir, manifest, module };
  loaded.set(id, artifact);
  return artifact;
}
