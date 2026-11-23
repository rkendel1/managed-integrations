/**
 * Runs both DETERMINISTIC provider fixtures as standalone servers for local development and
 * the failure demonstration. They are not Shopify or NetSuite.
 */
import { createNetSuiteFixture } from './netsuite-fixture.ts';
import { createShopifyFixture } from './shopify-fixture.ts';

const shopifyPort = Number(process.env.FIXTURE_SHOPIFY_PORT ?? 4010);
const netsuitePort = Number(process.env.FIXTURE_NETSUITE_PORT ?? 4020);
const host = process.env.FIXTURE_HOST ?? '127.0.0.1';

const shopify = createShopifyFixture();
const netsuite = createNetSuiteFixture();
await shopify.app.listen({ port: shopifyPort, host });
// A second, separate shop for the tenant run by the adopted executor (shops do not share orders).
const shopify2Port = Number(process.env.FIXTURE_SHOPIFY2_PORT ?? 4011);
const shopify2 = createShopifyFixture({ shopDomain: 'bluewave-supply.myshopify.com' });
await shopify2.app.listen({ port: shopify2Port, host });
console.log(`[fixture] shopify  http://${host}:${shopify2Port} (bluewave-supply.myshopify.com)`);
await netsuite.app.listen({ port: netsuitePort, host });
console.log(`[fixture] shopify  http://${host}:${shopifyPort}`);
console.log(`[fixture] netsuite http://${host}:${netsuitePort}`);
