/**
 * The integrations Managed Integrations can manage (slice 6). The ONLY place that knows the list: the
 * API, worker and capabilities resolve integration-specific behaviour from here by flow type. Adding an
 * integration means adding its package and one entry below — not changing onboarding, the queues,
 * monitoring, the correction lifecycle, maintenance events, the customer product or operator tooling.
 */
import { createShopifyNetsuiteRuntime, SHOPIFY_NETSUITE } from '@mi/adopted-order-sync';
import { FLOW_TYPE } from '@mi/contracts';
import type { Db } from '@mi/database';
import type { CredentialCipher, ProviderEndpointConfig, RetryPolicy } from '@mi/integration-shopify-netsuite';
import { IntegrationRegistry, type IntegrationDescriptor, type WorkServices } from '@mi/managed';

/** Slice 1's native engine (our own code, not adopted). Managed by the slice-1 reliability mechanisms. */
export const NATIVE_SHOPIFY_NETSUITE: IntegrationDescriptor = {
  flowType: FLOW_TYPE,
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
  adopted: null,
  execution: {
    trigger: 'scheduled polling of Shopify orders by updatedAt watermark',
    idempotency: 'NetSuite upsert by external id and a durable delivery per order',
  },
  dependencies: [
    {
      provider: 'shopify',
      contract: 'GraphQL Admin API orders query',
      version: '2026-10',
      usedFor: 'reading orders',
    },
    {
      provider: 'netsuite',
      contract: 'REST record salesOrder + SuiteQL',
      version: 'record/v1',
      usedFor: 'writes and verification',
    },
  ],
  capabilities: {
    discovery: null,
    monitoring: [
      { signal: 'processing', method: 'sync runs and freshness (slice-1 reliability checks)' },
      { signal: 'missing', method: 'scheduled reconciliation' },
      { signal: 'duplicated', method: 'scheduled reconciliation' },
      { signal: 'rejected', method: 'rejected deliveries' },
      {
        signal: 'destination_verification',
        method: 'completed consistent reconciliation in the last 24 hours',
      },
    ],
    recovery:
      'redelivery by legacy id through the native engine; repairs through the maintenance agent and releases',
    verification: 'NetSuite sales orders compared with Shopify orders by reconciliation',
    corrections: [
      {
        pattern: 'field_moved',
        status: 'not_supported',
        note: 'the native engine is repaired by releases, not adapters',
      },
    ],
  },
  limitations: ['Not self-onboardable; enrolled by an operator (slice 1).'],
  responsibilities: null,
};

export const DESCRIPTORS: readonly IntegrationDescriptor[] = [SHOPIFY_NETSUITE, NATIVE_SHOPIFY_NETSUITE];

export function descriptorFor(flowType: string): IntegrationDescriptor | undefined {
  return DESCRIPTORS.find((d) => d.flowType === flowType);
}

export interface RegistryDeps {
  db: Db;
  cipher: CredentialCipher;
  endpoints: ProviderEndpointConfig;
  services: WorkServices;
  webhookBaseUrl: string;
  workerId: string;
  reconcileIntervalMinutes: number;
  retry?: RetryPolicy;
}

export function createRegistry(deps: RegistryDeps): IntegrationRegistry {
  return new IntegrationRegistry(deps.db, [
    createShopifyNetsuiteRuntime(deps),
    { descriptor: NATIVE_SHOPIFY_NETSUITE },
  ]);
}

export { IntegrationRegistry };
