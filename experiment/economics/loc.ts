/**
 * Code economics for both systems with one counting rule and explicit, reviewable path rules.
 *
 * A line of code: not blank, not only a comment (the definition `feltkit measure` uses). Files: `git ls-files`.
 * Categories (the experiment's):
 *   A platform-owned  — produced and kept by the platform (FeltKit's generated deploy files): never counted.
 *   B product         — expresses the managed-integration product: domain, provider integration, UI.
 *   C residual glue   — plumbing the product needs that is not the product (HTTP/queue wiring, auth, sessions,
 *                       persistence plumbing, component work loop).
 *   D manual assembly — build, deploy and operations files the team writes and maintains.
 *   E platform gap    — written because the platform lacks something (cited FINDINGS entry).
 *   tests / third-party / generated / S1-only / slice-8 analysis — reported beside, not in B–E totals.
 * A rule is the first one matching a path. Mixed files are assigned to their predominant purpose; the rule
 * says which.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

type Cat = "B" | "C" | "D" | "E" | "tests" | "third-party" | "generated" | "excluded" | "S1-only" | "analysis";
type Rule = [RegExp, Cat, string];

const A_RULES: Rule[] = [
  [/(^|\/)(node_modules|dist|\.artifacts|upstream)\//, "third-party", "vendored or installed code"],
  [/^systems\//, "excluded", "System B"],
  [/^\.pnpm-store\//, "excluded", "package store"],
  [/^test\//, "tests", "test support"],
  [/^\.(gitignore|prettierignore|prettierrc\.json)$/, "D", "tool configuration"],
  [/^experiment\//, "excluded", "experiment harness"],
  [/\.(md|png|jpg|svg|lock|json\.gz)$|pnpm-lock|LICENSE|PROVENANCE/, "excluded", "not code"],
  [/^docs\//, "excluded", "documentation"],
  [/^(e2e|packages\/test-fixtures)\/|\/test\/|\.test\.ts$|^apps\/api\/scripts\/|^scripts\/demo/, "tests", "tests, simulators, demos"],
  [/^packages\/openapi\//, "analysis", "slice-8 contract analysis tooling (not a runtime feature; not in B)"],
  [/^packages\/maintenance\//, "S1-only", "agent repair, sandbox validation and releases of the native flow (S1)"],
  [/^packages\/integration-shopify-netsuite\/src\/(engine|sync|reconcile|release)/, "S1-only", "native polling engine (S1)"],
  [/^apps\/web\//, "B", "product UI"],
  [/^apps\/api\/src\/(app|auth|queues|appport-routes|appport-runtime|server|main|index)\.ts$/, "C", "HTTP server, sessions/CSRF/rate limits, queue and AppPort host wiring"],
  [/^apps\/api\/src\//, "B", "product routes"],
  [/^apps\/worker\//, "C", "queue workers and schedules (wiring)"],
  [/^packages\/database\/migrations\//, "generated", "drizzle-kit migrations and snapshots (FeltKit derives schema changes itself)"],
  [/^packages\/database\/src\/schema\.ts$/, "B", "data model"],
  [/^packages\/database\//, "C", "database client and migrations plumbing"],
  [/^packages\/observability\//, "C", "logging and telemetry plumbing"],
  [/^packages\/integration-shopify-netsuite\/src\/(secrets|config)\.ts$/, "C", "credential encryption keyring, configuration"],
  [/^packages\/(managed|adopted-[^/]+|integrations|contracts|reliability|capabilities|provider-connections|integration-shopify-netsuite)\//, "B", "product: managed-integration logic, adopted-code hosting, providers"],
  [/^scripts\/seed\.ts$/, "D", "seeding the deployment"],
  [/^(Dockerfile|docker-compose[^/]*|Makefile|deploy\/|scripts\/|Caddyfile|\.dockerignore|\.env\.example)/, "D", "build, deploy, operations"],
  [/(^|\/)(package\.json|tsconfig[^/]*\.json|eslint\.config\.js|vitest\.config\.ts|playwright\.config\.ts|drizzle\.config\.ts|vite\.config\.ts|pnpm-workspace\.yaml|index\.html)$/, "D", "build and tool configuration"],
];

const B_RULES: Rule[] = [
  [/(^|\/)(node_modules|dist|\.feltkit)\//, "third-party", "installed or platform-generated (A: platform-owned)"],
  [/^vendor\//, "third-party", "vendored adopted applications"],
  [/^runtime\/generated\/|^feltkit\/_generated\//, "generated", "written by tools (checked)"],
  [/\.(md|png|jpg|svg|lock)$|package-lock\.json|LICENSE/, "excluded", "not code"],
  [/^(e2e|scenarios|tests)\//, "tests", "scenario drivers and browser journeys"],
  [/^runtime\/seal\.ts$/, "E", "per-workspace secret custody (FINDINGS F4)"],
  [/^scripts\/build-artifacts\.ts$/, "E", "ship build-time artifacts because a deployment carries only the build (F10)"],
  [/^runtime\/component\.ts$/, "C", "component plumbing: routes, tickets, work loop (provider-signed webhooks there: F5)"],
  [/^runtime\/upstream\.d\.ts$/, "D", "type declarations"],
  [/^runtime\//, "B", "integration runtime: providers, adopted-code execution and hosting, maintenance work"],
  [/^feltkit\//, "B", "domain functions and data model"],
  [/^src\//, "B", "product UI"],
  [/^scripts\//, "D", "reset for scenario runs"],
  [/(^|\/)(package\.json|tsconfig\.json|vite\.config\.ts|feltkit\.measure\.json|index\.html|\.gitignore|\.env\.local\.example|feltkit\.scaffold\.json)$/, "D", "build and tool configuration"],
  [/^public\//, "excluded", "static assets"],
];

function loc(path: string): number {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  if (/\.(json|ya?ml)$/.test(path)) return text.split("\n").filter((l) => l.trim()).length;
  let n = 0;
  let block = false;
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (block) {
      if (l.includes("*/")) block = false;
      continue;
    }
    if (!l || l.startsWith("//") || l.startsWith("#") && /\.(sh|ya?ml|Dockerfile)$|Makefile|Dockerfile/.test(path)) continue;
    if (l.startsWith("/*")) {
      if (!l.includes("*/")) block = true;
      continue;
    }
    if (l.startsWith("*")) continue;
    n++;
  }
  return n;
}

