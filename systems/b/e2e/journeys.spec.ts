/**
 * System B's browser journeys, mirroring System A's (e2e/*.spec.ts) where the feature exists in both. Data is
 * set up through B's own API and the provider simulators; the browser signs in through FeltKit's screens.
 */
import { expect, test } from "@playwright/test";
import { api } from "../feltkit/_generated/api.ts";
import { FX, adoptedCompany, client, company, json, netsuiteRecords, wait } from "../scenarios/lib.ts";
import { signIn, signInStaff } from "./support.ts";

const run = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const password = (name: string) => `${name}-scenario-password-1`;

test("rejects invalid credentials", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel(/e-?mail/i).first().fill(`nobody-${run()}@example.test`);
  await page.getByLabel(/password/i).first().fill("wrong-password-123");
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(page.getByText("Overview")).toHaveCount(0);
});

test("a new customer signs up, creates its company and lands in set-up at the Connect step", async ({ page }) => {
  const email = `new-${run()}@newco.test`;
  const c = client();
  await c.signUp({ email, password: password("Newco"), name: "Newco owner" });
  await signIn(page, email, password("Newco"));
  await page.getByLabel(/name/i).first().fill(`Newco ${run()}`);
  await page.getByRole("button", { name: /create/i }).first().click();
  await page.getByRole("link", { name: "Set up" }).click();
  await expect(page.getByTestId("next-order_sync")).toHaveText(/Connect shopify and netsuite/i);
});

test("customer: the portfolio shows what we maintain and its status; empty state for a new company", async ({ page }) => {
  const co = await adoptedCompany(api, "Bluewave", FX.shopify2);
  const email = (await co.c.session()).account?.email as string;
  await signIn(page, email, password("Bluewave"));
  await expect(page.getByTestId("portfolio")).toContainText("Shopify orders → NetSuite sales orders");
  await expect(page.getByTestId("portfolio")).toContainText("Protected");

  const empty = await company("Emptyco", `empty-${run()}@empty.test`);
  await page.getByRole("button", { name: /sign out/i }).click();
  await signIn(page, (await empty.c.session()).account?.email as string, password("Emptyco"));
  await expect(page.getByTestId("empty")).toContainText("Nothing under management yet");
});

test.describe("a provider change handled end to end", () => {
  let co: Awaited<ReturnType<typeof adoptedCompany>>;
  let eventId: string;
  test.beforeAll(async () => {
    co = await adoptedCompany(api, "Acme", FX.shopify);
    await json(`${FX.shopify}/__fixture/webhook-version`, { method: "POST", body: { version: "2027-01" } });
    const o = (await json(`${FX.shopify}/__fixture/orders`, { method: "POST", body: { name: `#E2E-${run()}`, email: "b@acme.test", lineItems: [{ sku: "SKU-BLUE", title: "Part", quantity: 1, unitPrice: "7.25" }] } })).body as { legacyId: string };
    const ev = await wait("event resolved", async () => (await co.c.query(api.maintenance.list, { integrationId: co.integrationId })).find((e) => e.status === "resolved"), 60_000);
    eventId = ev.id;
    expect((await netsuiteRecords(o.legacyId))[0]!.item.items[0]!.rate).toBe(7.25);
    await json(`${FX.shopify}/__fixture/webhook-version`, { method: "POST", body: { version: "2026-10" } });
  });

  test("customer sees the completed maintenance as an outcome, with no internal machinery", async ({ page }) => {
    await signIn(page, (await co.c.session()).account?.email as string, password("Acme"));
    await page.goto(`/app/events/${eventId}`);
    await expect(page.getByTestId("event-status")).toHaveText("Completed");
    await expect(page.getByTestId("accounting")).toContainText("unresolved: 0");
    const text = await page.getByTestId("event").innerText();
    expect(text).not.toMatch(/mapping\.js|adapter|correction|runtime|price_set/i);
  });

  test("operator sees the same story and the evidence behind every claim", async ({ page }) => {
    const owner = co.c;
    const { link } = await owner.invite({ email: "staff-1@staff.mi.test", role: "operator", send: false });
    const staff = client();
    await staff.signInAsDevUser("staff-1");
    await staff.acceptInvitation(new URLSearchParams(new URL(link).hash.slice(1)).get("feltkit-invitation")!).catch(() => undefined);
    await signInStaff(page, "staff-1", co.workspace);
    await page.goto(`/ops/events/${eventId}`);
    await expect(page.getByTestId("evidence")).toContainText("src/mapping.js:11");
    await expect(page.getByTestId("evidence")).toContainText("[internal]");
    await expect(page.getByTestId("customer-projection")).toContainText("Completed");
    await page.goto(`/ops/integrations/${co.integrationId}`);
    await expect(page.getByTestId("adopted-code")).toContainText("shopify-erp-order-sync");
    await expect(page.getByTestId("correction-adapter")).toContainText("proposed → validated → active");
    await expect(page.getByTestId("correction-adapter")).toContainText("✓ business data preserved");
    await expect(page.getByTestId("deliveries")).toContainText("delivered");
  });

  test("another company cannot open the maintenance event or the integration", async ({ page }) => {
    const other = await company("Globex", `globex-${run()}@globex.test`);
    await signIn(page, (await other.c.session()).account?.email as string, password("Globex"));
    await page.goto(`/app/events/${eventId}`);
    await expect(page.getByRole("alert")).toHaveText("Not found.");
    await page.goto(`/app/integrations/${co.integrationId}`);
    await expect(page.getByRole("alert")).toHaveText("Not found.");
  });
});

test("operator detects orders whose webhooks never arrived and recovers them (bulk needs confirmation)", async ({ page }) => {
  const co = await adoptedCompany(api, "Northwind", FX.shopify3);
  await json(`${FX.shopify3}/__fixture/drop-webhooks`, { method: "POST", body: { n: 2 } });
  const lost = [];
  for (let i = 0; i < 2; i++)
    lost.push((await json(`${FX.shopify3}/__fixture/orders`, { method: "POST", body: { name: `#LOST-${run()}`, email: "b@nw.test", lineItems: [{ sku: "SKU-RED", title: "Part", quantity: 1, unitPrice: "10.00" }] } })).body as { legacyId: string });
  const { link } = await co.c.invite({ email: "staff-2@staff.mi.test", role: "operator", send: false });
  const staff = client();
  await staff.signInAsDevUser("staff-2");
  await staff.acceptInvitation(new URLSearchParams(new URL(link).hash.slice(1)).get("feltkit-invitation")!);
  await signInStaff(page, "staff-2", co.workspace);
  await page.goto(`/ops/integrations/${co.integrationId}`);
  await page.getByRole("button", { name: "Check the source now" }).click();
  await expect(page.getByTestId("reconciliation")).toContainText("missing_delivery", { timeout: 20_000 });
  await page.getByRole("button", { name: /Recover all 2/ }).click();
  await expect(page.getByRole("alert")).toContainText("Recover 2 orders");
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByTestId("reconciliation")).toContainText("recovered · verified", { timeout: 30_000 });
  for (const o of lost) expect((await netsuiteRecords(o.legacyId)).length).toBe(1);
});

test("a customer whose integration is already managed is not asked to set up again", async ({ page }) => {
  const co = await adoptedCompany(api, "Managedco", FX.shopify2);
  await signIn(page, (await co.c.session()).account?.email as string, password("Managedco"));
  await page.getByRole("link", { name: "Set up" }).click();
  await expect(page.getByTestId("onboarding-order_sync")).not.toContainText("Connect shopify");
  await expect(page.getByTestId("onboarding-order_sync")).not.toContainText("Find my integration");
});
