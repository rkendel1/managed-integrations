import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/** Sign in through FeltKit's own SignIn screen (password accounts). */
export async function signIn(page: Page, email: string, password: string) {
  await page.goto("/");
  await page.getByLabel(/e-?mail/i).first().fill(email);
  await page.getByLabel(/password/i).first().fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await expect(page.getByText("Managed Integrations").first()).toBeVisible();
}

/** Staff in development: FeltKit's dev sign-in (a cookie session for the browser), then open a company. */
export async function signInStaff(page: Page, devId: string, workspace: string) {
  await page.goto("/");
  const r = await page.request.post("/api/auth/dev", { headers: { "x-feltkit-session": "cookie", "content-type": "application/json" }, data: { userId: devId } });
  expect(r.ok()).toBeTruthy();
  const csrf = (await r.json()).csrf as string;
  const s = await page.request.post("/api/tenants/switch", { headers: { "x-feltkit-session": "cookie", "x-feltkit-csrf": csrf, "content-type": "application/json" }, data: { tenantId: workspace } });
  expect(s.ok(), await s.text()).toBeTruthy();
  await page.goto("/ops");
}
