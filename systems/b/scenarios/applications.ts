/**
 * S7 "applications" (docs/experiment/SCENARIOS.md §S7), System B: two applications that each depend on one
 * provider, hosted and maintained. A Stripe subscriptions app (its own records rebuilt from Stripe and checked
 * against it; a Stripe-side change that silently corrupts what it stores, corrected by a reviewed patch), and
 * QuickBooks tools (an operation run exactly once; held while access is lost; an upstream release followed after
 * request-level replay, then rolled back as a drill).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { api } from "../feltkit/_generated/api.ts";
import { B, FX, company, expect, finish, json, staff, step, wait } from "./lib.ts";

const run = Date.now().toString(36);
const stripeKey = (await json(`${FX.stripe}/__fixture/state`)).body.apiKey as string;

// Pinned sources are what was reviewed: every vendored file matches its recorded digest.
function pinned(dir: string) {
  const lines = readFileSync(`vendor/${dir}.sha256`, "utf8").trim().split("\n");
  const drift = lines.filter((l) => {
    const [digest, file] = l.split(/\s+/);
    return createHash("sha256").update(readFileSync(`vendor/${dir}/${file!.replace(/^\.\//, "")}`)).digest("hex") !== digest;
  });
  return { files: lines.length, drift: drift.length, commit: JSON.parse(readFileSync(`vendor/${dir}/PROVENANCE.json`, "utf8")).commit as string };
}
const sp = pinned("stripe-webhooks-subscriptions-node-ts");
expect(sp.drift === 0, "vendored Stripe application differs from its pin");
step("S1", `Adopted stripe-webhooks-subscriptions-node-ts @ ${sp.commit.slice(0, 12)} (MIT), vendored; ${sp.files} files pinned; match: true`);

// Before: their own deployment has a webhook endpoint at Stripe, and they have subscribers.
await fetch(`${FX.stripe}/v1/webhook_endpoints`, {
  method: "POST",
  headers: { authorization: `Bearer ${stripeKey}`, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams([["url", `https://subs-${run}.lumen.test/v1/stripe/webhook`], ["api_version", "2025-02-24.acacia"], ["enabled_events[0]", "customer.subscription.updated"], ["enabled_events[1]", "customer.subscription.created"], ["enabled_events[2]", "invoice.payment_succeeded"], ["enabled_events[3]", "invoice.payment_failed"]]).toString(),
});
const subA = (await json(`${FX.stripe}/__fixture/subscription`, { method: "POST", body: { amount: 2900 } })).body as { subscriptionId: string };
const subB = (await json(`${FX.stripe}/__fixture/subscription`, { method: "POST", body: { amount: 9900 } })).body as { subscriptionId: string };

const s = await company("LumenSubs", `ops-${run}@lumen-subs.test`);
const { ticket } = await s.c.mutation(api.connections.begin, { provider: "stripe" });
await json(`${B}/rt/connect/stripe`, { method: "POST", body: { ticket, apiKey: stripeKey } });
await s.c.mutation(api.onboarding.discover, { kind: "stripe_app" });
const sFound = await wait("discovery", async () => (await s.c.query(api.onboarding.status)).integrations.find((i) => i.kind === "stripe_app" && i.status !== "discovering"));
expect(sFound.status === "confirm", `discovery ${sFound.status}`);
const sCand = (sFound.discovery!.candidates as { id: string; summary: string }[])[0]!;
step("S2", `Discovered (one provider: Stripe): ${sCand.summary} — ${JSON.stringify((sFound.discovery!.evidence as { endpoints: unknown[] }).endpoints)}`);
await s.c.mutation(api.onboarding.confirm, { kind: "stripe_app", candidateId: sCand.id, responsibilitiesVersion: sFound.responsibilities.version });
const sManaged = await wait("the application managed", async () => (await s.c.query(api.onboarding.status)).integrations.find((i) => i.kind === "stripe_app" && i.status === "managed"), 60_000);
const appId = sManaged.integrationId!;
const bl = sManaged.discovery!.baseline as Record<string, number>;
expect(bl.mismatches === 0 && bl.records > 0, `baseline ${JSON.stringify(bl)}`);
step("S3", `Hosted and verified: ${JSON.stringify(bl)} (its own records rebuilt from Stripe's events through its own code; each checked against Stripe)`);

// Stripe-side change: our endpoint for this application moves to basil.
const eps = (await json(`${FX.stripe}/__fixture/state`)).body.endpoints as { id: string; url: string }[];
const ours = eps.find((e) => e.url.endsWith(`/rt/hooks/stripe/${s.workspace}/${appId}`))!;
await json(`${FX.stripe}/__fixture/endpoint-version`, { method: "POST", body: { endpointId: ours.id, version: "2025-03-31.basil" } });
await json(`${FX.stripe}/__fixture/subscription/${subA.subscriptionId}/renew`, { method: "POST", body: {} });
await json(`${FX.stripe}/__fixture/subscription/${subB.subscriptionId}/fail`, { method: "POST", body: {} });
const operator = await staff(s.c, s.workspace);
const ready = await wait("the correction validated", async () => {
  const ev = (await operator.query(api.maintenance.list, { integrationId: appId })).find((e) => e.kind === "provider_contract");
  if (!ev) return null;
  const e = await operator.query(api.maintenance.evidence, { eventId: ev.id });
  const c = (e.corrections as any[]).find((x) => x.kind === "patch" && x.status === "validated");
  return c ? { ev, e, c } : null;
}, 60_000);
const f = ready.e.event.finding as { fields: string[]; location: string[]; endpointApiVersion: string };
step("S4", `Detected: boundary ${ready.ev.boundary}; records differ from Stripe in ${JSON.stringify(f.fields)} at ${f.endpointApiVersion} (read at ${f.location.join(", ")}); reviewed patch validated by replay: ${ready.c.validation.checks.map((k: any) => `${k.result === "passed" ? "✓" : "✗"} ${k.name}`).join(" · ")}`);
await operator.mutation(api.corrections.activate, { correctionId: ready.c.id, reason: "Reviewed: reads the basil field locations; nothing else changes" });
const sDone = await wait("the event resolved", async () => {
  const st = await s.c.query(api.maintenance.get, { eventId: ready.ev.id });
  return st.status === "completed" ? st : null;
}, 60_000);
expect(!/stripeEventProcessor|patch|sha256|artifact/i.test(JSON.stringify(sDone)), "customer view leaks internals");
step("S5", `Operator switched the patch on. Customer view: "${sDone.timeline.at(-1)!.text}"`);
expect(sDone.accounting?.unresolved === 0 && (sDone.accounting?.affected ?? 0) > 0, `accounting ${JSON.stringify(sDone.accounting)}`);
const recs = await s.c.query(api.apps.records, { integrationId: appId });
expect(recs.every((r) => (r.verified as { matches?: boolean } | undefined)?.matches !== false), "a record still differs from Stripe");
step("S6", `Zero loss: ${JSON.stringify(sDone.accounting)}; all ${recs.length} records match Stripe`);

/* ------------------------------------ QuickBooks tools ------------------------------------ */
const qp = pinned("quickbooks-mcp");
const q = await company("LumenBooks", `books-${run}@lumen-books.test`);
async function connectQbo() {
  const { ticket: t } = await q.c.mutation(api.connections.begin, { provider: "quickbooks" });
  let url = `${B}/rt/connect/quickbooks?ticket=${t}`;
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, { redirect: "manual" });
    const loc = r.headers.get("location")!;
    if (loc.endsWith("/app/connections")) return;
    url = loc;
  }
}
await connectQbo();
await q.c.mutation(api.onboarding.discover, { kind: "qbo_tools" });
const qFound = await wait("discovery", async () => (await q.c.query(api.onboarding.status)).integrations.find((i) => i.kind === "qbo_tools" && i.status === "confirm"));
await q.c.mutation(api.onboarding.confirm, { kind: "qbo_tools", candidateId: (qFound.discovery!.candidates as { id: string }[])[0]!.id, responsibilitiesVersion: qFound.responsibilities.version });
const qManaged = await wait("the tools managed", async () => (await q.c.query(api.onboarding.status)).integrations.find((i) => i.kind === "qbo_tools" && i.status === "managed"));
const qboId = qManaged.integrationId!;
step("Q1", `Adopted quickbooks-mcp @ ${qp.commit.slice(0, 12)}; ${qp.files} files pinned (match: ${qp.drift === 0}); one provider: QuickBooks`);

