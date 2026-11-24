/**
 * Shopify → NetSuite (adopted shopify-erp-order-sync): its maintenance contract. Every `implemented`
 * capability below is exercised by this package's tests and by `make demo-maintenance` / `demo-onboarding`.
 */
import type { IntegrationDescriptor, Responsibilities } from '@mi/managed';
import { ADOPTED_FLOW_TYPE } from './contract.ts';
import { ADOPTED } from './provenance.ts';

export const SHOPIFY_NETSUITE: IntegrationDescriptor & { responsibilities: Responsibilities } = {
  flowType: ADOPTED_FLOW_TYPE,
  name: 'Shopify → NetSuite orders',
  process: 'Shopify orders become NetSuite sales orders',
  shape: 'pipeline',
  providers: [
    {
      id: 'shopify',
      name: 'Shopify',
      role: 'source',
      api: 'Shopify Admin API',
      version: 'webhook API version (X-Shopify-API-Version)',
      auth: 'Admin API access token (custom app); webhook HMAC-SHA256 with the app secret',
      client: 'none: webhooks are received by our ingress; the adopted mapping reads the payload',
      operations: [{ name: 'orders/create webhook', kind: 'event', effect: 'mapped to a sales order by src/mapping.js' }],
      semantics: 'an order: its line items, quantities, prices, currency and customer',
      idempotency: 'one delivery per Shopify order id',
      recovery: 'reconciliation against the Shopify orders API, redelivered through the adopted code',
      verification: ['every Shopify order in the window has exactly one NetSuite sales order'],
    },
    {
      id: 'netsuite',
      name: 'NetSuite',
      role: 'target',
      api: 'NetSuite REST record API + SuiteQL',
      version: 'record/v1',
      auth: 'OAuth 1.0a token-based authentication (TBA)',
      client: 'adopted src/netsuite.js (fetch, OAuth 1.0a signing)',
      operations: [
        { name: 'salesOrder upsert by external id', kind: 'write', effect: 'creates or replaces one sales order' },
        { name: 'SuiteQL query', kind: 'read', effect: 'verification and reconciliation' },
      ],
      semantics: 'a sales order with the same items, quantities and prices as the source order',
      idempotency: 'PUT salesOrder/eid:shopify-<order id> (upsert by external id)',
      recovery: 'redelivery runs the same upsert; the external id makes it exactly-once',
      verification: ['one sales order per external id', 'items, quantities and prices equal the Shopify order'],
    },
  ],
  transactions: {
    one: 'order',
    many: 'orders',
    record: 'sales order',
    businessData: 'items, quantities and prices',
  },
  adopted: {
    repository: ADOPTED.repository,
    commit: ADOPTED.commit,
    license: ADOPTED.license,
    package: ADOPTED.packageName,
    attachment: 'dependency',
    entryPoints: ADOPTED.entryPoints,
    notUsed: ADOPTED.notUsed,
  },
  execution: {
    trigger: 'Shopify orders/create webhook (HMAC-verified, durably received), plus reconciliation recovery',
    idempotency:
      'NetSuite upsert by external id shopify-<order id> (PUT salesOrder/eid:…) and one delivery per order',
  },
  dependencies: [
    {
      provider: 'shopify',
      contract: 'orders/create webhook payload',
      version: 'webhook API version (X-Shopify-API-Version)',
      usedFor: 'every field src/mapping.js reads (input contract)',
    },
    {
      provider: 'shopify',
      contract: 'GraphQL Admin API orders query',
      version: '2026-10',
      usedFor: 'discovery, reconciliation, recovery input, business-data checks',
    },
    {
      provider: 'netsuite',
      contract: 'REST record salesOrder (eid upsert) + SuiteQL',
      version: 'record/v1',
      usedFor: 'writes (adopted code) and destination verification (ours)',
    },
  ],
  capabilities: {
    discovery:
      'Recent Shopify orders (30 days, ≤100) matched to NetSuite sales orders with the adopted code’s signature: externalId shopify-<order id> and the order number as reference.',
    monitoring: [
      { signal: 'source_available', method: 'Shopify Admin API shop query with the customer’s token' },
      { signal: 'destination_available', method: 'NetSuite SuiteQL query with the M2M token' },
      { signal: 'credentials', method: 'connection status and token refresh outcome' },
      { signal: 'activity', method: 'recent Shopify orders vs orders received by us' },
      { signal: 'processing', method: 'deliveries pending more than 10 minutes' },
      { signal: 'delayed', method: 'held and failed deliveries' },
      { signal: 'rejected', method: 'deliveries NetSuite rejected' },
      { signal: 'missing', method: 'scheduled reconciliation (Shopify vs NetSuite)' },
      { signal: 'duplicated', method: 'reconciliation: more than one NetSuite record per order' },
      {
        signal: 'contract_change',
        method: 'input contract of the adopted code, checked before every execution',
      },
      {
        signal: 'destination_verification',
        method: 'completed consistent reconciliation in the last 24 hours',
      },
      { signal: 'commitment_boundary', method: 'escalated maintenance events and unsupported changes' },
    ],
    recovery:
      'Missing orders are rebuilt from the Shopify Admin API and run through the same adopted executor; held orders are released after a correction.',
    verification:
      'NetSuite sales order read back by external id; items, quantities and unit prices compared to Shopify’s order record.',
    corrections: [
      {
        pattern: 'field_moved',
        status: 'implemented',
        note: 'adapter: copy a documented replacement field into the field the adopted code reads',
      },
      { pattern: 'precision', status: 'implemented', note: 'reviewed patch p0001 (operator activation)' },
      {
        pattern: 'reauthorization',
        status: 'not_supported',
        note: 'lost Shopify/NetSuite authorization is detected and the customer is asked to reconnect; automatic recovery of held orders after reconnecting is not implemented for this integration',
      },
      {
        pattern: 'api_version_pin',
        status: 'not_supported',
        note: 'Shopify webhooks cannot be re-fetched in an older version',
      },
      { pattern: 'business_meaning', status: 'not_supported', note: 'routed to a person (unsupported)' },
    ],
  },
  limitations: [
    'NetSuite OneWorld: the adopted code sends no subsidiary; OneWorld accounts reject its orders.',
    'orders/create only: order edits and cancellations after creation are not synchronized.',
    'Shopify does not expose other apps’ webhook subscriptions; discovery relies on NetSuite records.',
  ],
  responsibilities: {
    version: 'r1',
    maintain: [
      'Run your Shopify → NetSuite order integration for you: the same software you run today, pinned to a known version.',
      'Receive Shopify’s new-order notifications at our service and create each order in NetSuite exactly once.',
      'Check Shopify and NetSuite against each other and recover orders that never arrived.',
      'Adapt the integration when Shopify or NetSuite change, verify the result, and tell you what happened.',
    ],
    access: [
      'Shopify: read your orders, and register a new-order notification for our service.',
      'NetSuite: create sales orders; read customers, items and sales orders.',
    ],
    verify: [
      'Every Shopify order is in NetSuite exactly once, with the same items, quantities and prices.',
      'Orders that never reached NetSuite are found by comparing both systems.',
    ],
  },
};
