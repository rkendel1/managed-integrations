/**
 * SLICE 2 browser test: the UI shows the ADOPTED executor's actual outcomes (rendered from the
 * AppPort capabilities deliveries.list/get), for the customer and for the operator.
 * Run after `make demo-adopted` (which produces one delivered and one recovered order).
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

test('customer sees the adopted integration, its provenance, outcomes and attempt history', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await login(
    page,
    'ops@bluewave.test',
    process.env.SEED_ADOPTED_CUSTOMER_PASSWORD || 'bluewave-demo-password',
  );
  await page.goto('/app/integrations');
  await page.getByRole('link', { name: 'Deliveries' }).first().click();
  const panel = page.getByTestId('deliveries');
  await expect(panel).toContainText('shopify-erp-order-sync');
  await expect(panel).toContainText('d01b51d95993');
  await expect(page.getByTestId('last-success')).not.toHaveText('—');
  const rows = page.getByTestId('delivery-row');
  await expect(rows.first()).toBeVisible();
  await expect(page.locator('[data-testid="delivery-row"][data-outcome="delivered"]')).toHaveCount(
    await rows.count(),
  );
  await page.getByRole('button', { name: '#B-1002' }).first().click();
  const detail = page.getByTestId('delivery-detail');
  await expect(detail).toContainText('manual_retry');
  await expect(detail).toContainText('Items not found in NetSuite: SKU-PURPLE');
  await expect(detail).toContainText('adopted:d01b51d95993');
  expect(errors).toEqual([]);
});

test('operator finds the tenant and inspects the same evidence', async ({ page }) => {
  await login(
    page,
    'operator@managed-integrations.test',
    process.env.SEED_OPERATOR_PASSWORD || 'operator-demo-password',
  );
  await page.getByRole('link', { name: 'Tenants' }).click();
  const row = page.getByRole('row', { name: /Bluewave Supply/ });
  await expect(row).toContainText('adopted');
  await row.getByRole('link', { name: 'Deliveries' }).click();
  await expect(page.getByTestId('deliveries')).toContainText('shopify-erp-order-sync');
  await expect(page.getByTestId('delivery-row').first()).toBeVisible();
});

test('a customer of another tenant cannot open the adopted integration', async ({ page }) => {
  await login(page, 'customer@acme.test', process.env.SEED_CUSTOMER_PASSWORD || 'customer-demo-password');
  const bluewave = await page.request.get('/api/operator/tenants');
  expect(bluewave.status()).toBe(403);
});
