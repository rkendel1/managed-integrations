/**
 * The reliability contract for the ADOPTED Shopify → NetSuite order flow. It describes what the
 * adopted software actually does (verified by tracing and tests), not what the native engine does.
 */
import type { IntegrationContractDefinition } from '@mi/contracts';
import { z } from 'zod';

/** Flow identifier stored on `integrations.flow_type` for integrations executed by the adopted code. */
export const ADOPTED_FLOW_TYPE = 'adopted.shopify_erp_order_sync.netsuite';

/**
 * The adopted code's own configuration model (its env vars ERP, CUSTOMER_BY_EMAIL, DEFAULT_CUSTOMER),
 * stored durably per tenant. NetSuite base URL and credentials come from the tenant's connection.
 */
export const AdoptedConfigSchema = z.object({
  erp: z.literal('netsuite'),
  customerByEmail: z.record(z.string().email(), z.string().min(1)).default({}),
  defaultCustomer: z.string().min(1).default('WEB'),
});
export type AdoptedConfig = z.infer<typeof AdoptedConfigSchema>;

export const ADOPTED_CONTRACT: IntegrationContractDefinition = {
  version: 'adopted-1.0.0',
  flowType: ADOPTED_FLOW_TYPE as never,
  scope: {
    source: 'Shopify `orders/create` webhook (REST webhook payload)',
    destination: 'NetSuite SuiteTalk REST salesOrder',
    objects: ['Shopify order (on creation) → NetSuite sales order'],
    fields: [
      {
        source: 'order.id',
        destination: 'salesOrder.externalId',
        rule: '"shopify-" + id (upstream mapping.js)',
      },
      { source: 'order.name', destination: 'salesOrder.otherRefNum', rule: 'copied' },
      { source: 'order.created_at', destination: 'salesOrder.tranDate', rule: 'date part' },
      { source: 'order.note', destination: 'salesOrder.memo', rule: 'copied' },
      {
        source: 'customer email',
        destination: 'salesOrder.entity',
        rule: 'customerByEmail → entityid lookup, else defaultCustomer',
      },
      {
        source: 'line_items[].sku',
        destination: 'item.items[].item',
        rule: 'itemid lookup in NetSuite; lines without SKU dropped',
      },
      {
        source: 'line_items[].quantity / price',
        destination: 'item.items[].quantity / rate',
        rule: 'copied (price rounded to 2 dp)',
      },
    ],
    excluded: [
      'Order updates and cancellations (only orders/create is handled by the adopted code)',
      'Historical backfill and polling (webhook-driven only)',
      'Subsidiary (not sent by the adopted code — OneWorld accounts reject these orders)',
      'Refunds, fulfillment, inventory, catalog',
    ],
  },
  direction: {
    source: 'Shopify (webhooks received; no API reads)',
    destination: 'NetSuite',
    permittedWrites: ['Upsert salesOrder by externalId "shopify-<order id>"'],
    neverWrites: ['Shopify', 'Deletion of any NetSuite record'],
  },
  // Event-driven: there is no polling interval, so no freshness commitment can be made (0 = not applicable).
  freshness: { syncIntervalMinutes: 0, maxAcceptableDelayMinutes: 0 },
  completeness: [
    'Every received orders/create webhook with a valid signature is recorded durably before it is acknowledged.',
    'Orders whose webhook never reached us are NOT detected in this version (no reconciliation for the adopted flow).',
  ],
  correctness: [
    'Customer and items must already exist in NetSuite (looked up by entityid / itemid); otherwise the order is rejected with the NetSuite message.',
  ],
  idempotency: [
    'NetSuite upsert by externalId: a re-executed order updates the same record (verified); it never creates a second one.',
    'Shopify webhook retries (same X-Shopify-Webhook-Id) are deduplicated at receipt; an already-delivered order is not re-executed.',
  ],
  recovery: [
    'Transient failures (network, 429, 5xx) are retried by the adopted code (3 retries), then rescheduled by Managed Integrations with backoff (up to 5 executions).',
    'Rejected orders and exhausted retries can be retried by the customer or an operator through AppPort after the cause is fixed.',
  ],
  compatibility: [
    'The adopted implementation is pinned to an upstream commit; upgrades are a reviewed lockfile change with the inherited and adoption test suites as the gate.',
  ],
  responsibility: {
    weOwn: [
      'Durable receipt, execution, retry scheduling and evidence',
      'NetSuite authorization (M2M tokens)',
      'Incident visibility and operator recovery',
    ],
    customerOwns: [
      'NetSuite customers and items must exist with matching codes',
      'Customer e-mail → NetSuite customer map',
    ],
  },
  limitations: [
    'Unverified against real Shopify and NetSuite (fixtures only).',
    'The adopted code sends no subsidiary; NetSuite OneWorld accounts reject every order until upstream supports it.',
  ],
};

/** Registers the adopted contract (immutable, idempotent). */
export async function registerAdoptedContract(db: import('@mi/database').Db): Promise<void> {
  const { integrationContracts } = await import('@mi/database');
  const { contractSha256 } = await import('@mi/integration-shopify-netsuite');
  await db
    .insert(integrationContracts)
    .values({
      version: ADOPTED_CONTRACT.version,
      flowType: ADOPTED_FLOW_TYPE,
      definition: ADOPTED_CONTRACT,
      definitionSha256: contractSha256(ADOPTED_CONTRACT),
    })
    .onConflictDoNothing();
}
