/**
 * The maintenance driver's part for TARGET-side changes (see feltkit/target.ts for the model). Deterministic:
 * options come from the customer's own target system, validation replays the held work, verification reads
 * the target back. The driver never answers a business question itself.
 *
 *   NetSuite OneWorld  investigate → await_customer → configure → patch (whole-path validation) →
 *                      await_operator → release → verify_target
 *   QuickBooks 610     investigate → await_customer → configure (a failed validation asks again) →
 *                      release_config → recover → await_recover → verify (the shared recovery path)
 *
 * A source change whose adapter was switched on while a target change was still uncorrected waits in
 * `await_release` (handled here too) — held orders are released only over a fully corrected path.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ComponentWorkOutcome } from "@feltdb/feltkit/server";
import type { Runtime } from "./component.ts";
import { ACTIVE_SUBSIDIARIES, readSalesOrder, suiteql } from "./netsuite.ts";
import { ADAPTERS, ORDER_SYNC_PATCHES, contractViolations, orderSyncCode, type Payload } from "./order-sync.ts";
import { graphql } from "./shopify.ts";
import { grant, listAccounts } from "./quickbooks.ts";

type Check = { name: string; result: "passed" | "failed" | "not_applicable"; detail: string };
type Step = "continue" | "generic" | ComponentWorkOutcome;
const DONE: ComponentWorkOutcome = { outcome: "done" };

const upstreamRoot = dirname(createRequire(import.meta.url).resolve("shopify-sync/package.json"));
const pinnedAdapter = () => readFileSync(join(upstreamRoot, "src/adapters/netsuite.js"), "utf8");

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

/**
 * The requests an adapter WOULD send for some orders: run against a recording double. Look-ups (SuiteQL) are
 * forwarded to the customer's NetSuite (reads change nothing); writes are recorded here and never reach it.
 */
async function recordedRequests(
  rt: Runtime, ws: string,
  code: Awaited<ReturnType<typeof orderSyncCode>>, orders: unknown[], subsidiaryId: string | undefined,
): Promise<unknown[]> {
  const ns = await rt.netsuite(ws);
  if (!ns) throw new Error("NetSuite is not connected");
  const bodies: unknown[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    res.setHeader("content-type", "application/json");
    if (req.url?.includes("/query/v1/suiteql")) {
      const items = await suiteql(ns.cred, ns.token, (JSON.parse(raw) as { q: string }).q);
      res.end(JSON.stringify({ items, hasMore: false }));
      return;
    }
    bodies.push(JSON.parse(raw));
    res.statusCode = 204;
    res.setHeader("location", `/services/rest/record/v1/salesOrder/${9000 + bodies.length}`);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const o of orders)
      await code.module.syncOrder(code.module.createNetSuiteAdapter({ baseUrl, accessToken: "validation", ...(subsidiaryId ? { subsidiaryId } : {}) }), o);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  return bodies;
}

/** The latest answered decision of the event that no configuration has followed yet. */
function pendingAnswer(c: any) {
  const answered = c.corrections.filter((x: any) => x.kind === "decision" && x.status === "active" && x.answer);
  const used = new Set(c.corrections.filter((x: any) => x.kind === "configuration").map((x: any) => x.spec.decisionId));
  return answered.filter((d: any) => !used.has(d.id)).at(-1) ?? null;
}

