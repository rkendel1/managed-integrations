/**
 * Target-side changes at the function boundary, against a fresh FeltDB per test (FeltKit's createTestApp):
 * who may answer a decision, how a configuration is validated, switched on and rolled back, and that held
 * work is never released over a partly corrected path. The runtime component is not running here; tests act
 * as it (principal `component:runtime`, role `runtime`), exactly as it calls these functions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.ts";

const RUNTIME = { id: "component:runtime", type: "service" as const };
const OPERATOR = "test-harness"; // who provisions memberships (recorded by FeltKit)

async function company(t: TestApp, name: string, owner: string) {
  const tenant = await t.provisionTenant(name, { id: owner, type: "user", roles: ["person"] });
  await t.tenancy!.provision({ tenantId: tenant.id, principal: RUNTIME, role: "runtime" }, OPERATOR);
  await t.tenancy!.provision({ tenantId: tenant.id, principal: { id: "staff-1", type: "user" }, role: "operator" }, OPERATOR);
  const as = {
    owner: t.as({ id: owner, type: "user", roles: ["person"] }, { tenant: tenant.id }),
    runtime: t.as({ ...RUNTIME, roles: [] }, { tenant: tenant.id }),
    staff: t.as("staff-1", { tenant: tenant.id }),
  };
  const integrationId = await as.owner.mutation(api.integrations.adoptOrderSync, { defaultCustomer: "WEB" });
  return { tenant, integrationId, ...as };
}

/** A delivery the runtime held because NetSuite now requires a subsidiary: opens the target event. */
async function heldForSubsidiary(co: Awaited<ReturnType<typeof company>>, sourceId: string) {
  const { deliveryId } = await co.runtime.mutation(api.runtime.ingest, {
    integrationId: co.integrationId, providerEventId: `wh-${sourceId}`, topic: "orders/create", sourceId, reference: `#${sourceId}`, sealed: "sealed-payload", origin: "webhook",
  });
  await co.runtime.mutation(api.runtime.recordAttempt, {
    deliveryId: deliveryId!, outcome: "held", by: "test", detail: "NetSuite: Please enter value(s) for: Subsidiary",
    target: { provider: "netsuite", contract: "salesOrder write: required fields", finding: { requiredField: "Subsidiary" }, customerText: "NetSuite now requires a subsidiary." },
  });
  const [ev] = (await co.owner.query(api.maintenance.list, { integrationId: co.integrationId })).filter((e) => e.kind === "target_contract_change");
  return { deliveryId: deliveryId!, eventId: ev!.id };
}

async function ask(co: Awaited<ReturnType<typeof company>>, eventId: string) {
  return co.runtime.mutation(api.target.requestDecision, {
    eventId, setting: "subsidiaryId", question: "Which subsidiary?", rationale: "business decision", customerText: "Choose a subsidiary.",
    options: [{ id: "1", label: "Holdings" }, { id: "2", label: "Canada" }],
  });
}

test("a target refusal holds the order and opens one event per change, not per order", async () => {
  const t = await createTestApp();
  try {
    const co = await company(t, "Acme", "owner-a");
    const a = await heldForSubsidiary(co, "1001");
    const b = await heldForSubsidiary(co, "1002");
    assert.equal(a.eventId, b.eventId);
    const ds = (await co.owner.query(api.deliveries.list, { integrationId: co.integrationId })).deliveries;
    assert.deepEqual(ds.map((d) => d.status), ["held", "held"]);
    const ev = (await co.owner.query(api.maintenance.list, { integrationId: co.integrationId }))[0]!;
    assert.equal(ev.boundary, "target");
  } finally {
    await t.close();
  }
});

test("only the customer answers a decision: staff are refused, invalid and repeated answers are refused, other companies cannot see it", async () => {
  const t = await createTestApp();
  try {
    const co = await company(t, "Acme", "owner-a");
    const other = await company(t, "Globex", "owner-b");
    const { eventId } = await heldForSubsidiary(co, "1001");
    const decisionId = await ask(co, eventId);

    const view = await co.owner.query(api.maintenance.get, { eventId });
    assert.equal(view.status, "customer_action");
    assert.deepEqual(view.decision?.options.map((o) => o.label), ["Holdings", "Canada"]);

    await assert.rejects(co.staff.mutation(api.target.decide, { eventId, decisionId, optionId: "2" }), { code: "FORBIDDEN" });
    await assert.rejects(co.staff.mutation(api.corrections.reject, { correctionId: decisionId, reason: "x" }), { code: "FAILED_PRECONDITION" });
    await assert.rejects(other.owner.mutation(api.target.decide, { eventId, decisionId, optionId: "2" }), { code: "NOT_FOUND" });
    await assert.rejects(other.owner.query(api.maintenance.get, { eventId }), { code: "NOT_FOUND" });
    await assert.rejects(co.owner.mutation(api.target.decide, { eventId, decisionId, optionId: "9" }), { code: "INVALID_ARGUMENT" });

    await co.owner.mutation(api.target.decide, { eventId, decisionId, optionId: "2" });
    await assert.rejects(co.owner.mutation(api.target.decide, { eventId, decisionId, optionId: "1" }), { code: "CONFLICT" });
    const after = await co.owner.query(api.maintenance.get, { eventId });
    assert.equal(after.decision, undefined);
    assert.equal(after.customerAction, false);
  } finally {
    await t.close();
  }
});

