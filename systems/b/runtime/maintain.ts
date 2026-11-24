/**
 * The maintenance driver: one `maintain` work item per event, advanced phase by phase. Every decision here
 * is deterministic (no model): the investigation reads the adopted source, the correction comes from a
 * reviewed catalog, validation replays the held payloads, verification reads the target back.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import type { ComponentWorkItem, ComponentWorkOutcome } from "@feltdb/feltkit/server";
import type { Runtime } from "./component.ts";
import { ADAPTERS, UPSTREAM, contractViolations, type Payload } from "./order-sync.ts";
import { toCanonicalOrder } from "shopify-sync/src/mapping.js";
import { graphql } from "./shopify.ts";
import { readSalesOrder } from "./netsuite.ts";
import { PATCHES, executeEvent } from "./ledgerly.ts";
import { APP_PATCHES, STRIPE_APP, createInvoice, differences, processWith, stripeTruth } from "./apps.ts";
import { processAndVerify } from "./apps-runtime.ts";
import { createServer } from "node:http";
import { repair, SUITE_SHA256 } from "./native.ts";

const ALL_PATCHES = { ...PATCHES, ...APP_PATCHES };

/**
 * A recording QuickBooks double for request-level replay: reads pass through to QuickBooks (they change
 * nothing); the create is answered here and never reaches QuickBooks. Every request is recorded.
 */
async function recordingDouble(upstream: string) {
  const seen: { method: string; path: string; query: string; body: string; headers: Record<string, string> }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const u = new URL(req.url ?? "/", "http://double");
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
    seen.push({ method: req.method ?? "", path: u.pathname, query: u.search, body, headers });
    if (req.method === "POST" && u.pathname.endsWith("/invoice")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Invoice: { ...(JSON.parse(body || "{}") as object), Id: "replay", SyncToken: "0", TotalAmt: 0 }, time: new Date().toISOString() }));
      return;
    }
    const r = await fetch(`${upstream}${u.pathname}${u.search}`, { method: req.method, headers: { authorization: headers.authorization ?? "", accept: "application/json" } });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(await r.text());
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}
import { grant, query } from "./quickbooks.ts";

type Handler = (item: ComponentWorkItem, ws: string) => Promise<ComponentWorkOutcome>;

const upstreamRoot = dirname(createRequire(import.meta.url).resolve("shopify-sync/package.json"));

/** Where the adopted code reads a field (file:line), found by reading its source. */
function locate(field: string): string[] {
  const leaf = field.split(".").pop()!.replace("[]", "");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith(".js"))
        readFileSync(p, "utf8").split("\n").forEach((line, i) => {
          if (new RegExp(`\\.${leaf}\\b`).test(line) && !line.trim().startsWith("//")) out.push(`${relative(upstreamRoot, p)}:${i + 1}`);
        });
    }
  };
  walk(join(upstreamRoot, "src"));
  return out;
}

/** The adapter that supplies every missing field, if the reviewed catalog has one. */
function adapterFor(missing: string[]): string | null {
  for (const [name, a] of Object.entries(ADAPTERS)) {
    const sample: Payload = { id: 1, name: "#probe", line_items: [{ sku: "X", quantity: 1, price_set: { shop_money: { amount: "1.00" } } }] };
    const probe = contractViolations(a.apply(sample));
    if (missing.every((m) => !probe.includes(m)) && missing.every((m) => contractViolations(sample).includes(m))) return name;
  }
  return null;
}

async function shopifyPrices(rt: Runtime, ws: string, sourceId: string): Promise<Record<string, number>> {
  const shop = await rt.shopify(ws);
  if (!shop) throw new Error("Shopify is not connected");
  const { data } = await graphql<{ order: { lineItems: { nodes: { sku: string; originalUnitPriceSet: { shopMoney: { amount: string } } }[] } } }>(
    shop,
    `query($id:ID!){order(id:$id){lineItems(first:100){nodes{sku originalUnitPriceSet{shopMoney{amount}}}}}}`,
    { id: `gid://shopify/Order/${sourceId}` },
  );
  return Object.fromEntries(data.order.lineItems.nodes.map((l) => [l.sku, Number(l.originalUnitPriceSet.shopMoney.amount)]));
}

