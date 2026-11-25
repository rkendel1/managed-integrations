/**
 * Build every reviewed artifact variant from the pinned sources and write runtime/generated/artifacts.json,
 * which the runtime component imports (so `feltkit build` / `feltkit deploy` ship them). Run after changing a
 * pin, a patch or a dependency variant; `--check` fails when the committed file is stale.
 */
export {};
process.env.MI_ARTIFACTS_FROM_SOURCE = "1";
// Start from an empty cache: a running app's cache holds bundles unpacked from the prebuilt file, without the
// source trees this script reads (it re-unpacks them on demand). Same path as before, so bundles are byte-stable.
if (!process.env.MI_ARTIFACT_DIR) {
  const { rmSync } = await import("node:fs");
  rmSync((await import("node:path")).join(process.cwd(), ".feltkit", "artifacts"), { recursive: true, force: true });
}
const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
const { join } = await import("node:path");
const { materialize, artifactKey } = await import("../runtime/artifacts.ts");
const { PATCHES, artifactSpec: ledgerlySpec } = await import("../runtime/ledgerly.ts");
const { APP_PATCHES, stripeAppSpec, qbToolsSpec } = await import("../runtime/apps.ts");
const { ORDER_SYNC_PATCHES, orderSyncSpec } = await import("../runtime/order-sync.ts");

const variants = [
  { spec: ledgerlySpec([]), cite: ["src/server/dispatchers/qbo.ts"] },
  ...Object.keys(PATCHES).map((id) => ({ spec: ledgerlySpec([id]), cite: ["src/server/dispatchers/qbo.ts"] })),
  { spec: stripeAppSpec([]), cite: ["src/webhooks/stripeEventProcessor.ts"] },
  ...Object.keys(APP_PATCHES).map((id) => ({ spec: stripeAppSpec([id]), cite: ["src/webhooks/stripeEventProcessor.ts"] })),
  ...Object.keys(ORDER_SYNC_PATCHES).map((id) => ({ spec: orderSyncSpec([id]), cite: [ORDER_SYNC_PATCHES[id]!.file] })),
  { spec: qbToolsSpec("2.0.48"), cite: [] },
  { spec: qbToolsSpec("2.0.50"), cite: [] },
];
const out: Record<string, unknown> = {};
for (const v of variants) {
  const a = await materialize(v.spec);
  out[artifactKey(v.spec)] = {
    id: a.id,
    manifest: a.manifest,
    bundle: readFileSync(join(a.dir, "artifact.mjs"), "utf8"),
    sources: Object.fromEntries(v.cite.map((f) => [f, readFileSync(join(a.dir, "src-tree", f), "utf8")])),
  };
  console.log(`${a.id}  ${a.manifest.pkg}  patches=${a.manifest.patches.map((p) => p.id).join(",") || "-"}  executed=${a.manifest.executed.length}`);
}
const file = "runtime/generated/artifacts.json";
const text = JSON.stringify(out, null, 1) + "\n";
if (process.argv.includes("--check")) {
  if (!existsSync(file) || readFileSync(file, "utf8") !== text) {
    console.error(`${file} is stale: run npx tsx scripts/build-artifacts.ts`);
    process.exit(1);
  }
  console.log(`${file} is current`);
} else writeFileSync(file, text);
