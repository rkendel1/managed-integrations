/**
 * SLICE 5 browser test. Signup lands in onboarding; a managed customer sees "under management"; the
 * operator sees what adopted code runs and which corrections changed it.
 * Run after `make demo-maintenance` (Bluewave has an active adapter). The browser cannot complete the
 * fixture's Shopify OAuth (its authorize URL is an in-network host); that path is covered by
 * apps/api/test/onboarding.test.ts and `make demo-onboarding`, which use the same routes.
 */
import { expect, test, type Page } from '@playwright/test';
import { paceLogin } from './support/pace-login.ts';

async function login(page: Page, email: string, password: string) {
  await paceLogin();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/(app|ops)$/);
}

test('a new customer signs up and lands in onboarding at the Connect step', async ({ page }) => {
  await paceLogin();
  await page.goto('/login');
  await page.getByRole('link', { name: 'Create an account' }).click();
  await page.getByLabel('Company').fill('E2E Outfitters');
  await page.getByLabel('Email').fill(`e2e-${Date.now()}@outfitters.test`);
  await page.getByLabel('Password').fill('a long enough password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/app\/welcome$/);
  const ob = page.getByTestId('onboarding');
  await expect(ob).toHaveAttribute('data-status', 'connect');
  await expect(page.getByTestId('connect-shopify')).toHaveAttribute('data-connected', 'false');
  await expect(page.getByTestId('connect-netsuite')).toContainText('Account domain');
  // no integration-internals questions: no webhooks, mappings, schemas or retries
  for (const word of ['webhook', 'mapping', 'schema', 'retry'])
    await expect(page.getByText(word, { exact: false })).toHaveCount(0);
  // the portfolio points a customer without integrations to onboarding
  await page.goto('/app');
  await expect(page.getByRole('link', { name: 'Put your integration under management' })).toBeVisible();
});

test('a customer whose integration is already managed is not asked to set up again', async ({ page }) => {
  await login(
    page,
    'ops@bluewave.test',
    process.env.SEED_ADOPTED_CUSTOMER_PASSWORD || 'bluewave-demo-password',
  );
  await page.goto('/app/welcome');
  await expect(page.getByTestId('onboarding')).toHaveAttribute('data-status', 'managed');
  await expect(page.getByTestId('onboarding-protect')).toContainText('under management');
});

test('operator sees what adopted code runs, what it depends on, and the corrections with their evidence', async ({
  page,
}) => {
  await login(
    page,
    'operator@managed-integrations.test',
    process.env.SEED_OPERATOR_PASSWORD || 'operator-demo-password',
  );
  await page.getByRole('link', { name: 'Tenants' }).click();
  await page
    .getByRole('row', { name: /Bluewave Supply/ })
    .getByRole('link', { name: 'Maintenance' })
    .click();
  const code = page.getByTestId('adopted-code');
  await expect(code).toContainText('match the pinned commit');
  await expect(page.getByTestId('running-artifact')).toHaveText('adopted:d01b51d95993');
  await expect(code).toContainText('src/mapping.js:11');
  const adapter = page.locator('[data-testid="adaptation"][data-kind="adapter"]').first();
  await expect(adapter).toHaveAttribute('data-status', 'active');
  await adapter.locator('summary').click();
  await expect(adapter).toContainText('business data preserved (Shopify Admin API)');
  await expect(adapter.getByRole('button', { name: 'Roll back' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Propose p0001/ })).toBeVisible();
});