const inv = (n: number) => ({ txn_date: new Date().toISOString().slice(0, 10), customer_name: "Acme Corp", doc_number: `D7-${run}-${n}`, lines: [{ item_name: "Consulting", amount: 300 }, { item_name: "Design", qty: 2, unit_price: 120 }] });
const invoices = async () => ((await json(`${FX.qbo}/__fixture/state`)).body.invoices as { DocNumber: string; TotalAmt: number }[]).filter((i) => i.DocNumber.startsWith(`D7-${run}`));
const outcome = (requestId: string, until: string[]) => wait(`request ${requestId}`, async () => {
  const r = await q.c.query(api.apps.request, { integrationId: qboId, requestId });
  return until.includes(r.status) ? r : null;
});
await q.c.mutation(api.apps.invoke, { integrationId: qboId, operation: "create_invoice", requestId: `r1-${run}`, input: inv(1) });
const r1 = await outcome(`r1-${run}`, ["succeeded", "failed", "unknown"]);
const r1b = await q.c.mutation(api.apps.invoke, { integrationId: qboId, operation: "create_invoice", requestId: `r1-${run}`, input: inv(1) });
expect(r1.status === "succeeded" && r1b.replayed && (await invoices()).length === 1, `r1 ${JSON.stringify(r1)} replay ${JSON.stringify(r1b)}`);
step("Q2", `Invoice ${String(r1.result?.invoiceId)} created via applications.invoke: ${r1.status}, verified in QuickBooks: ${String(r1.result?.verified)}; same request again: replayed=${r1b.replayed}; invoices: ${(await invoices()).map((i) => `${i.DocNumber} $${i.TotalAmt}`).join(", ")}`);

