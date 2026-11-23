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

test('customer: overview, connections, integration, history, reliability, incidents', async ({ page }) => {
  await login(page, CUSTOMER);
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByTestId('health').locator('[data-status]')).toBeVisible();
  await expect(page.getByTestId('last-sync')).not.toHaveText('never');

  await page.getByRole('link', { name: 'Connections' }).click();
  await expect(page.getByTestId('conn-shopify')).toContainText('read_orders');
  await expect(page.getByTestId('conn-netsuite')).toContainText('rest_webservices');
  await page.getByTestId('conn-shopify').getByRole('button', { name: 'Verify connection' }).click();
  await expect(page.getByTestId('conn-shopify').locator('[data-status="verified"]')).toBeVisible();

  await page.getByRole('link', { name: 'Integration', exact: true }).click();
  await expect(page.getByText('Shopify orders → NetSuite sales orders')).toBeVisible();
  await expect(page.getByText('SKU-RED')).toBeVisible();
  await expect(page.getByText('Reliability contract')).toBeVisible();

  await page.getByRole('link', { name: 'Delivery history' }).click();
  const rows = page.getByTestId('run-row');
  await expect(rows.first()).toBeVisible();
  await rows.first().getByRole('link').click();
  await expect(page.getByText(/Sync run ·/)).toBeVisible();

  await page.getByRole('link', { name: 'Reliability' }).click();
  await expect(page.getByText('Delivery totals')).toBeVisible();

  await page.getByRole('link', { name: 'Incidents' }).click();
  await expect(page.getByRole('heading', { name: 'Incidents' })).toBeVisible();
  // Customer cannot reach the operator console.
  await page.goto('/ops');
  await expect(page).toHaveURL(/\/app$/);
  expect(consoleErrors).toEqual([]);
});

test('customer: action required for an unmapped SKU, resolved by adding the mapping', async ({
  page,
  request,
}) => {
  await request.post('http://localhost:4010/__fixture/orders', {
    data: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lineItems: [{ sku: 'SKU-E2E-NEW', title: 'New product', quantity: 1, unitPrice: '9.99' }],
    },
  });
  await login(page, CUSTOMER);
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('actions')).toContainText('SKU-E2E-NEW', { timeout: 45_000 });

  await page.getByRole('link', { name: 'Integration', exact: true }).click();
  await page.getByLabel('SKU').fill('SKU-E2E-NEW');
  await page.getByLabel('NetSuite item id').fill('103');
  await page.getByRole('button', { name: 'Add mapping' }).click();
  await expect(page.getByRole('cell', { name: 'SKU-E2E-NEW' })).toBeVisible();

  await page.getByRole('link', { name: 'Overview' }).click();
  await expect(page.getByTestId('actions')).toHaveCount(0, { timeout: 90_000 });
});

test('customer: integrations page is served by the AppPort capability', async ({ page }) => {
  await login(page, CUSTOMER);
  await page.getByRole('link', { name: 'Integrations', exact: true }).click();
  await expect(page).toHaveURL(/\/app\/integrations$/);

  // The page names the capability it consumed; the values come from PostgreSQL via AppPort.
  await expect(page.getByTestId('appport-integrations')).toContainText('integrations.list@1');
  const rows = page.getByTestId('integration-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Shopify orders → NetSuite sales orders');
  await expect(rows.first()).toContainText('active');
  expect(consoleErrors).toEqual([]);
});

/**
 * Rendering states of the same page. These intercept only the `integrations.list` call (discovery
 * and the manifest still reach the real AppPort binding) so the empty and failure renderings can
 * be exercised deterministically. The success path above uses the real capability end to end.
 */
test('customer: integrations page renders the empty state', async ({ page }) => {
  await page.route('**/appport', async (route) => {
    const request = route.request().postDataJSON() as {
      requestId: string;
      capability?: { name?: string };
    };
    if (request.capability?.name !== 'integrations.list') return route.continue();
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
          integrations: [],
        },
      }),
    });
  });
  await login(page, CUSTOMER);
  await page.getByRole('link', { name: 'Integrations', exact: true }).click();
  await expect(page.getByText('No integrations exist for this tenant.')).toBeVisible();
  await expect(page.getByTestId('integration-row')).toHaveCount(0);
});

test('customer: integrations page renders capability failures honestly', async ({ page }) => {
  await page.route('**/appport', async (route) => {
    const request = route.request().postDataJSON() as {
      requestId: string;
      capability?: { name?: string };
    };
    if (request.capability?.name !== 'integrations.list') return route.continue();
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
  await page.getByRole('link', { name: 'Integrations', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('cannot read another tenant');
  await expect(page.getByTestId('integration-row')).toHaveCount(0);
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
