/**
 * Runs both DETERMINISTIC provider fixtures as standalone servers for local development and
 * the failure demonstration. They are not Shopify or NetSuite.
 */
import { createNetSuiteFixture } from './netsuite-fixture.ts';
import { createShopifyFixture } from './shopify-fixture.ts';
import { createStripeFixture } from './stripe-fixture.ts';
import { createQuickBooksFixture } from './quickbooks-fixture.ts';

const shopifyPort = Number(process.env.FIXTURE_SHOPIFY_PORT ?? 4010);
const netsuitePort = Number(process.env.FIXTURE_NETSUITE_PORT ?? 4020);
const host = process.env.FIXTURE_HOST ?? '127.0.0.1';

const shopify = createShopifyFixture();
const netsuite = createNetSuiteFixture();
await shopify.app.listen({ port: shopifyPort, host });
// A second, separate shop for the tenant run by the adopted executor (shops do not share orders).
const shopify2Port = Number(process.env.FIXTURE_SHOPIFY2_PORT ?? 4011);
const shopify2 = createShopifyFixture({
  shopDomain: 'bluewave-supply.myshopify.com',
  firstOrderId: 6000000001n,
});
await shopify2.app.listen({ port: shopify2Port, host });
console.log(`[fixture] shopify  http://${host}:${shopify2Port} (bluewave-supply.myshopify.com)`);
// A third shop: a NEW customer who onboards themselves (slice 5 demo); its existing integration history
// is created by the demo running the pinned upstream code.
const shopify3Port = Number(process.env.FIXTURE_SHOPIFY3_PORT ?? 4012);
const shopify3 = createShopifyFixture({
  shopDomain: 'northwind-goods.myshopify.com',
  firstOrderId: 9000000001n,
});
await shopify3.app.listen({ port: shopify3Port, host });
console.log(`[fixture] shopify  http://${host}:${shopify3Port} (northwind-goods.myshopify.com)`);
await netsuite.app.listen({ port: netsuitePort, host });
console.log(`[fixture] shopify  http://${host}:${shopifyPort}`);
console.log(`[fixture] netsuite http://${host}:${netsuitePort}`);
// Slice 6: Stripe and QuickBooks Online fixtures for the Stripe → QuickBooks integration.
const stripePort = Number(process.env.FIXTURE_STRIPE_PORT ?? 4030);
const qboPort = Number(process.env.FIXTURE_QBO_PORT ?? 4040);
const stripe = createStripeFixture({ prefix: 'Lm' });
const qbo = createQuickBooksFixture();
await stripe.app.listen({ port: stripePort, host });
await qbo.app.listen({ port: qboPort, host });
console.log(`[fixture] stripe   http://${host}:${stripePort} (key ${stripe.apiKey()})`);
console.log(`[fixture] qbo      http://${host}:${qboPort} (realm ${qbo.realmId})`);
