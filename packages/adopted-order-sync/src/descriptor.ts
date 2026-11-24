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
  source: { id: 'shopify', name: 'Shopify' },
  destination: { id: 'netsuite', name: 'NetSuite' },
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
