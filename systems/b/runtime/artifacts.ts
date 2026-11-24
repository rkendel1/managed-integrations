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
  /** Name of the adopted code: an npm package installed from its pinned commit, or a directory under vendor/. */
  pkg: string;
  /** "vendor": the pinned source copied into vendor/<pkg> (with PROVENANCE.json); default: node_modules/<pkg>. */
  from?: "node_modules" | "vendor";
  /** Module specifiers the bundle resolves to another installed package (e.g. a dependency version). */
  alias?: Record<string, string>;
  /** Modules of the adopted code that the host provides instead (e.g. its database client): import pattern → our file. */
  provide?: { importPattern: string; file: string }[];
  /** Module exporting what we call, relative to the package root. */
  entry: string;
  /** When the upstream has no single module exporting what we call: our entry, written into the copy (re-exports only). */
  entrySource?: string;
  patches: Patch[];
}

export interface Artifact<T> {
  id: string;
  dir: string;
  manifest: { pkg: string; upstream: { version: string; resolved: string | null }; patches: { id: string; file: string; sha256Before: string; sha256After: string }[]; executed: string[]; bundleSha256: string };
  module: T;
}

const root = process.env.MI_ARTIFACT_DIR ?? join(process.cwd(), ".feltkit", "artifacts");
const loaded = new Map<string, Artifact<any>>();
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export async function materialize<T>(spec: ArtifactSpec): Promise<Artifact<T>> {
  // The installed or vendored copy (a package's `exports` may hide package.json from require.resolve).
  const pkgDir = join(process.cwd(), spec.from === "vendor" ? "vendor" : "node_modules", spec.pkg);
  if (!existsSync(join(pkgDir, "package.json"))) throw new Error(`${spec.pkg} is not installed`);
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version: string };
  let resolved: string | null;
  if (spec.from === "vendor") {
    const prov = JSON.parse(readFileSync(join(pkgDir, "PROVENANCE.json"), "utf8")) as { repository: string; commit: string };
    resolved = `${prov.repository}#${prov.commit}`;
  } else {
    const lock = JSON.parse(readFileSync(join(process.cwd(), "package-lock.json"), "utf8")) as { packages: Record<string, { resolved?: string }> };
    resolved = lock.packages[`node_modules/${spec.pkg}`]?.resolved ?? null;
  }
  const id = sha(JSON.stringify({ format: 2, pkg: spec.pkg, resolved, entry: spec.entry, entrySource: spec.entrySource ?? null, patches: spec.patches, alias: spec.alias ?? {}, provide: (spec.provide ?? []).map((p) => ({ ...p, sha: sha(readFileSync(p.file)) })) })).slice(0, 16);
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
    const result = await build({
      entryPoints: [join(dir, "src-tree", spec.entry)],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      outfile: out,
      metafile: true,
      // Third-party dependencies of the adopted code stay the application's installed copies.
      packages: "external",
      ...(spec.alias ? { alias: spec.alias } : {}),
      plugins: (spec.provide ?? []).map((p) => ({
        name: `provide:${p.importPattern}`,
        setup(b: import("esbuild").PluginBuild) {
          b.onResolve({ filter: new RegExp(p.importPattern) }, () => ({ path: p.file }));
        },
      })),
      logLevel: "silent",
    });
    // The adopted files this artifact executes (relative to the package), from esbuild's own record.
    const executed = Object.keys(result.metafile?.inputs ?? {})
      .map((f) => f.replace(/\\/g, "/"))
      .filter((f) => f.includes("/src-tree/"))
      .map((f) => f.slice(f.indexOf("/src-tree/") + "/src-tree/".length))
      .filter((f) => f !== spec.entry)
      .sort();
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ pkg: spec.pkg, upstream: { version: pkgJson.version, resolved }, patches, executed, bundleSha256: sha(readFileSync(out)) }, null, 2));
  }
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Artifact<T>["manifest"];
  if (manifest.bundleSha256 !== sha(readFileSync(out))) throw new Error(`artifact ${id} was modified after it was built`);
  const module = (await import(pathToFileURL(out).href)) as T;
  const artifact = { id, dir, manifest, module };
  loaded.set(id, artifact);
  return artifact;
}
