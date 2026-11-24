import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/** Sign in through FeltKit's own SignIn screen (password accounts). */
export async function signIn(page: Page, email: string, password: string) {
  await page.goto("/");
  await page.getByLabel(/e-?mail/i).first().fill(email);
  await page.getByLabel(/password/i).first().fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  // Signed in when FeltKit's sign-in form is gone (the next screen is the product or "create your company").
  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
}

/**
 * Staff in development: FeltKit's sign-in screen lists the declared dev users; pick one, then open the
 * company from FeltKit's workspace screens when more than one could be current.
 */
export async function signInStaff(page: Page, devName: string, companyName: string) {
  await page.goto("/");
  await page.getByRole("button", { name: devName }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
  const signOut = page.getByRole("button", { name: /^sign out$/i });
  if (!(await signOut.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: new RegExp(companyName) }).first().click();
  }
  await expect(signOut).toBeVisible();
  await page.goto("/ops");
  await expect(page.getByTestId("ops-integrations")).toContainText(companyName);
}
