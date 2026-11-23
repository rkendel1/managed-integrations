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
await netsuite.app.listen({ port: netsuitePort, host });
console.log(`[fixture] shopify  http://${host}:${shopifyPort}`);
console.log(`[fixture] netsuite http://${host}:${netsuitePort}`);
