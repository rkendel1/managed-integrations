import { z } from 'zod';

export const FLOW_TYPE = 'shopify_orders_to_netsuite_sales_orders' as const;

/* ------------------------------------------------------------------------------------------
 * Error classification (spec §11). Every provider failure is mapped to exactly one class.
 * ---------------------------------------------------------------------------------------- */
export const ERROR_CLASSES = [
  'transient',
  'rate_limited',
  'authentication',
  'authorization',
  'invalid_data',
  'schema',
  'permanent',
  'unknown',
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly errorClass: ErrorClass,
    readonly details: {
      provider: 'shopify' | 'netsuite';
      status?: number;
      code?: string;
      retryAfterMs?: number;
      /** Sanitised provider-facing context (never secrets, never full payloads). */
      context?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = 'ProviderError';
  }
  get retryable(): boolean {
    return this.errorClass === 'transient' || this.errorClass === 'rate_limited';
  }
}

/* ------------------------------------------------------------------------------------------
 * Canonical order: the internal representation between the source adapter and the mapping.
 * Contains only fields in contract scope.
 * ---------------------------------------------------------------------------------------- */
export const CanonicalOrderSchema = z.object({
  sourceId: z.string().min(1), // Shopify GID
  legacyId: z.string().regex(/^\d+$/),
  name: z.string().min(1), // e.g. #1001
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  cancelledAt: z.string().datetime({ offset: true }).nullable(),
  currencyCode: z.string().length(3),
  totalAmount: z.string().regex(/^-?\d+(\.\d+)?$/),
  email: z.string().nullable(),
  lineItems: z
    .array(
      z.object({
        sku: z.string().nullable(),
        title: z.string(),
        quantity: z.number().int().positive(),
        unitPrice: z.string().regex(/^-?\d+(\.\d+)?$/),
      }),
    )
    .min(1),
});
export type CanonicalOrder = z.infer<typeof CanonicalOrderSchema>;

/* ------------------------------------------------------------------------------------------
 * Integration configuration (customer-specific, durable, validated).
 * Deliberately narrow: no arbitrary mapping DSL.
 * ---------------------------------------------------------------------------------------- */
export const IntegrationConfigSchema = z.object({
  /** Orders updated on/after this instant are in scope for the historical backfill. */
  backfillFrom: z.string().datetime({ offset: true }),
  /** NetSuite internal id of the customer record used as the sales order entity. */
  netsuiteCustomerId: z.string().regex(/^\d+$/),
  /** NetSuite subsidiary internal id (OneWorld accounts). Null for non-OneWorld. */
  netsuiteSubsidiaryId: z.string().regex(/^\d+$/).nullable(),
  /** The only currency accepted; orders in other currencies are rejected as invalid data. */
  currencyCode: z.string().length(3),
  /** SKU → NetSuite item internal id. Unknown SKUs are rejected (customer action). */
  skuMap: z.record(z.string().min(1), z.string().regex(/^\d+$/)),
  /** Page size for Shopify order retrieval. */
  pageSize: z.number().int().min(1).max(100).default(50),
});
export type IntegrationConfig = z.infer<typeof IntegrationConfigSchema>;

/* ------------------------------------------------------------------------------------------
 * The reliability contract. Versioned, immutable once published, stored in the DB and
 * rendered verbatim to the customer. Changing semantics requires a new version.
 * ---------------------------------------------------------------------------------------- */
export interface IntegrationContractDefinition {
  version: string;
  flowType: typeof FLOW_TYPE;
  scope: {
    source: string;
    destination: string;
    objects: string[];
    fields: { source: string; destination: string; rule: string }[];
    excluded: string[];
  };
  direction: { source: string; destination: string; permittedWrites: string[]; neverWrites: string[] };
  freshness: { syncIntervalMinutes: number; maxAcceptableDelayMinutes: number };
  completeness: string[];
  correctness: string[];
  idempotency: string[];
  recovery: string[];
  compatibility: string[];
  responsibility: { weOwn: string[]; customerOwns: string[] };
  limitations: string[];
}