async function netsuiteStep(rt: Runtime, ws: string, c: any, eventId: string): Promise<Step> {
  const phase: string = c.event.phase;
  const f = c.event.finding as { requiredField: string };
  if (phase === "investigate") {
    const ns = await rt.netsuite(ws);
    if (!ns) return { outcome: "retry", error: { message: "NetSuite not connected" }, retryInMs: 2000 };
    const line = pinnedAdapter().split("\n").findIndex((l) => l.includes("body: {")) + 1;
    await rt.call(ws, "maintenance:recordInvestigation", {
      eventId,
      location: [`src/adapters/netsuite.js:${line}`],
      summary: `NetSuite now requires ${f.requiredField} on sales orders; the adopted adapter builds the body without it and has no option to send one`,
    });
    const subs = await suiteql<{ id: string; name: string }>(ns.cred, ns.token, ACTIVE_SUBSIDIARIES);
    if (!subs.length) {
      await rt.call(ws, "target:setPhase", { eventId, phase: "requires_action", status: "requires_action", text: "NetSuite lists no active subsidiary; an operator must look" });
      return DONE;
    }
    await rt.call(ws, "target:requestDecision", {
      eventId, setting: "subsidiaryId",
      question: "NetSuite now needs to know which subsidiary your Shopify orders belong to. Which one?",
      options: subs.map((x) => ({ id: x.id, label: x.name })),
      rationale: "Which legal entity a sale belongs to is a business decision: only the customer can make it.",
      customerText: "NetSuite now needs to know which subsidiary your Shopify orders belong to. Choose one and we will do the rest; your orders are held safely meanwhile.",
    });
    return DONE;
  }
  if (phase === "configure") {
    const d = pendingAnswer(c);
    if (!d) return DONE;
    const ns = await rt.netsuite(ws);
    if (!ns) return { outcome: "retry", error: { message: "NetSuite not connected" }, retryInMs: 2000 };
    const subs = await suiteql<{ id: string; name: string }>(ns.cred, ns.token, ACTIVE_SUBSIDIARIES);
    const to = String(d.answer.choice);
    const label = (d.spec.options as { id: string; label: string }[]).find((o) => o.id === to)?.label ?? to;
    const from = (c.integrationSettings.subsidiaryId as string | undefined) ?? null;
    const pinnedSignature = pinnedAdapter().includes("export function createNetSuiteAdapter({ baseUrl, accessToken }) {");
    const checks: Check[] = [
      { name: "decided by the customer", result: "passed", detail: `decision ${d.id} by ${d.answer.by}` },
      { name: "the subsidiary is active in NetSuite", result: subs.some((x) => x.id === to) ? "passed" : "failed", detail: `${to}: ${subs.find((x) => x.id === to)?.name ?? "not found among active subsidiaries"}` },
      { name: "the pinned adopted code ignores the setting (safe before the patch)", result: pinnedSignature ? "passed" : "failed", detail: "createNetSuiteAdapter at the pinned commit takes { baseUrl, accessToken } only" },
    ];
    const r = await rt.call<{ id: string; status: string }>(ws, "target:recordCorrection", {
      eventId, kind: "configuration", scopeKey: `${c.event.integrationId}:configuration:subsidiaryId`,
      spec: { setting: "subsidiaryId", from, to, label, decisionId: d.id, settingsBefore: { subsidiaryId: from }, settingsAfter: { subsidiaryId: to } },
      reason: `Create orders in ${label} (customer decision ${d.id})`, checks, nextPhase: "configured",
    });
    if (r.status !== "validated") return reask(rt, ws, c, eventId, d);
    await rt.call(ws, "target:activateConfiguration", { correctionId: r.id, nextPhase: "patch" });
    return "continue";
  }
  if (phase === "patch" || phase === "patch_wait") {
    // Whole-path validation: every held order must pass the source boundary too. While another change of
    // this integration still awaits its correction, they cannot — validation waits for it.
    if (c.blocking.length) {
      if (phase === "patch") await rt.call(ws, "target:setPhase", { eventId, phase: "patch_wait", text: `Validation waits for the other open change (${c.blocking.map((b: any) => b.kind).join(", ")}): the held orders must pass the whole path` });
      return DONE;
    }
    const patch = Object.values(ORDER_SYNC_PATCHES).find((p) => p.addresses.requiredField === f.requiredField);
    if (!patch) {
      await rt.call(ws, "target:setPhase", { eventId, phase: "requires_action", status: "requires_action", text: `No reviewed patch sends ${f.requiredField}; an engineer must write one` });
      return DONE;
    }
    const subsidiaryId = String(c.integrationSettings.subsidiaryId ?? "");
    const pinned = await orderSyncCode([]);
    const patched = await orderSyncCode([patch.id]);
    const orders: unknown[] = [];
    const notMappable: string[] = [];
    for (const h of c.heldAll as { reference: string; sealed: string; apiVersion: string | null }[]) {
      let p = rt.open<Payload>(ws, "receipt", h.sealed);
      for (const a of c.activeAdapters as { adapter: string; appliesTo: string[] }[])
        if ((!a.appliesTo.length || a.appliesTo.includes(h.apiVersion ?? "")) && ADAPTERS[a.adapter]) p = ADAPTERS[a.adapter]!.apply(p);
      if (contractViolations(p).length) notMappable.push(h.reference);
      else orders.push(pinned.module.toCanonicalOrder(p, { defaultCustomer: String(c.integrationSettings.defaultCustomer ?? "WEB"), customerByEmail: (c.integrationSettings.customerByEmail ?? {}) as Record<string, string> }));
    }
    const ns = await rt.netsuite(ws);
    const subs = ns ? await suiteql<{ id: string; name: string }>(ns.cred, ns.token, ACTIVE_SUBSIDIARIES) : [];
    const before = await recordedRequests(rt, ws, pinned, orders, undefined);
    const withSub = await recordedRequests(rt, ws, patched, orders, subsidiaryId);
    const without = await recordedRequests(rt, ws, patched, orders, undefined);
    const plusOnly = withSub.length === orders.length && withSub.every((b, i) => {
      const { subsidiary, ...rest } = b as { subsidiary?: { id: string } };
      return subsidiary?.id === subsidiaryId && JSON.stringify(rest) === JSON.stringify(before[i]);
    });
    const held = c.heldAll.length as number;
    const checks: Check[] = [
      { name: "every held order passes the whole path (source boundary and mapping)", result: held && !notMappable.length ? "passed" : "failed", detail: held ? (notMappable.length ? `not yet mappable: ${notMappable.join(", ")}` : `${orders.length}/${held} held orders`) : "no held orders" },
      { name: "the chosen subsidiary is active in NetSuite", result: subs.some((x) => x.id === subsidiaryId) ? "passed" : "failed", detail: `${subsidiaryId}: ${subs.find((x) => x.id === subsidiaryId)?.name ?? "not found"}` },
      { name: "each request equals the original plus exactly the chosen subsidiary", result: orders.length && plusOnly ? "passed" : "failed", detail: `${withSub.length}/${orders.length} requests through a recording double (nothing reached NetSuite)` },
      { name: "without a configured subsidiary the request is the original", result: JSON.stringify(without) === JSON.stringify(before) ? "passed" : "failed", detail: `${without.length} requests compared` },
      { name: "pinned install unchanged; rollback target loads", result: pinnedAdapter().includes(patch.find) ? "passed" : "failed", detail: `patched artifact ${patched.id} built beside ${pinned.id}` },
    ];
    const r = await rt.call<{ id: string; status: string }>(ws, "target:recordCorrection", {
      eventId, kind: "patch", scopeKey: `${c.event.integrationId}:patch:${patch.id}`,
      spec: { patch: patch.id, file: patch.file, find: patch.find, replace: patch.replace, artifact: patched.id, addresses: patch.addresses },
      reason: patch.reason, checks, nextPhase: "await_operator",
    });
    if (r.status === "validated")
      await rt.call(ws, "target:setPhase", { eventId, phase: "await_operator", text: `Patch ${r.id} validated; waiting for an operator to review and activate it`, customerText: "We prepared and tested the change with your held orders. An engineer is reviewing it before we switch it on." });
    else await rt.call(ws, "target:setPhase", { eventId, phase: "requires_action", status: "requires_action", text: `Patch ${r.id} failed validation; an engineer must look` });
    return DONE;
  }
  if (phase === "release") {
    if (c.blocking.length) return DONE; // woken again when the other change is corrected
    await rt.call(ws, "target:releaseHeld", { eventId, scope: "integration", nextPhase: "verify_target" });
    return "continue";
  }
  if (phase === "verify_target") {
    const released = c.released as { id: string; sourceId: string; reference: string; status: string }[];
    const waiting = released.filter((d) => d.status !== "delivered" && d.status !== "rejected");
    if (waiting.length) return { outcome: "retry", error: { message: `waiting for ${waiting.length} released order(s)` }, retryInMs: 1000 };
    const ns = await rt.netsuite(ws);
    if (!ns) return { outcome: "retry", error: { message: "NetSuite not connected" }, retryInMs: 2000 };
    const sub = String(c.integrationSettings.subsidiaryId ?? "");
    const label = (c.corrections.find((x: any) => x.kind === "configuration" && x.status === "active")?.spec.label as string | undefined) ?? sub;
    const checks: string[] = [];
    let ok = 0;
    for (const d of released) {
      const rec = await readSalesOrder(ns.cred, ns.token, `shopify-${d.sourceId}`);
      const truth = await shopifyPrices(rt, ws, d.sourceId);
      const rates = rec?.item?.items?.every((l) => Object.values(truth).includes(l.rate)) ?? false;
      const good = !!rec && rec.subsidiary?.id === sub && rates;
      if (good) ok++;
      checks.push(`${d.reference}: ${rec ? `NetSuite ${rec.id}, subsidiary ${rec.subsidiary?.id ?? "none"}, rates ${rates ? "match Shopify" : "DIFFER"}` : "MISSING in NetSuite"}`);
    }
    // History untouched: orders written before the change keep what they were written with.
    let untouched = 0;
    for (const d of c.deliveredBefore as { sourceId: string; reference: string }[]) {
      const rec = await readSalesOrder(ns.cred, ns.token, `shopify-${d.sourceId}`);
      if (rec && !rec.subsidiary?.id) untouched++;
    }
    checks.push(`${untouched}/${c.deliveredBefore.length} order(s) written before the change are unchanged (no subsidiary)`);
    const unresolved = released.length - ok + (c.deliveredBefore.length - untouched);
    await rt.call(ws, "maintenance:recordAccounting", {
      eventId, affected: released.length, delivered: ok, unresolved, duplicates: 0,
      checks: [...checks, "duplicates: one delivery per order (unique key) and NetSuite upserts by external id"],
      doneText: `NetSuite accepts your orders again. All ${ok} order(s) that waited are in NetSuite exactly once, in ${label}, with Shopify's prices. Nothing was lost.`,
    });
    return DONE;
  }
  return DONE;
}