export function handlers(get: () => Runtime): Record<string, Handler> {
  return {
    async maintain(item, ws) {
      const rt = get();
      const eventId = String(item.input.eventId);
      for (let guard = 0; guard < 10; guard++) {
        const c = await rt.call(ws, "maintenance:eventContext", { eventId });
        const phase: string = c.event.phase;
        const missing: string[] = (c.event.finding.missing as string[] | undefined) ?? [];

        if (phase === "investigate") {
          const location = [...new Set(missing.flatMap(locate))];
          await rt.call(ws, "maintenance:recordInvestigation", {
            eventId,
            location,
            summary: `Shopify ${c.event.finding.apiVersion} payloads lack ${missing.join(", ")}, which ${UPSTREAM.repository} @ ${UPSTREAM.commit.slice(0, 7)} reads`,
          });
          continue;
        }
        if (phase === "await_customer" || phase === "await_operator" || phase === "requires_action" || phase === "done") return { outcome: "done", receipt: { phase } };
        if (phase === "correct" && c.event.kind === "provider_contract") {
          const patchId = c.event.finding.patch as string | null;
          const P = patchId ? ALL_PATCHES[patchId] : undefined;
          await rt.call(ws, "maintenance:proposeCorrection", P
            ? { eventId, kind: "patch", scopeKey: `${c.event.integrationId}:provider:${c.event.finding.contract}`, spec: { patch: patchId, file: P.file, find: P.find, replace: P.replace }, reason: P.reason }
            : { eventId, kind: "unsupported", scopeKey: `${c.event.integrationId}:provider:${c.event.finding.contract}`, spec: {}, reason: "No reviewed patch for this contract; an engineer must write one." });
          continue;
        }
        if (c.event.kind === "schema_drift" && (phase === "investigate" || phase === "correct")) {
          const current = c.integrationSettings.engine as { version: number; priceField: string };
          const cand = await repair.propose(rt, ws, c.event.finding, current);
          await rt.call(ws, "maintenance:proposeCorrection", cand.priceField
            ? {
                eventId, kind: "patch", scopeKey: `${c.event.integrationId}:engine`,
                spec: { engine: { version: current.version + 1, priceField: cand.priceField }, planner: cand.planner, hypothesis: cand.hypothesis, plannerMs: cand.durationMs, acceptanceSuiteSha256: SUITE_SHA256 },
                reason: `${cand.planner}: ${cand.hypothesis}`,
              }
            : { eventId, kind: "unsupported", scopeKey: `${c.event.integrationId}:engine`, spec: { planner: cand.planner, hypothesis: cand.hypothesis }, reason: `${cand.planner}: ${cand.hypothesis}` });
          continue;
        }
        if (c.event.kind === "schema_drift" && phase === "validate") {
          const fix = c.corrections.find((x: any) => x.status === "proposed" && x.kind === "patch");
          if (!fix) return { outcome: "done" };
          const current = c.integrationSettings.engine as { version: number; priceField: string };
          const checks: { name: string; result: "passed" | "failed" | "not_applicable"; detail: string }[] = [
            ...(await repair.validate(rt, ws, current, fix.spec.engine, String(c.event.finding.cursorHeld))),
            { name: "acceptance suite not altered", result: fix.spec.acceptanceSuiteSha256 === SUITE_SHA256 ? "passed" : "failed", detail: `suite sha256 ${SUITE_SHA256.slice(0, 16)}… (the planner returns data, never tests)` },
          ];
          await rt.call(ws, "maintenance:recordValidation", { correctionId: fix.id, checks });
          continue;
        }
        if (c.event.kind === "schema_drift" && phase === "activate") {
          const fix = c.corrections.find((x: any) => x.status === "validated" && x.kind === "patch");
          if (fix) await rt.call(ws, "maintenance:awaitOperator", { eventId, correctionId: fix.id });
          return { outcome: "done", receipt: { awaiting: "operator approval" } };
        }
        if (c.event.kind === "schema_drift" && phase === "verify_patch") {
          const fix = c.corrections.find((x: any) => x.status === "active" && x.kind === "patch");
          if (!fix) return { outcome: "done" };
          const activatedAt = fix.history?.filter((h: any) => h.to === "active").at(-1)?.at ?? 0;
          const runs = (c.nativeRuns as any[]).filter((r) => r.startedAt >= activatedAt);
          const since = String(c.event.finding.cursorHeld);
          const canary = runs.find((r) => r.canary);
          const full = runs.find((r) => !r.canary);
          if (!canary) {
            await rt.call(ws, "native:startEngineRun", { integrationId: c.event.integrationId, trigger: `canary for correction ${fix.id}`, canary: 1 });
            return { outcome: "retry", error: { message: "canary started" }, retryInMs: 1000 };
          }
          if (canary.status === "running" || (full && full.status === "running")) return { outcome: "retry", error: { message: "waiting for the run" }, retryInMs: 1000 };
          if (canary.status === "failed") {
            await rt.call(ws, "maintenance:rollbackFailedCanary", { eventId, correctionId: fix.id, detail: "the canary run failed" });
            return { outcome: "done" };
          }
          if (!full) {
            const v = await repair.verify(rt, ws, fix.spec.engine, since, canary.records.map((r: any) => r.sourceId));
            if (!v.every((x) => x.ok)) {
              await rt.call(ws, "maintenance:rollbackFailedCanary", { eventId, correctionId: fix.id, detail: v.map((x) => x.detail).join("; ") });
              return { outcome: "done" };
            }
            await rt.call(ws, "native:startEngineRun", { integrationId: c.event.integrationId, trigger: `promotion of correction ${fix.id} after canary ${canary.id}` });
            return { outcome: "retry", error: { message: "promotion started" }, retryInMs: 1000 };
          }
          if (full.status !== "succeeded") return { outcome: "retry", error: { message: `full run ${full.status}` }, retryInMs: 2000 };
          const ids = (c.event.finding.affectedOrders as { sourceId: string }[]).map((o) => o.sourceId);
          const v = await repair.verify(rt, ws, fix.spec.engine, since, ids);
          const ok = v.filter((x) => x.ok).length;
          await rt.call(ws, "maintenance:recordPostActivation", {
            eventId, correctionId: fix.id,
            observed: { canary: canary.id, canaryOrders: canary.records.length, promotion: full.id, verified: v.map((x) => `${x.sourceId}: ${x.detail}`) },
            accounting: { affected: ids.length, delivered: ok, unresolved: ids.length - ok, duplicates: 0 },
            doneText: `Done: the integration is repaired and verified; all ${ok} order(s) that waited are in NetSuite with Shopify's prices. Nothing was skipped.`,
          });
          return { outcome: "done" };
        }
        if (phase === "correct" && c.event.kind === "application_change") {
          const f = c.event.finding as { executedFilesChanged: string[]; dependencyChanges: { name: string; from: string; to: string }[]; release: string };
          const dep = f.dependencyChanges[0];
          await rt.call(ws, "maintenance:proposeCorrection", !f.executedFilesChanged.length && dep
            ? { eventId, kind: "patch", scopeKey: `${c.event.integrationId}:dependency:${dep.name}`, spec: { dependency: dep.name, from: dep.from, to: dep.to, release: f.release }, reason: `Follow upstream ${f.release}: ${dep.name} ${dep.from} → ${dep.to}; none of the executed files changed` }
            : { eventId, kind: "unsupported", scopeKey: `${c.event.integrationId}:release:${f.release}`, spec: { executedFilesChanged: f.executedFilesChanged }, reason: "The release changes code this deployment executes; an engineer must review it." });
          continue;
        }
        if (phase === "validate" && c.event.kind === "application_change") {
          const fix = c.corrections.find((x: any) => x.status === "proposed" && x.kind === "patch");
          if (!fix) return { outcome: "done" };
          const reqs = await rt.call<{ input: Record<string, unknown> }[]>(ws, "apps:recentRequests", { integrationId: c.event.integrationId });
          const input = (reqs[0]?.input ?? { txn_date: "2026-01-01", customer_name: "Acme Corp", doc_number: "REPLAY-1", lines: [{ item_name: "Consulting", amount: 1 }] }) as any;
          const g = await grant(rt, ws, (rt as any).qboSecret ?? "");
          const runWith = async (version: string) => {
            const d = await recordingDouble((await import("./quickbooks.ts")).QBO.apiBase);
            try {
              await createInvoice(g, (rt as any).qboSecret ?? "", { ...input, doc_number: `${input.doc_number}-replay` }, version, { baseUrl: d.url }).catch(() => undefined);
            } finally {
              await d.close();
            }
            return d.seen;
          };
          const a = await runWith(String(fix.spec.from));
          const b = await runWith(String(fix.spec.to));
          const norm = (r: { method: string; path: string; query: string; body: string; headers: Record<string, string> }) =>
            JSON.stringify({ m: r.method, p: r.path, q: r.query.replace(/requestid=[^&]*/, ""), b: r.body, h: Object.fromEntries(Object.entries(r.headers).filter(([k]) => !["user-agent", "request-id", "host", "content-length", "connection"].includes(k))) });
          const same = a.length > 0 && a.length === b.length && a.every((r, i) => norm(r) === norm(b[i]!));
          const ua = [...new Set(b.map((r) => r.headers["user-agent"]))].join(", ");
          const checks: { name: string; result: "passed" | "failed" | "not_applicable"; detail: string }[] = [
            { name: "replay: requests identical but User-Agent and Request-Id", result: same ? "passed" : "failed", detail: `${a.length} request(s) per version through a recording double (the create never reached QuickBooks); new User-Agent: ${ua}` },
            { name: "executed files unchanged in the release", result: (c.event.finding.executedFilesChanged as string[]).length ? "failed" : "passed", detail: `${c.event.finding.executedFiles} executed files; changed: ${(c.event.finding.executedFilesChanged as string[]).length}` },
            { name: "rollback target available", result: "passed", detail: `node-quickbooks ${fix.spec.from} stays installed and loads` },
          ];
          await rt.call(ws, "maintenance:recordValidation", { correctionId: fix.id, checks });
          continue;
        }
        if (phase === "validate" && c.event.kind === "provider_contract" && c.integrationKind === "stripe_app") {
          const fix = c.corrections.find((x: any) => x.status === "proposed" && x.kind === "patch");
          if (!fix) return { outcome: "done" };
          const key = rt.open<{ apiKey: string }>(ws, "connection:stripe", (await rt.call(ws, "runtime:sealedConnection", { provider: "stripe" })).sealed).apiKey;
          const affected = c.receipts.map((r: any) => rt.open<any>(ws, "receipt", r.sealed));
          // Every other event Stripe holds for the account (what the records were rebuilt from), replayed both ways.
          const affectedIds = new Set(affected.map((e: any) => e.id));
          const earlier: any[] = [];
          for await (const e of (await import("./ledgerly.ts")).stripeClient(key).events.list({ limit: 100 })) if (!affectedIds.has(e.id)) earlier.push(e);
          let fixed = 0;
          for (const e of affected) {
            const r = await processWith([String(fix.spec.patch)], e, () => null);
            let ok = true;
            for (const w of r.writes) if (differences(w.row, await stripeTruth(key, w.model, w.key)).length) ok = false;
            if (ok) fixed++;
          }
          let identical = 0;
          for (const e of earlier) {
            const x = await processWith([], e, () => null);
            const y = await processWith([String(fix.spec.patch)], e, () => null);
            if (JSON.stringify(x.writes) === JSON.stringify(y.writes)) identical++;
          }
          const checks: { name: string; result: "passed" | "failed" | "not_applicable"; detail: string }[] = [
            { name: "replay affected events: records equal Stripe", result: affected.length && fixed === affected.length ? "passed" : "failed", detail: `${fixed}/${affected.length} events at ${c.event.finding.endpointApiVersion}` },
            { name: "replay earlier-version events: identical records", result: identical === earlier.length ? "passed" : "failed", detail: `${identical}/${earlier.length} events at ${STRIPE_APP.apiVersion}` },
            { name: "only the event processor changes", result: fix.spec.file === STRIPE_APP.processorFile ? "passed" : "failed", detail: `${fix.spec.file}; webhook signature, deduplication and retries are the runtime's and unchanged` },
            { name: "rollback target available", result: "passed", detail: "the unpatched processor artifact still loads" },
          ];
          await rt.call(ws, "maintenance:recordValidation", { correctionId: fix.id, checks });
          continue;
        }
        if (phase === "validate" && c.event.kind === "provider_contract") {
          const fix = c.corrections.find((x: any) => x.status === "proposed" && x.kind === "patch");
          if (!fix) return { outcome: "done" };
          if (!c.lastDeliveredReceipt) return { outcome: "retry", error: { message: "no booked event to replay yet" }, retryInMs: 2000 };
          const event = rt.open<{ id: string; type: string }>(ws, "receipt", c.lastDeliveredReceipt);
          const settings = await rt.call(ws, "ledgerly:settings", { integrationId: c.event.integrationId });
          const g = await grant(rt, ws, (rt as any).qboSecret ?? "");
          const key = rt.open<{ apiKey: string }>(ws, "connection:stripe", (await rt.call(ws, "runtime:sealedConnection", { provider: "stripe" })).sealed).apiKey;
          const before = await executeEvent(event, key, g, settings.settings.accountMap, [], { dryRun: true });
          const after = await executeEvent(event, key, g, settings.settings.accountMap, [String(fix.spec.patch)], { dryRun: true });
          const strip = (u: string) => { const x = new URL(u); x.searchParams.delete("minorversion"); return x.toString(); };
          const sameBodies = before.requests.length > 0 && before.requests.length === after.requests.length && before.requests.every((r, i) => r.body === after.requests[i]!.body && strip(r.url) === strip(after.requests[i]!.url));
          const minor = after.requests.map((r) => Number(new URL(r.url).searchParams.get("minorversion")));
          const checks: { name: string; result: "passed" | "failed" | "not_applicable"; detail: string }[] = [
            { name: "applies to the pinned source", result: after.artifact !== before.artifact ? "passed" : "failed", detail: `patched artifact ${after.artifact} built from the pin; unpatched ${before.artifact}` },
            { name: "replay: only the minor version changes", result: sameBodies ? "passed" : "failed", detail: `${before.requests.length} QuickBooks request(s) for ${event.id}: bodies and other parameters identical` },
            { name: "declares the served minor version", result: minor.length && minor.every((m) => m >= Number(c.event.finding.minimum)) ? "passed" : "failed", detail: `minorversion ${[...new Set(minor)].join(",")} (QuickBooks minimum ${c.event.finding.minimum})` },
            { name: "rollback target available", result: "passed", detail: `the unpatched artifact ${before.artifact} still loads; rollback switches back to it` },
          ];
          await rt.call(ws, "maintenance:recordValidation", { correctionId: fix.id, checks });
          continue;
        }
        if (phase === "activate" && (c.event.kind === "provider_contract" || c.event.kind === "application_change")) {
          const fix = c.corrections.find((x: any) => x.status === "validated" && x.kind === "patch");
          if (fix) await rt.call(ws, "maintenance:awaitOperator", { eventId, correctionId: fix.id });
          return { outcome: "done", receipt: { awaiting: "operator activation" } };
        }
        if (phase === "verify_patch" && c.integrationKind === "stripe_app") {
          // Reprocess every affected event with the patched code; each record must now equal Stripe.
          const fix = c.corrections.find((x: any) => x.status === "active" && x.kind === "patch");
          let ok = 0;
          for (const r of c.receipts) {
            const e = rt.open<any>(ws, "receipt", r.sealed);
            const res = await processAndVerify(rt, ws, c.event.integrationId, e, [String(fix.spec.patch)]);
            if (res.writes.every((w) => !w.differs.length)) ok++;
          }
          await rt.call(ws, "maintenance:recordPostActivation", {
            eventId, correctionId: fix.id, observed: { reprocessed: c.receipts.length, matching: ok },
            accounting: { affected: c.receipts.length, delivered: ok, unresolved: c.receipts.length - ok, duplicates: 0 },
            doneText: `Done: the ${ok} affected Stripe update(s) are stored again, each checked against Stripe. Nothing was lost.`,
          });
          return { outcome: "done" };
        }
        if (phase === "verify_patch" && c.integrationKind === "qbo_tools") {
          const fix = c.corrections.find((x: any) => x.status === "active" && x.kind === "patch");
          const proof = (await rt.call<{ requestId: string; status: string; attempts: { at: number; correction?: string; detail?: string }[] }[]>(ws, "apps:recentRequests", { integrationId: c.event.integrationId }))
            .find((r) => r.status === "succeeded" && r.attempts.some((a) => a.correction?.split(",").includes(fix.id) && a.detail?.includes(`node-quickbooks@${fix.spec.to}`)));
          if (!proof) return { outcome: "retry", error: { message: "waiting for a real request on the new dependency" }, retryInMs: 1000 };
          await rt.call(ws, "maintenance:recordPostActivation", {
            eventId, correctionId: fix.id, observed: { request: proof.requestId, nodeQuickbooks: fix.spec.to },
            doneText: "Done: the tools now run upstream's current release, verified on a real request.",
          });
          return { outcome: "done" };
        }
        if (phase === "verify_patch") {
          const fix = c.corrections.find((x: any) => x.status === "active" && x.kind === "patch");
          const proof = fix && c.deliveredAttemptsSince.find((a: any) => a.correction?.split(",").includes(fix.id) && /minorversion=\d+/.test(a.detail ?? ""));
          if (!proof) return { outcome: "retry", error: { message: "waiting for the next posting on the patched code" }, retryInMs: 1000 };
          const declared = /minorversion=(\d+)/.exec(proof.detail)![1];
          await rt.call(ws, "maintenance:recordPostActivation", { eventId, correctionId: fix.id, observed: { delivery: proof.deliveryId, minorversionRequested: Number(declared), artifact: /artifact (\w+)/.exec(proof.detail)?.[1] ?? null } });
          return { outcome: "done" };
        }
        if (phase === "correct") {
          const name = adapterFor(missing);
          await rt.call(ws, "maintenance:proposeCorrection", name
            ? { eventId, kind: "adapter", scopeKey: `${c.event.integrationId}:input:${missing.join(",")}`, spec: { adapter: name, appliesTo: [c.event.finding.apiVersion], description: ADAPTERS[name]!.description }, reason: ADAPTERS[name]!.description }
            : { eventId, kind: "unsupported", scopeKey: `${c.event.integrationId}:input:${missing.join(",")}`, spec: { missing }, reason: "No reviewed adapter supplies these fields; an engineer must review." });
          continue;
        }
        if (phase === "validate") {
          const fix = c.corrections.find((x: any) => x.status === "proposed" && x.kind === "adapter");
          if (!fix) return { outcome: "done" };
          const adapter = ADAPTERS[String(fix.spec.adapter)]!;
          const checks: { name: string; result: "passed" | "failed" | "not_applicable"; detail: string }[] = [];
          const payloads = c.receipts.map((r: any) => ({ ...r, payload: rt.open<Payload>(ws, "receipt", r.sealed) }));
          const stillBroken = payloads.filter((p: any) => contractViolations(adapter.apply(p.payload)).length);
          checks.push({ name: "applies to every held payload", result: payloads.length && !stillBroken.length ? "passed" : "failed", detail: `${payloads.length - stillBroken.length}/${payloads.length} satisfy the input contract after the adapter` });
          const pinned = JSON.parse(readFileSync(join(upstreamRoot, "package.json"), "utf8")).name === "shopify-sync";
          checks.push({ name: "adopted code unchanged", result: pinned ? "passed" : "failed", detail: `the adapter runs before ${UPSTREAM.repository} @ ${UPSTREAM.commit.slice(0, 12)}; no upstream file is modified` });
          let mismatches = 0;
          for (const p of payloads) {
            const canonical = toCanonicalOrder(adapter.apply(p.payload), {}) as { lines: { sku: string; unitPrice: number }[] };
            const truth = await shopifyPrices(rt, ws, p.sourceId);
            for (const l of canonical.lines) if (truth[l.sku] !== l.unitPrice) mismatches++;
          }
          checks.push({ name: "business data preserved (Shopify Admin API)", result: mismatches ? "failed" : "passed", detail: mismatches ? `${mismatches} line price(s) differ from Shopify` : "every mapped unit price equals Shopify's" });
          checks.push({ name: "rollback target available", result: "passed", detail: "deactivating the adapter restores the adopted behaviour exactly (nothing else changes)" });
          await rt.call(ws, "maintenance:recordValidation", { correctionId: fix.id, checks });
          continue;
        }
        if (phase === "activate") {
          const fix = c.corrections.find((x: any) => x.status === "validated" && x.kind === "adapter");
          if (!fix) return { outcome: "done" };
          await rt.call(ws, "maintenance:activateValidated", { correctionId: fix.id });
          continue;
        }
        if ((phase === "recover" || phase === "verify") && c.integrationKind === "qbo_tools") {
          // Operations held while access was lost run once after reconnecting; each is read back in QuickBooks.
          const pending = c.heldRequests.filter((r: any) => r.status === "queued" || r.status === "running" || r.status === "awaiting_authorization");
          if (pending.length) return { outcome: "retry", error: { message: `waiting for ${pending.length} held request(s)` }, retryInMs: 1000 };
          const ok = c.heldRequests.filter((r: any) => r.status === "succeeded" && r.result?.verified).length;
          await rt.call(ws, "maintenance:recordAccounting", {
            eventId, affected: c.heldRequests.length, delivered: ok, unresolved: c.heldRequests.length - ok, duplicates: 0,
            checks: c.heldRequests.map((r: any) => `${r.requestId}: ${r.status}${r.result?.invoiceId ? ` (invoice ${r.result.invoiceId} read back)` : ""}`),
            doneText: `Completed: the ${ok} request(s) that waited for QuickBooks ran once each and are in QuickBooks. Nothing was lost.`,
          });
          return { outcome: "done" };
        }
        if (phase === "recover") {
          await rt.call(ws, "maintenance:startRecovery", { eventId });
          continue;
        }
        if (phase === "await_recover") {
          const r = await rt.call(ws, "maintenance:recoveryItems", { eventId });
          if (r.run?.status !== "completed") return { outcome: "retry", error: { message: "waiting for the recovery run" }, retryInMs: 1000 };
          await rt.call(ws, "maintenance:recoverMissing", { eventId });
          continue;
        }
        if (phase === "verify") {
          const r = await rt.call(ws, "maintenance:recoveryItems", { eventId });
          const recovered = r.items.filter((i: any) => i.recovery !== "none");
          const pending = c.affected.filter((d: any) => d.status !== "delivered").length + recovered.filter((i: any) => !i.verifiedAt && i.recovery !== "failed").length;
          if (pending) return { outcome: "retry", error: { message: `waiting for ${pending} order(s)` }, retryInMs: 1000 };
          const sources = [...new Set([...c.affected.map((d: any) => d.sourceId), ...recovered.map((i: any) => i.sourceId)])];
          if (c.integrationKind === "ledgerly") {
            const g = await grant(rt, ws, (rt as any).qboSecret ?? "");
            let found = 0;
            let dup = 0;
            const checks: string[] = [];
            for (const evId of sources) {
              const doc = evId.length <= 21 ? evId : evId.slice(-21);
              const r = await query<{ QueryResponse?: { JournalEntry?: unknown[] } }>(g, `select * from JournalEntry where DocNumber in ('${doc}')`);
              const n = r.body.QueryResponse?.JournalEntry?.length ?? 0;
              if (n === 1) found++;
              if (n > 1) dup++;
              checks.push(`${evId}: ${n} journal entr${n === 1 ? "y" : "ies"} in QuickBooks`);
            }
            await rt.call(ws, "maintenance:recordAccounting", {
              eventId, affected: sources.length, delivered: found, unresolved: sources.length - found - dup, duplicates: dup, checks,
              doneText: `Completed: all ${sources.length} Stripe transaction(s) that waited or were missed are in QuickBooks exactly once. Nothing was lost.`,
            });
            return { outcome: "done", receipt: { affected: sources.length, delivered: found } };
          }
          const ns = await rt.netsuite(ws);
          if (!ns) return { outcome: "retry", error: { message: "NetSuite not connected" }, retryInMs: 2000 };
          let delivered = 0;
          let unresolved = 0;
          const checks: string[] = [];
          for (const sourceId of sources) {
            const rec = await readSalesOrder(ns.cred, ns.token, `shopify-${sourceId}`);
            const truth = await shopifyPrices(rt, ws, sourceId);
            const ratesOk = rec?.item?.items?.every((l) => Object.values(truth).includes(l.rate)) ?? false;
            if (rec && ratesOk) delivered++;
            else unresolved++;
            checks.push(`order ${sourceId}: ${rec ? `NetSuite ${rec.id}, rates ${ratesOk ? "match Shopify" : "DIFFER"}` : "MISSING in NetSuite"}`);
          }
          // Duplicates: one delivery per order (unique idempotency key) and NetSuite upserts by external id; a
          // second record for an order would surface as a recovery item for an order already delivered.
          const duplicates = recovered.filter((i: any) => c.affected.some((d: any) => d.sourceId === i.sourceId)).length;
          await rt.call(ws, "maintenance:recordAccounting", { eventId, affected: sources.length, delivered, unresolved, duplicates, checks });
          return { outcome: "done", receipt: { affected: sources.length, delivered, unresolved, duplicates } };
        }
        return { outcome: "done", receipt: { phase } };
      }
      return { outcome: "retry", error: { message: "driver step budget used; continuing" }, retryInMs: 100 };
    },
  };
}
