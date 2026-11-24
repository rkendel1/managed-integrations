/**
 * S6 "stripe" (docs/experiment/SCENARIOS.md §S6), System B: Stripe → QuickBooks with the adopted ledgerly code.
 * Connect, put under management, book a payment once and balanced, check independently; a provider-retired
 * dependency (QuickBooks minorversion 70) is found in the running code, patched, validated by replay and
 * activated by an operator, then verified on a real posting; QuickBooks access is revoked: work is held, one
 * Stripe event is lost in transit; the customer reconnects; everything is booked exactly once.
 */
import { api } from "../feltkit/_generated/api.ts";
import { B, FX, company, expect, finish, json, staff, step, wait } from "./lib.ts";

const run = Date.now().toString(36);
const stripeKey = (await json(`${FX.stripe}/__fixture/state`)).body.apiKey as string;
type JE = { DocNumber?: string; PrivateNote: string; Line: { Amount: number; JournalEntryLineDetail: { PostingType: string } }[] };
const qbo = async () => (await json(`${FX.qbo}/__fixture/state`)).body as { journalEntries: JE[]; requestLog: { method: string; path: string; minorRequested: number | null; minorServed: number | null }[] };
const entriesFor = async (eventId: string) => (await qbo()).journalEntries.filter((j) => j.DocNumber === eventId.slice(-21));

const lumen = await company("Lumen", `finance-${run}@lumen.test`);
const { c, workspace } = lumen;
const { ticket: st } = await c.mutation(api.connections.begin, { provider: "stripe" });
const sc = await json(`${B}/rt/connect/stripe`, { method: "POST", body: { ticket: st, apiKey: stripeKey } });
expect(sc.status === 200, `Stripe connect ${sc.status} ${JSON.stringify(sc.body)}`);
step("B3", `Stripe connected with a restricted key → ${sc.body.status} (${sc.body.account})`);

async function connectQuickBooks() {
  const { ticket } = await c.mutation(api.connections.begin, { provider: "quickbooks" });
  let url = `${B}/rt/connect/quickbooks?ticket=${ticket}`;
  for (let hops = 0; hops < 5; hops++) {
    const r = await fetch(url, { redirect: "manual" });
    const loc = r.headers.get("location");
    if (!loc) throw new Error(`QuickBooks connect stopped at ${r.status}: ${await r.text()}`);
    if (loc.endsWith("/app/connections")) return loc;
    url = loc;
  }
  throw new Error("too many redirects");
}
step("B3b", `QuickBooks connected through OAuth → back to ${await connectQuickBooks()}`);

const integrationId = await c.mutation(api.ledgerly.adopt, {});
await wait("set up (account map, Stripe endpoint)", async () => (await c.query(api.integrations.list)).integrations.find((i) => i.id === integrationId && i.status !== "checking"));
step("B6", `Under management: ${integrationId} running ${(await c.query(api.integrations.list)).integrations.find((i) => i.id === integrationId)!.upstream.repository}`);

const pay = (await json(`${FX.stripe}/__fixture/charge`, { method: "POST", body: { amount: 8800, fee: 285 } })).body as { eventId: string };
const [je] = await wait("payment booked", async () => {
  const e = await entriesFor(pay.eventId);
  return e.length ? e : null;
});
const sum = (t: string) => je!.Line.filter((l) => l.JournalEntryLineDetail.PostingType === t).reduce((a, l) => a + l.Amount, 0);
expect(Math.abs(sum("Debit") - 88) < 0.001 && Math.abs(sum("Credit") - 88) < 0.001, `unbalanced: ${sum("Debit")} / ${sum("Credit")}`);
step("B7", `Payment ${pay.eventId} booked once by the adopted code: debits ${sum("Debit").toFixed(2)} = credits ${sum("Credit").toFixed(2)}`);

const r1 = await c.mutation(api.reconcile.start, { integrationId });
const run1 = await wait("independent check", async () => (await c.query(api.reconcile.runs, { integrationId })).runs.find((r) => r.id === r1.runId && r.status === "completed"));
expect(!run1.counts.missing_delivery && !run1.counts.failed_delivery, `check: ${JSON.stringify(run1.counts)}`);
step("B8", `Independent check (Stripe Events API vs deliveries and QuickBooks): ${JSON.stringify(run1.counts)}`);