function measure(root: string, rules: Rule[], prefix = "") {
  const files = execSync(`git ls-files --cached --others --exclude-standard ${root}`, { cwd: process.cwd() }).toString().trim().split("\n").filter(Boolean);
  const totals: Record<string, number> = {};
  const byRule: Record<string, { cat: Cat; files: number; loc: number }> = {};
  const unmatched: string[] = [];
  for (const f of files) {
    const rel = prefix ? f.slice(prefix.length) : f;
    const rule = rules.find(([re]) => re.test(rel));
    if (!rule) {
      unmatched.push(rel);
      continue;
    }
    const n = loc(f);
    totals[rule[1]] = (totals[rule[1]] ?? 0) + n;
    const key = `${rule[1]} · ${rule[2]}`;
    byRule[key] ??= { cat: rule[1], files: 0, loc: 0 };
    byRule[key]!.files++;
    byRule[key]!.loc += n;
  }
  return { totals, byRule, unmatched };
}

const A = measure(".", A_RULES);
const B = measure("systems/b", B_RULES, "systems/b/");
const out = { at: new Date().toISOString(), commit: execSync("git rev-parse --short HEAD").toString().trim(), A, B };
mkdirSync("docs/evidence/runs/economics", { recursive: true });
writeFileSync("docs/evidence/runs/economics/loc.json", JSON.stringify(out, null, 2));
const row = (s: typeof A, c: Cat) => s.totals[c] ?? 0;
console.log("category        A        B");
for (const c of ["B", "C", "D", "E", "tests", "S1-only", "analysis", "generated", "third-party"] as Cat[]) console.log(`${c.padEnd(12)} ${String(row(A, c)).padStart(7)} ${String(row(B, c)).padStart(8)}`);
console.log("unmatched A:", A.unmatched.slice(0, 15), A.unmatched.length);
console.log("unmatched B:", B.unmatched.slice(0, 15), B.unmatched.length);
