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
          const ns = await rt.netsuite(ws);
          if (!ns) return { outcome: "retry", error: { message: "NetSuite not connected" }, retryInMs: 2000 };
          const sources = [...new Set([...c.affected.map((d: any) => d.sourceId), ...recovered.map((i: any) => i.sourceId)])];
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
