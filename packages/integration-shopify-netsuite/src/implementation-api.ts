/**
 * STABLE INTERFACE between the sync engine and a versioned integration implementation.
 *
 * The implementation (src/implementation/**) is the provider-facing code that must change when
 * a provider API changes: GraphQL documents, response parsing and destination mapping. It is
 * bundled into immutable, checksummed artifacts (IntegrationVersion) so releases can be canaried
 * and rolled back without redeploying the engine.
 *
 * Changing this file is a change to the engine contract, not a repair.
 */
import type { CanonicalOrder, IntegrationConfig } from '@mi/contracts';

export const IMPLEMENTATION_API_VERSION = 1;

export type ParsedOrder =
  | { ok: true; order: CanonicalOrder }
  | { ok: false; sourceId: string; legacyId: string | null; updatedAt: string | null; errors: string[] };

export interface OrdersPage {
  orders: ParsedOrder[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface NetSuiteSalesOrderPayload {
  externalId: string;
  entity: { id: string };
  subsidiary?: { id: string };
  tranDate: string;
  otherRefNum: string;
  memo: string;
  item: { items: { item: { id: string }; quantity: number; rate: number }[] };
}

/** Non-PII summary recorded as delivery evidence and used by reconciliation. */
export interface DeliverySummary {
  lineCount: number;
  /** Sum of quantity × rate in minor units (cents), computed on the payload actually sent. */
  computedTotalMinor: number;
  currencyCode: string;
  lines: { itemId: string; quantity: number; rateMinor: number }[];
}

export type MappingResult =
  | { kind: 'deliver'; payload: NetSuiteSalesOrderPayload; summary: DeliverySummary }
  | { kind: 'skip'; reason: string }
  | { kind: 'reject'; reasons: string[] };

export interface IntegrationImplementation {
  apiVersion: typeof IMPLEMENTATION_API_VERSION;
  /** Shopify Admin API version this implementation targets. */
  shopifyApiVersion: string;
  /** GraphQL document for paginated order retrieval. Variables: first, after, query. */
  ordersQuery: string;
  /** GraphQL document for a single order. Variables: id (GID). */
  orderByIdQuery: string;
  parseOrdersPage(data: unknown): OrdersPage;
  parseOrder(data: unknown): ParsedOrder | null;
  externalIdFor(legacyId: string): string;
  mapOrder(order: CanonicalOrder, config: IntegrationConfig): MappingResult;
}
