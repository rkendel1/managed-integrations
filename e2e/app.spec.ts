import { expect, test, type Page } from '@playwright/test';
import { paceLogin } from './support/pace-login.ts';

const CUSTOMER = {
  email: 'customer@acme.test',
  password: process.env.SEED_CUSTOMER_PASSWORD || 'customer-demo-password',
};
const OPERATOR = {
  email: 'operator@managed-integrations.test',
  password: process.env.SEED_OPERATOR_PASSWORD || 'operator-demo-password',
};

async function login(page: Page, who: { email: string; password: string }) {
  await paceLogin();
  await page.goto('/login');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

const consoleErrors: string[] = [];
test.beforeEach(({ page }) => {
  consoleErrors.length = 0;
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
});

test('rejects invalid credentials', async ({ page }) => {
  await login(page, { email: CUSTOMER.email, password: 'wrong-password' });
  await expect(page.getByRole('alert')).toContainText('Invalid email or password');
});

test('customer: the product shows what we maintain, its evidence-based status, credentials and settings', async ({
  page,
}) => {
  await login(page, CUSTOMER);
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByText('We keep your integrations working.')).toBeVisible();
  const card = page.getByTestId('portfolio-integration');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Shopify orders become NetSuite sales orders');
  await expect(card.getByTestId('product-status')).toHaveAttribute(
    'data-status',
    /protected|verified|maintaining|checking|customer_action/,
  );
  // operational machinery is not the customer product
  for (const internal of ['Delivery history', 'Reliability', 'Incidents', 'Sync now'])
    await expect(page.getByText(internal, { exact: true })).toHaveCount(0);

  await card.getByRole('link', { name: 'View details' }).click();
  await expect(page.getByTestId('responsibilities')).toContainText('exactly once');
  await expect(page.getByTestId('last-verified')).toBeVisible();
  await expect(page.getByTestId('maintenance-history')).toBeVisible();

  await page.getByRole('link', { name: 'Connections' }).click();
  await expect(page.getByTestId('conn-shopify')).toContainText('read_orders');
  await expect(page.getByTestId('conn-netsuite')).toContainText('rest_webservices');
  await page.getByTestId('conn-shopify').getByRole('button', { name: 'Verify connection' }).click();
  await expect(page.getByTestId('conn-shopify').locator('[data-status="verified"]')).toBeVisible();

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByText('Shopify orders → NetSuite sales orders')).toBeVisible();
  await expect(page.getByText('SKU-RED')).toBeVisible();
  await expect(page.getByText('Reliability contract')).toBeVisible();
  // Customer cannot reach the operator console.
  await page.goto('/ops');
  await expect(page).toHaveURL(/\/app$/);
  expect(consoleErrors).toEqual([]);
});

test('customer: a decision only the customer can make (unmapped SKU) is asked for, and clears once made', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  await request.post('http://localhost:4010/__fixture/orders', {
    data: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lineItems: [{ sku: 'SKU-E2E-NEW', title: 'New product', quantity: 1, unitPrice: '9.99' }],
    },
  });
  await login(page, CUSTOMER);
  // The scheduled sync (every minute on the demo stack) picks the order up; no customer button involved.
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('actions')).toContainText('SKU-E2E-NEW', { timeout: 2_000 });
  }).toPass({ timeout: 150_000, intervals: [5_000] });
  await expect(page.getByTestId('product-status')).toHaveAttribute('data-status', 'customer_action');

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByLabel('SKU').fill('SKU-E2E-NEW');
  await page.getByLabel('NetSuite item id').fill('103');
  await page.getByRole('button', { name: 'Add mapping' }).click();
  await expect(page.getByRole('cell', { name: 'SKU-E2E-NEW' })).toBeVisible();

  await page.getByRole('link', { name: 'Overview' }).click();
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('actions')).toHaveCount(0, { timeout: 2_000 });
  }).toPass({ timeout: 150_000, intervals: [5_000] });
});

test('customer: the portfolio is served by the AppPort capability portfolio.list', async ({ page }) => {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/appport') && r.method() === 'POST') {
      const name = (r.postDataJSON() as { capability?: { name?: string } }).capability?.name;
      if (name) seen.push(name);
    }
  });
  await login(page, CUSTOMER);
  await expect(page.getByTestId('portfolio-integration')).toHaveCount(1);
  expect(seen).toContain('portfolio.list');
  expect(consoleErrors).toEqual([]);
});

/**
 * Rendering states of the same page. These intercept only the `portfolio.list` call (discovery and the
 * manifest still reach the real AppPort binding) so the empty and failure renderings can be exercised
 * deterministically. The success path above uses the real capability end to end.
 */
test('customer: the portfolio renders the empty state', async ({ page }) => {
  await page.route('**/appport', async (route) => {
    const request = route.request().postDataJSON() as { requestId: string; capability?: { name?: string } };
    if (request.capability?.name !== 'portfolio.list') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        protocol: 'appport/1',
        type: 'response',
        requestId: request.requestId,
        ok: true,
        output: {
          tenant: { id: '00000000-0000-4000-8000-000000000000', name: 'Empty Tenant' },
          statusDefinitions: {},
          integrations: [],
        },
      }),
    });
  });
  await login(page, CUSTOMER);
  await expect(page.getByText('No integrations are entrusted to us yet.')).toBeVisible();
  await expect(page.getByTestId('portfolio-integration')).toHaveCount(0);
});

test('customer: the portfolio renders capability failures honestly', async ({ page }) => {
  await page.route('**/appport', async (route) => {
    const request = route.request().postDataJSON() as { requestId: string; capability?: { name?: string } };
    if (request.capability?.name !== 'portfolio.list') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        protocol: 'appport/1',
        type: 'response',
        requestId: request.requestId,
        ok: false,
        error: { code: 'FORBIDDEN', message: 'The principal cannot read another tenant' },
      }),
    });
  });
  await login(page, CUSTOMER);
  await expect(page.getByRole('alert')).toContainText('cannot read another tenant');
  await expect(page.getByTestId('portfolio-integration')).toHaveCount(0);
});

test('operator: inbox, tenants, releases, economics', async ({ page }) => {
  await login(page, OPERATOR);
  await expect(page).toHaveURL(/\/ops$/);
  await expect(page.getByText('Needs attention')).toBeVisible();
  await page.getByRole('link', { name: 'Tenants' }).click();
  await expect(page.getByText('Acme Outdoor')).toBeVisible();
  await page.getByRole('link', { name: 'Releases' }).click();
  await expect(page.getByRole('heading', { name: 'Releases' })).toBeVisible();
  await page.getByRole('link', { name: 'Economics' }).click();
  await expect(page.getByText('Mean time to recovery')).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