test("a configuration that failed validation is rejected and cannot be switched on; a validated one changes the settings and rollback restores them exactly", async () => {
  const t = await createTestApp();
  try {
    const co = await company(t, "Acme", "owner-a");
    const { eventId } = await heldForSubsidiary(co, "1001");
    const spec = (to: string) => ({ setting: "subsidiaryId", from: null, to, settingsBefore: { subsidiaryId: null }, settingsAfter: { subsidiaryId: to } });

    const bad = await co.runtime.mutation(api.target.recordCorrection, {
      eventId, kind: "configuration", scopeKey: "s", spec: spec("7"), reason: "r", nextPhase: "configured",
      checks: [{ name: "the subsidiary is active in NetSuite", result: "failed", detail: "7: not found" }],
    });
    assert.equal(bad.status, "rejected");
    await assert.rejects(co.runtime.mutation(api.target.activateConfiguration, { correctionId: bad.id, nextPhase: "patch" }), { code: "FAILED_PRECONDITION" });
    assert.equal((await co.staff.query(api.corrections.inspect, { integrationId: co.integrationId })).configuration.subsidiaryId, undefined);

    const good = await co.runtime.mutation(api.target.recordCorrection, {
      eventId, kind: "configuration", scopeKey: "s", spec: spec("2"), reason: "r", nextPhase: "configured",
      checks: [{ name: "the subsidiary is active in NetSuite", result: "passed", detail: "2: Canada" }],
    });
    await co.runtime.mutation(api.target.activateConfiguration, { correctionId: good.id, nextPhase: "patch" });
    const on = await co.staff.query(api.corrections.inspect, { integrationId: co.integrationId });
    assert.equal(on.configuration.subsidiaryId, "2");
    assert.ok(on.running.includes("configuration:subsidiaryId"));
    assert.equal(on.configuration.defaultCustomer, "WEB"); // other settings untouched

    await co.staff.mutation(api.corrections.rollback, { correctionId: good.id, reason: "drill" });
    const off = await co.staff.query(api.corrections.inspect, { integrationId: co.integrationId });
    assert.equal(off.configuration.subsidiaryId, null);
    assert.ok(!off.running.includes("configuration:subsidiaryId"));
    // The customer cannot touch corrections.
    await assert.rejects(co.owner.mutation(api.corrections.rollback, { correctionId: good.id, reason: "x" }), { code: "FORBIDDEN" });
  } finally {
    await t.close();
  }
});

test("held work is not released while another change of the integration still awaits its correction (whole path or nothing)", async () => {
  const t = await createTestApp();
  try {
    const co = await company(t, "Acme", "owner-a");
    const { eventId } = await heldForSubsidiary(co, "1001");
    // A source change at the same time: an order held at the source boundary, no correction yet.
    const { deliveryId } = await co.runtime.mutation(api.runtime.ingest, {
      integrationId: co.integrationId, providerEventId: "wh-1002", topic: "orders/create", sourceId: "1002", reference: "#1002", sealed: "s", origin: "webhook", apiVersion: "2027-01",
    });
    await co.runtime.mutation(api.runtime.recordAttempt, { deliveryId: deliveryId!, outcome: "held", by: "test", apiVersion: "2027-01", violations: ["line_items[].price"] });

    await assert.rejects(co.runtime.mutation(api.target.releaseHeld, { eventId, scope: "integration", nextPhase: "verify_target" }), { code: "FAILED_PRECONDITION" });
    const statuses = (await co.owner.query(api.deliveries.list, { integrationId: co.integrationId })).deliveries.map((d) => d.status);
    assert.deepEqual(statuses, ["held", "held"]);

    const ctx = await co.runtime.query(api.maintenance.eventContext, { eventId });
    assert.deepEqual(ctx.blocking.map((b: { kind: string }) => b.kind), ["input_contract_changed"]);
    assert.equal(ctx.heldAll.length, 2);
  } finally {
    await t.close();
  }
});

test("the runtime-only functions are refused to customers and staff", async () => {
  const t = await createTestApp();
  try {
    const co = await company(t, "Acme", "owner-a");
    const { eventId } = await heldForSubsidiary(co, "1001");
    for (const who of [co.owner, co.staff]) {
      await assert.rejects(who.mutation(api.target.requestDecision, { eventId, setting: "x", question: "q", rationale: "r", customerText: "c", options: [{ id: "1", label: "a" }] }), { code: "FORBIDDEN" });
      await assert.rejects(who.mutation(api.target.releaseHeld, { eventId, scope: "event", nextPhase: "x" }), { code: "FORBIDDEN" });
    }
  } finally {
    await t.close();
  }
});
