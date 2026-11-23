/**
 * SLICE 4 browser test: the customer product after a real maintenance event, and the operator evidence
 * behind it. Run after `make demo-maintenance` (which changes the provider at the fixture boundary and lets
 * the worker detect, fix, recover and verify).
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

test('customer sees the completed maintenance as an outcome, with no internal machinery', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await login(
    page,
    'ops@bluewave.test',
    process.env.SEED_ADOPTED_CUSTOMER_PASSWORD || 'bluewave-demo-password',
  );
  const card = page.getByTestId('portfolio-integration');
  await expect(card.getByTestId('product-status')).toHaveAttribute('data-status', 'verified');
  await card.getByRole('link', { name: 'View details' }).click();
  const row = page
    .getByTestId('maintenance-row')
    .filter({ hasText: 'We resolved a compatibility issue' })
    .first();
  await expect(row).toContainText('Zero transactions lost');
  await row.getByRole('link').click();

  const ev = page.getByTestId('maintenance-event');
  await expect(ev).toHaveAttribute('data-state', 'completed');
  await expect(page.getByTestId('event-headline')).toHaveText('We resolved a compatibility issue');
  await expect(page.getByTestId('zero-loss')).toContainText('Zero transactions lost.');
  await expect(ev.locator('[data-fact="Change detected"]')).toContainText('unit price of each order line');
  await expect(ev.locator('[data-fact="Customer action"]')).toHaveText('None required.');
  await expect(page.getByTestId('accounting')).toContainText('verified in NetSuite');
  // internal details stay internal
  for (const word of ['line_items', 'inputCompat', 'reconciliation', 'incident', 'mapping.js', 'stack'])
    await expect(page.getByText(word, { exact: false })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('operator sees the same story and the evidence behind every claim', async ({ page }) => {
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
  await page
    .getByTestId('maintenance-row')
    .filter({ hasText: 'We resolved a compatibility issue' })
    .first()
    .getByRole('link')
    .click();
  await expect(page.getByTestId('event-headline')).toHaveText('We resolved a compatibility issue');
  await expect(page.getByTestId('zero-loss')).toBeVisible();
  await expect(page.getByTestId('evidence-finding')).toContainText('line_items[].price');
  await expect(page.getByTestId('evidence-investigation')).toContainText('src/mapping.js');
  await expect(page.getByTestId('evidence-investigation')).toContainText('matches pinned upstream commit');
  await expect(page.getByTestId('evidence-correction')).toContainText('upstream code unchanged');
  await expect(page.getByTestId('evidence-correction')).toContainText(
    'mapped values match Shopify Admin API',
  );
  await expect(page.getByTestId('evidence-accounting')).toContainText('zero loss proven: yes');
  await expect(page.getByTestId('accounting-order').first()).toBeVisible();
});

test('another tenant cannot open the maintenance event', async ({ page }) => {
  await login(page, 'customer@acme.test', process.env.SEED_CUSTOMER_PASSWORD || 'customer-demo-password');
  const r = await page.request.post('/appport', {
    data: {
      protocol: 'appport/1',
      type: 'request',
      requestId: 'x1',
      capability: { name: 'maintenance.events.get', version: 1 },
      input: { eventId: '00000000-0000-4000-8000-000000000001' },
    },
  });
  // Unknown or foreign: never the event. (Cross-tenant FORBIDDEN is asserted in the API boundary tests.)
  expect(JSON.stringify(await r.json())).toMatch(/NOT_FOUND|FORBIDDEN/);
});
