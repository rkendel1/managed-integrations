/**
 * SLICE 3 browser test: the reconciliation panel of the shared deliveries page (rendered from the
 * AppPort capabilities reconciliation.runs/items, acting through reconciliation.start/recover).
 * Creates orders in Bluewave's FIXTURE store whose webhooks are never sent, then detects and
 * recovers them from the UI. Run against the running stack (make up).
 */
import { expect, test, type Page } from '@playwright/test';
import { paceLogin } from './support/pace-login.ts';

const SHOP = process.env.E2E_ADOPTED_SHOPIFY_URL ?? 'http://localhost:4011';

async function login(page: Page, email: string, password: string) {
  await paceLogin();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/(app|ops)$/);
}
async function missedOrder(page: Page, name: string) {
  const createdAt = new Date(Date.now() - 60_000).toISOString();
  const r = await page.request.post(`${SHOP}/__fixture/orders`, {
    data: {
      name,
      createdAt,
      updatedAt: createdAt,
      email: 'buyer@bluewave.test',
      lineItems: [{ sku: 'SKU-BLUE', title: 'Part', quantity: 1, unitPrice: '9.00' }],
    },
  });
  expect(r.ok()).toBe(true);
}

test('operator detects orders whose webhooks never arrived and recovers them (bulk needs confirmation)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const tag = Date.now().toString(36).toUpperCase();
  await missedOrder(page, `#E${tag}-1`);
  await missedOrder(page, `#E${tag}-2`);

  await login(
    page,
    'operator@managed-integrations.test',
    process.env.SEED_OPERATOR_PASSWORD || 'operator-demo-password',
  );
  await page.getByRole('link', { name: 'Tenants' }).click();
  await page
    .getByRole('row', { name: /Bluewave Supply/ })
    .getByRole('link', { name: 'Deliveries' })
    .click();
  const panel = page.getByTestId('reconciliation');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Run reconciliation' }).click();
  await expect(page.getByTestId('recon-summary')).toHaveAttribute('data-status', 'completed', {
    timeout: 30_000,
  });

  const row = (n: number) => panel.getByRole('row', { name: new RegExp(`#E${tag}-${n}`) });
  // the summary may still show the previous run for a moment; the new orders appear with the new run
  await expect(row(1)).toHaveAttribute('data-classification', 'missing_delivery', { timeout: 30_000 });
  await expect(row(2)).toHaveAttribute('data-classification', 'missing_delivery');

  await page.getByLabel(`Select #E${tag}-1`).check();
  await page.getByLabel(`Select #E${tag}-2`).check();
  const recover = panel.getByRole('button', { name: 'Recover selected (2)' });
  await expect(recover).toBeDisabled();
  await panel.getByLabel('Recovery reason').fill('Webhooks lost (e2e)');
  await panel.getByText('I confirm recovery of 2 orders into NetSuite').click();
  await expect(recover).toBeEnabled();
  await recover.click();
  await expect(panel).toContainText('Recovery requested for 2 order(s)');
  await expect(row(1)).toHaveAttribute('data-recovery', 'recovered', { timeout: 60_000 });
  await expect(row(2)).toHaveAttribute('data-recovery', 'recovered', { timeout: 60_000 });
  await expect(row(1)).not.toContainText('—', { timeout: 5_000 }); // verified NetSuite id shown
  expect(errors).toEqual([]);
});

test('operator sees the same reconciliation for the tenant', async ({ page }) => {
  await login(
    page,
    'operator@managed-integrations.test',
    process.env.SEED_OPERATOR_PASSWORD || 'operator-demo-password',
  );
  await page.getByRole('link', { name: 'Tenants' }).click();
  await page
    .getByRole('row', { name: /Bluewave Supply/ })
    .getByRole('link', { name: 'Deliveries' })
    .click();
  await expect(page.getByTestId('recon-summary')).toHaveAttribute('data-status', 'completed');
  await expect(page.getByTestId('recon-counts')).toContainText('recovered');
});