export const CONTRACT_V1: IntegrationContractDefinition = {
  version: '1.0.0',
  flowType: FLOW_TYPE,
  scope: {
    source: 'Shopify Admin GraphQL API (orders)',
    destination: 'NetSuite SuiteTalk REST (salesOrder record)',
    objects: ['Shopify Order → NetSuite Sales Order'],
    fields: [
      { source: 'Order.legacyResourceId', destination: 'salesOrder.externalId', rule: '"shopify-" + id' },
      { source: 'Order.name', destination: 'salesOrder.otherRefNum', rule: 'copied verbatim' },
      { source: 'Order.createdAt', destination: 'salesOrder.tranDate', rule: 'UTC date part' },
      { source: '(configuration)', destination: 'salesOrder.entity', rule: 'configured customer id' },
      { source: '(configuration)', destination: 'salesOrder.subsidiary', rule: 'configured subsidiary id' },
      { source: 'Order.name', destination: 'salesOrder.memo', rule: '"Shopify order " + name' },
      { source: 'LineItem.sku', destination: 'item.items[].item.id', rule: 'configured SKU map' },
      { source: 'LineItem.quantity', destination: 'item.items[].quantity', rule: 'copied' },
      { source: 'LineItem unit price', destination: 'item.items[].rate', rule: 'pre-discount unit price' },
    ],
    excluded: [
      'Refunds, returns, fulfillments, inventory, product catalog',
      'Discounts, shipping lines, taxes (NetSuite computes tax under its own configuration)',
      'Customer record creation or matching (a single configured customer entity is used)',
      'Edits to orders after delivery (detected and reported, not propagated)',
    ],
  },
  direction: {
    source: 'Shopify (read-only)',
    destination: 'NetSuite',
    permittedWrites: ['Create or upsert salesOrder identified by externalId "shopify-<order id>"'],
    neverWrites: [
      'Shopify (no writes of any kind)',
      'NetSuite records without our externalId prefix',
      'Deletion of any NetSuite record',
    ],
  },
  freshness: { syncIntervalMinutes: 5, maxAcceptableDelayMinutes: 30 },
  completeness: [
    'Every non-cancelled Shopify order updated on/after the configured backfill start is expected in NetSuite.',
    'Completeness is established only by reconciliation: source orders in a window are compared against delivery evidence and NetSuite records found by externalId.',
    'If either side cannot be fully read, the reconciliation result is "partial" or "unknown" — never "consistent".',
  ],
  correctness: [
    'Orders are validated before delivery: currency must equal the configured currency, every line SKU must be mapped, quantities positive.',
    'After delivery the NetSuite record is identified by externalId; reconciliation compares line count and computed total (sum of quantity × rate) with the source.',
    'An HTTP success response alone is not treated as proof of correctness.',
  ],
  idempotency: [
    'Each order maps to a deterministic externalId; delivery uses NetSuite upsert (PUT salesOrder/eid:<externalId>), so retries cannot create a second record.',
    'Each delivery has an idempotency key of (integration, source order id); an order with a durable delivered outcome is not re-sent.',
    'A crash between the NetSuite write and recording the outcome is safe: the retry upserts the same externalId.',
    'Duplicate source events (overlapping windows, repeated pages) collapse onto the same key.',
  ],
  recovery: [
    'Transient and rate-limit errors are retried with exponential backoff and jitter, honouring Retry-After.',
    'The cursor never advances past an order that lacks a durable terminal outcome (delivered, skipped, or rejected).',
    'Interrupted runs are detected by lease expiry and resumed from the last durable cursor.',
    'Missing records found by reconciliation are re-delivered automatically.',
    'Failures that deterministic recovery cannot fix open an incident and an internal maintenance task; fixes are released only after independent validation and human approval.',
  ],
  compatibility: [
    'Contract versions are semantic; semantics change only with a new version that the customer can review.',
    'Implementation versions are immutable, identified by source commit and artifact checksum, and can be rolled back.',
    'The pinned Shopify API version is reviewed at least every 12 months (Shopify supports each stable version for ≥12 months).',
  ],
  responsibility: {
    weOwn: [
      'Detecting and recovering failed, missing or stale deliveries within scope',
      'Adapting to provider API changes',
      'Cursor, retry, idempotency and reconciliation correctness',
      'Incident communication with evidence',
    ],
    customerOwns: [
      'Granting and maintaining Shopify and NetSuite authorization',
      'Maintaining the SKU → NetSuite item map when new products are sold',
      'NetSuite configuration (mandatory custom fields, approval workflows, tax setup)',
      'Records rejected as invalid data that require a business decision',
    ],
  },
  limitations: [
    'Without Shopify read_all_orders approval only the last 60 days of orders are readable.',
    'Reliability is not perfect: unknown states are reported as unknown rather than hidden.',
  ],
};

/* ------------------------------------------------------------------------------------------
 * Shared enums for durable lifecycle state.
 * ---------------------------------------------------------------------------------------- */
export const SYNC_RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'partial',
  'failed',
  'interrupted',
] as const;
export type SyncRunStatus = (typeof SYNC_RUN_STATUSES)[number];

export const DELIVERY_OUTCOMES = ['pending', 'delivered', 'skipped', 'rejected', 'failed'] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

export const INCIDENT_STATUSES = [
  'detected',
  'classified',
  'investigating',
  'recoverable',
  'requires_action',
  'recovery',
  'verification',
  'resolved',
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_KINDS = [
  'sync_failure',
  'freshness_breach',
  'connection_auth',
  'records_rejected',
  'reconciliation_discrepancy',
  'schema_drift',
  /** Adopted flow: a provider input no longer satisfies what the adopted code reads (slice 4). */
  'input_contract_change',
] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export const RECONCILIATION_OUTCOMES = ['consistent', 'discrepancies', 'partial', 'unknown'] as const;
export type ReconciliationOutcome = (typeof RECONCILIATION_OUTCOMES)[number];
export * from './queues.ts';