await json(`${FX.qbo}/__fixture/revoke`, { method: "POST", body: {} });
await q.c.mutation(api.apps.invoke, { integrationId: qboId, operation: "create_invoice", requestId: `r2-${run}`, input: inv(2) });
await outcome(`r2-${run}`, ["awaiting_authorization"]);
const authEv = (await q.c.query(api.maintenance.list, { integrationId: qboId })).find((e) => e.kind === "authorization_lost")!;
await connectQbo();
const authDone = await wait("reauthorization resolved", async () => {
  const st = await q.c.query(api.maintenance.get, { eventId: authEv.id });
  return st.status === "completed" ? st : null;
}, 60_000);
expect((await invoices()).length === 2, "held request not run exactly once");
step("Q3", `QuickBooks access lost → request held (nothing sent) → customer reconnected → ran once. "${authDone.timeline.at(-1)!.text}"; invoices: ${(await invoices()).length}`);

const qOp = await staff(q.c, q.workspace, "staff-2");
const up = await wait("the upstream release validated", async () => {
  const ev = (await qOp.query(api.maintenance.list, { integrationId: qboId })).find((e) => e.kind === "application_change");
  if (!ev) return null;
  const e = await qOp.query(api.maintenance.evidence, { eventId: ev.id });
  const c = (e.corrections as any[]).find((x) => x.status === "validated");
  return c ? { ev, e, c } : null;
}, 60_000);
step("Q4", `Upstream ${(up.e.event.finding as { release: string }).release}: ${up.c.validation.checks.map((k: any) => `${k.result === "passed" ? "✓" : "✗"} ${k.name} (${k.detail})`).join(" · ")}`);
await qOp.mutation(api.corrections.activate, { correctionId: up.c.id, reason: "Reviewed: upstream release, executed files unchanged" });
await q.c.mutation(api.apps.invoke, { integrationId: qboId, operation: "create_invoice", requestId: `r3-${run}`, input: inv(3) });
await outcome(`r3-${run}`, ["succeeded"]);
const ua = ((await json(`${FX.qbo}/__fixture/state`)).body.requestLog as { userAgent?: string | null }[]).filter((x) => x.userAgent?.startsWith("node-quickbooks")).at(-1)?.userAgent;
await wait("the upgrade event resolved", async () => (await q.c.query(api.maintenance.get, { eventId: up.ev.id })).status === "completed", 60_000);
await qOp.mutation(api.corrections.rollback, { correctionId: up.c.id, reason: "Rollback drill" });
expect(ua?.includes("2.0.50") && (await invoices()).length === 3, `ua ${ua}`);
step("Q5", `Operator switched it on; next request used "${ua}"; verified on real work and resolved; rolled back to the pinned set (drill)`);
finish("applications");
