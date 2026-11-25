/**
 * S10 "inactive-account" (docs/experiment/SCENARIOS.md §S10), System B: a TARGET-side change on Stripe →
 * QuickBooks. The customer reorganizes their chart of accounts: a new clearing account, the one ledgerly posts
 * to made inactive; QuickBooks refuses entries to it (Intuit error 610). The transaction is held, not
 * rejected; the customer chooses the replacement among accounts of the same type; a choice that fails
 * validation (made inactive after the question was asked) is rejected and the customer is asked again; the
 * validated configuration is switched on; held work is booked once and verified; entries already in the
 * books are untouched; rollback restores the previous mapping.
 *
 * The Stripe and QuickBooks simulators are one account each for the whole run, and every ledgerly company
 * subscribes to all Stripe events: run this before S6/S7 (scripts/scenarios.sh does), and it removes its own
 * Stripe endpoint and restores the accounts it changed when it ends.
 */
import { api } from "../feltkit/_generated/api.ts";
import { B, FX, company, expect, finish, json, staff, step, theirLedgerly, wait } from "./lib.ts";

const run = Date.now().toString(36);
const stripeKey = (await json(`${FX.stripe}/__fixture/state`)).body.apiKey as string;
type Line = { Amount: number; JournalEntryLineDetail: { PostingType: string; AccountRef: { value: string } } };
type JE = { DocNumber?: string; Line: Line[] };
const entriesFor = async (eventId: string) => ((await json(`${FX.qbo}/__fixture/state`)).body.journalEntries as JE[]).filter((j) => j.DocNumber === eventId.slice(-21));
const charge = async (amount: number) => (await json(`${FX.stripe}/__fixture/charge`, { method: "POST", body: { amount } })).body as { eventId: string };
const accounts = (path: string, body: object) => json(`${FX.qbo}/__fixture/accounts${path}`, { method: "POST", body });

const theirs = await theirLedgerly(stripeKey);
for (const amount of [5_000, 7_500]) {
  const r = await charge(amount);
  expect((await theirs.process(r.eventId)).status === "booked", "their deployment did not book");
}
const co = await company("Meridian", `finance-${run}@meridian.test`);
const { c, workspace } = co;
const { ticket: st } = await c.mutation(api.connections.begin, { provider: "stripe" });
expect((await json(`${B}/rt/connect/stripe`, { method: "POST", body: { ticket: st, apiKey: stripeKey } })).status === 200, "Stripe connect");
const { ticket } = await c.mutation(api.connections.begin, { provider: "quickbooks" });
let url = `${B}/rt/connect/quickbooks?ticket=${ticket}`;
for (let hops = 0; hops < 5 && !url.endsWith("/app/connections"); hops++) url = (await fetch(url, { redirect: "manual" })).headers.get("location") ?? url;
await c.mutation(api.onboarding.discover, { kind: "ledgerly" });
const found = await wait("discovery", async () => (await c.query(api.onboarding.status)).integrations.find((i) => i.kind === "ledgerly" && i.status === "confirm"));
const cand = (found.discovery!.candidates as { id: string }[])[0]!;
await c.mutation(api.onboarding.confirm, { kind: "ledgerly", candidateId: cand.id, responsibilitiesVersion: found.responsibilities.version });
const managed = await wait("managed", async () => (await c.query(api.onboarding.status)).integrations.find((i) => i.kind === "ledgerly" && i.status === "managed"));
const integrationId = managed.integrationId!;
await wait("set up", async () => (await c.query(api.integrations.list)).integrations.find((i) => i.id === integrationId && i.status !== "checking"));
step(1, `Meridian's ledgerly integration ${integrationId} is under management (discovered from their own earlier deployment)`);