const operator = await staff(c, workspace);
const validated = await wait("the patch validated by maintenance", async () => {
  const x = await operator.query(api.corrections.inspect, { integrationId });
  const p = x.corrections.find((r) => r.kind === "patch");
  return p?.status === "validated" ? { x, p } : null;
}, 60_000);
const ev = (await operator.query(api.maintenance.list, { integrationId }))[0]!;
const ef = (await operator.query(api.maintenance.evidence, { eventId: ev.id })).event.finding as { summary: string; at: string; source: string };
step("P1", `Detected by reading the running code: ${ef.summary} (at ${ef.at}; ${ef.source})`);
step("P1b", `Validation: ${(validated.p.validation as { checks: { name: string; result: string }[] }).checks.map((k) => `${k.name}: ${k.result}`).join("; ")}`);
await operator.mutation(api.corrections.activate, { correctionId: validated.p.id, reason: "Reviewed: declare the minor version QuickBooks serves" });
const pay2 = (await json(`${FX.stripe}/__fixture/charge`, { method: "POST", body: { amount: 3100 } })).body as { eventId: string };
await wait("next payment on the patched code", async () => (await entriesFor(pay2.eventId)).length === 1);
const active = await wait("post-activation verification", async () => {
  const x = await operator.query(api.corrections.inspect, { integrationId });
  const p = x.corrections.find((r) => r.id === validated.p.id)!;
  return p.postActivation ? { x, p } : null;
});
step("P2", `Operator activated the patch: ${active.p.history.map((h) => h.to).join(" → ")}; running ${active.x.running.join(", ")}`);
const lastPost = (await qbo()).requestLog.filter((r) => r.method === "POST" && r.path.endsWith("/journalentry")).at(-1)!;
expect(lastPost.minorRequested === 75, `QuickBooks request declares ${lastPost.minorRequested}`);
step("P3", `QuickBooks request now declares minorversion ${lastPost.minorRequested} (served ${lastPost.minorServed}); after activation: ${JSON.stringify(active.p.postActivation)}`);

await json(`${FX.qbo}/__fixture/revoke`, { method: "POST", body: {} });
const held = (await json(`${FX.stripe}/__fixture/charge`, { method: "POST", body: { amount: 15000 } })).body as { eventId: string };
const needs = await wait("the customer to be asked", async () => (await c.query(api.integrations.list)).integrations.find((i) => i.id === integrationId && i.status === "customer_action"));
await json(`${FX.stripe}/__fixture/drop-webhooks`, { method: "POST", body: { n: 1 } });
const lost = (await json(`${FX.stripe}/__fixture/charge`, { method: "POST", body: { amount: 2200 } })).body as { eventId: string };
const access = (await c.query(api.maintenance.list, { integrationId })).find((e) => e.kind === "authorization_lost")!;
const asked = await c.query(api.maintenance.get, { eventId: access.id });
step("B9", `Simulator: Intuit revokes access. Customer sees "${asked.headline}" (status ${needs.status}); ${held.eventId} is held; ${lost.eventId} is lost in transit`);
expect((await entriesFor(held.eventId)).length === 0, "held payment booked while access was down");

step("B9b", `Customer reconnects QuickBooks → ${await connectQuickBooks()}`);
const done = await wait("the access event to resolve", async () => {
  const e = await c.query(api.maintenance.get, { eventId: access.id });
  return e.status === "completed" ? e : null;
}, 60_000);
step("B10", `"${done.timeline.at(-1)!.text}"`, done.accounting);
expect(done.accounting?.unresolved === 0 && done.accounting.duplicates === 0 && done.accounting.affected === 2, `accounting ${JSON.stringify(done.accounting)}`);
for (const e of [held.eventId, lost.eventId]) expect((await entriesFor(e)).length === 1, `${e} not booked exactly once`);
step("B10b", "Both transactions are in QuickBooks exactly once (the held one and the one whose webhook was lost)");
finish("stripe");