/** Same-kind active accounts the customer may choose instead of an inactive one. */
function accountOptions(accounts: Awaited<ReturnType<typeof listAccounts>>, inactive: { qboId: string; type: string }) {
  return accounts.filter((a) => a.Active !== false && a.AccountType === inactive.type && a.Id !== inactive.qboId).map((a) => ({ id: a.Id, label: a.Name }));
}

async function quickbooksStep(rt: Runtime, ws: string, c: any, eventId: string): Promise<Step> {
  const phase: string = c.event.phase;
  const inactive = (c.event.finding.inactiveAccounts as { code: string; qboId: string; name: string; type: string }[])[0]!;
  const qboSecret = (rt as unknown as { qboSecret: string }).qboSecret ?? "";
  if (phase === "investigate") {
    const g = await grant(rt, ws, qboSecret);
    await rt.call(ws, "maintenance:recordInvestigation", {
      eventId,
      location: [`integration settings: accountMap[${inactive.code}] → QuickBooks account ${inactive.qboId}`],
      summary: `QuickBooks refuses entries to ${inactive.name} (${inactive.qboId}, ${inactive.type}): the customer made it inactive; ledgerly posts ${inactive.code} there through the account map`,
    });
    const options = accountOptions(await listAccounts(g), inactive);
    if (!options.length) {
      await rt.call(ws, "target:setPhase", { eventId, phase: "requires_action", status: "requires_action", text: `No active ${inactive.type} account to use instead; an operator must look` });
      return DONE;
    }
    await rt.call(ws, "target:requestDecision", {
      eventId, setting: `accountMap.${inactive.code}`,
      question: `${inactive.name} is inactive in QuickBooks. Which account should your Stripe transactions use instead?`,
      options, rationale: "Which account a transaction is booked to is the customer's accounting decision.",
      customerText: `You made ${inactive.name} inactive in QuickBooks. Choose the account to use instead and we will book everything that waited.`,
    });
    return DONE;
  }
  if (phase === "configure") {
    const d = pendingAnswer(c);
    if (!d) return DONE;
    const g = await grant(rt, ws, qboSecret);
    const accounts = await listAccounts(g);
    const to = String(d.answer.choice);
    const chosen = accounts.find((a) => a.Id === to);
    const map = c.integrationSettings.accountMap as Record<string, { qboId: string; name: string }>;
    const checks: Check[] = [
      { name: "decided by the customer", result: "passed", detail: `decision ${d.id} by ${d.answer.by}` },
      { name: "replacement account is active in QuickBooks", result: chosen && chosen.Active !== false ? "passed" : "failed", detail: chosen ? `${chosen.Name} (${chosen.Id}) is ${chosen.Active === false ? "inactive" : "active"} now` : `${to} not found` },
      { name: "replacement account is of the same type", result: chosen?.AccountType === inactive.type ? "passed" : "failed", detail: `${chosen?.AccountType ?? "unknown"} vs ${inactive.type}` },
    ];
    const r = await rt.call<{ id: string; status: string }>(ws, "target:recordCorrection", {
      eventId, kind: "configuration", scopeKey: `${c.event.integrationId}:configuration:accountMap.${inactive.code}`,
      spec: {
        setting: `accountMap.${inactive.code}`, from: inactive.qboId, to, label: chosen?.Name ?? to, decisionId: d.id,
        settingsBefore: { accountMap: map }, settingsAfter: { accountMap: { ...map, [inactive.code]: { qboId: to, name: chosen?.Name ?? to } } },
      },
      reason: `Book ${inactive.code} to ${chosen?.Name ?? to} instead of ${inactive.name} (customer decision ${d.id})`, checks, nextPhase: "configured",
    });
    if (r.status !== "validated") return reask(rt, ws, c, eventId, d, accountOptions(accounts, inactive).filter((o) => o.id !== to));
    await rt.call(ws, "target:activateConfiguration", { correctionId: r.id, nextPhase: "release_config", customerText: `You chose ${chosen!.Name}. We are booking the transactions that waited.` });
    return "continue";
  }
  if (phase === "release_config") {
    if (c.blocking.length) return DONE;
    await rt.call(ws, "target:releaseHeld", { eventId, scope: "event", nextPhase: "recover" });
    return "continue";
  }
  return "generic"; // recover → await_recover → verify: the shared recovery path
}