let newId = "";
try {
  const before = await charge(4_200);
  const [je0] = await wait("payment booked", async () => ((await entriesFor(before.eventId)).length ? entriesFor(before.eventId) : null));
  expect(je0!.Line.some((l) => l.JournalEntryLineDetail.AccountRef.value === "91"), "baseline entry does not use Stripe Clearing (91)");
  step(2, `Baseline: ${before.eventId} booked, its clearing line on "Stripe Clearing" (91)`);

  newId = (await accounts("", { name: `Stripe Clearing 2027 ${run}`, type: "Other Current Asset" })).body.id;
  await accounts("/deactivate", { id: "91" });
  step(3, `Target change: the customer added "Stripe Clearing 2027" (${newId}) and made "Stripe Clearing" (91) inactive`);

  const held = await charge(6_600);
  const ev = await wait("target event awaiting the customer", async () => {
    const e = (await c.query(api.maintenance.list, { integrationId })).find((x) => x.kind === "target_contract_change");
    if (!e) return null;
    const v = await c.query(api.maintenance.get, { eventId: e.id });
    return v.decision ? { ...e, view: v } : null;
  });
  const hd = (await c.query(api.deliveries.list, { integrationId })).deliveries.find((x) => x.sourceId === held.eventId)!;
  expect(hd.status === "held" && (await entriesFor(held.eventId)).length === 0, `held ${hd.status}`);
  const operator = await staff(c, workspace);
  const finding = ((await operator.query(api.maintenance.evidence, { eventId: ev.id })).event as { finding: { observed: { code: string | null }; inactiveAccounts: { qboId: string; type: string }[] } }).finding;
  expect(finding.observed.code === "610" && finding.inactiveAccounts[0]?.qboId === "91", JSON.stringify(finding));
  step(4, `${held.eventId} held (not rejected): QuickBooks refused it (${finding.observed.code}); QuickBooks' own chart confirms 91 is inactive (${finding.inactiveAccounts[0]!.type})`);

  const labels = ev.view.decision!.options.map((o) => o.label).sort();
  expect(labels.includes("Disputes Receivable") && labels.includes(`Stripe Clearing 2027 ${run}`) && !labels.includes("Stripe Clearing"), JSON.stringify(labels));
  step(5, `Customer is asked: "${ev.view.decision!.question}" — active accounts of the same type: ${JSON.stringify(labels)}`);

  // A choice that fails validation: the account was made inactive after the question was asked.
  await accounts("/deactivate", { id: "92" });
  await c.mutation(api.target.decide, { eventId: ev.id, decisionId: ev.view.decision!.id, optionId: "92" });
  const again = await wait("asked again", async () => {
    const v = await c.query(api.maintenance.get, { eventId: ev.id });
    return v.decision && v.decision.id !== ev.view.decision!.id ? v : null;
  });
  const fixes1 = (await operator.query(api.maintenance.evidence, { eventId: ev.id })).corrections as { kind: string; status: string; validation?: { checks: { name: string; result: string; detail: string }[] } }[];
  const rejected = fixes1.find((x) => x.kind === "configuration")!;
  const failed = rejected.validation!.checks.find((x) => x.result === "failed")!;
  expect(rejected.status === "rejected" && failed.name.startsWith("replacement account is active"), JSON.stringify(rejected));
  expect((await entriesFor(held.eventId)).length === 0, "booked on a rejected configuration");
  expect(JSON.stringify(again.decision!.options.map((o) => o.id)) === JSON.stringify([newId]), JSON.stringify(again.decision));
  step(6, `Customer chose Disputes Receivable, made inactive meanwhile → configuration rejected ("${failed.name}": ${failed.detail}); nothing booked; asked again with ${JSON.stringify(again.decision!.options.map((o) => o.label))}`);

  await c.mutation(api.target.decide, { eventId: ev.id, decisionId: again.decision!.id, optionId: newId });
  const done = await wait("event resolved", async () => {
    const v = await c.query(api.maintenance.get, { eventId: ev.id });
    return v.status === "completed" ? v : null;
  }, 60_000);
  expect(done.accounting!.unresolved === 0 && done.accounting!.duplicates === 0 && done.accounting!.delivered >= 1, JSON.stringify(done.accounting));
  step(7, `Resolved: ${JSON.stringify(done.accounting)}`, done.timeline.map((t) => t.text));

  const [je] = await entriesFor(held.eventId);
  expect((await entriesFor(held.eventId)).length === 1 && je!.Line.some((l) => l.JournalEntryLineDetail.PostingType === "Debit" && l.JournalEntryLineDetail.AccountRef.value === newId), JSON.stringify(je));
  const [je0b] = await entriesFor(before.eventId);
  expect(je0b!.Line.some((l) => l.JournalEntryLineDetail.AccountRef.value === "91"), "history rewritten");
  step(8, `${held.eventId} booked once, debit on the new account (${newId}); ${before.eventId} still posts to 91 (history untouched)`);

  const fixes = (await operator.query(api.maintenance.evidence, { eventId: ev.id })).corrections as { id: string; kind: string; status: string }[];
  expect(JSON.stringify(fixes.map((x) => [x.kind, x.status])) === JSON.stringify([["decision", "active"], ["configuration", "rejected"], ["decision", "active"], ["configuration", "active"]]), JSON.stringify(fixes.map((x) => [x.kind, x.status])));
  step(9, `Correction history: ${fixes.map((x) => `${x.kind}:${x.status}`).join(" → ")}`);
  expect(!/accountMap|correction|configuration|runtime|ledgerly/i.test(JSON.stringify(done)), "customer view leaks internals");

  const active = fixes.find((x) => x.kind === "configuration" && x.status === "active")!;
  await operator.mutation(api.corrections.rollback, { correctionId: active.id, reason: "rollback drill" });
  const after = await operator.query(api.corrections.inspect, { integrationId });
  const running = after.running;
  const map = after.configuration.accountMap as Record<string, { qboId: string }>;
  expect(!running.some((r) => r.startsWith("configuration:")) && Object.values(map).some((m) => m.qboId === "91") && !Object.values(map).some((m) => m.qboId === newId), JSON.stringify(after.configuration));
  expect((await c.query(api.maintenance.get, { eventId: ev.id })).accounting!.unresolved === 0, "rollback changed the event's evidence");
  step(10, "Rollback drill: the account mapping in effect is the previous one again (Stripe Clearing, 91); the event's evidence stays");
} finally {
  // Put the shared simulators back as the other scenarios expect them.
  await accounts("/activate", { id: "91" });
  await accounts("/activate", { id: "92" });
  const eps = (await json(`${FX.stripe}/v1/webhook_endpoints`, { headers: { authorization: `Bearer ${stripeKey}` } })).body.data as { id: string; url: string }[];
  for (const e of eps.filter((x) => x.url.includes(workspace))) await fetch(`${FX.stripe}/v1/webhook_endpoints/${e.id}`, { method: "DELETE", headers: { authorization: `Bearer ${stripeKey}` } });
}
finish("inactive-account");
