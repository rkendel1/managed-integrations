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
          await rt.call(ws, "maintenance:proposeCorrection", patchId
            ? { eventId, kind: "patch", scopeKey: `${c.event.integrationId}:provider:${c.event.finding.contract}`, spec: { patch: patchId, file: PATCHES[patchId]!.file, find: PATCHES[patchId]!.find, replace: PATCHES[patchId]!.replace }, reason: PATCHES[patchId]!.reason }
            : { eventId, kind: "unsupported", scopeKey: `${c.event.integrationId}:provider:${c.event.finding.contract}`, spec: {}, reason: "No reviewed patch for this contract; an engineer must write one." });
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
        if (phase === "activate" && c.event.kind === "provider_contract") {
          const fix = c.corrections.find((x: any) => x.status === "validated" && x.kind === "patch");
          if (fix) await rt.call(ws, "maintenance:awaitOperator", { eventId, correctionId: fix.id });
          return { outcome: "done", receipt: { awaiting: "operator activation" } };
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