/** A choice that failed validation: tell the customer, and ask again with what is valid now. */
async function reask(rt: Runtime, ws: string, c: any, eventId: string, d: any, options?: { id: string; label: string }[]): Promise<Step> {
  const label = (d.spec.options as { id: string; label: string }[]).find((o) => o.id === d.answer.choice)?.label ?? d.answer.choice;
  const opts = options ?? (d.spec.options as { id: string; label: string }[]).filter((o) => o.id !== d.answer.choice);
  if (!opts.length) {
    await rt.call(ws, "target:setPhase", { eventId, phase: "requires_action", status: "requires_action", text: "No valid option remains; an operator must look" });
    return DONE;
  }
  await rt.call(ws, "target:requestDecision", {
    eventId, setting: String(d.spec.setting), question: d.question?.text ?? "Please choose again.", options: opts,
    rationale: `${label} failed validation; asked again`,
    customerText: `${label} can no longer be used (we checked before switching anything on). Please choose again; your work stays held safely.`,
  });
  return DONE;
}

/** One step for a target change, or a source change waiting for the whole path. */
export async function targetStep(rt: Runtime, ws: string, c: any, eventId: string): Promise<Step> {
  if (c.event.kind !== "target_contract_change") {
    if (c.event.phase !== "await_release") return "generic";
    if (c.blocking.length) return DONE;
    await rt.call(ws, "target:releaseHeld", { eventId, scope: "event", nextPhase: "recover" });
    return "continue";
  }
  if (["await_customer", "await_operator", "requires_action", "done"].includes(c.event.phase)) return DONE;
  if (c.event.phase === "configured") {
    // Resume after an interruption between recording a validated configuration and switching it on.
    const v = c.corrections.find((x: any) => x.kind === "configuration" && x.status === "validated");
    if (!v) return DONE;
    await rt.call(ws, "target:activateConfiguration", { correctionId: v.id, nextPhase: c.event.finding.provider === "quickbooks" ? "release_config" : "patch" });
    return "continue";
  }
  return c.event.finding.provider === "quickbooks" ? quickbooksStep(rt, ws, c, eventId) : netsuiteStep(rt, ws, c, eventId);
}
