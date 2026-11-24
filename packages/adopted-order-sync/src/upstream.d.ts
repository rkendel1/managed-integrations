/**
 * Type declarations for the ADOPTED upstream package `shopify-sync`
 * (github.com/Milo-ai-HQ/shopify-erp-order-sync @ d01b51d, MIT). The upstream code is plain
 * JavaScript and is used unmodified; these declarations describe its existing exports only.
 */
declare module 'shopify-sync/src/sync.js' {
  import type { UpstreamAdapter, UpstreamCanonicalOrder, UpstreamSyncResult } from 'shopify-sync/types';
  export function syncOrder(
    adapter: UpstreamAdapter,
    order: UpstreamCanonicalOrder,
  ): Promise<UpstreamSyncResult>;
}
declare module 'shopify-sync/src/mapping.js' {
  import type { UpstreamCanonicalOrder } from 'shopify-sync/types';
  export function toCanonicalOrder(
    shopifyOrder: unknown,
    options?: { customerByEmail?: Record<string, string>; defaultCustomer?: string },
  ): UpstreamCanonicalOrder;
}
declare module 'shopify-sync/src/webhook.js' {
  export function verifyShopifyHmac(
    rawBody: Buffer,
    hmacHeader: string | undefined,
    secret: string | undefined,
  ): boolean;
}
declare module 'shopify-sync/src/adapters/netsuite.js' {
  import type { UpstreamAdapter } from 'shopify-sync/types';
  export function createNetSuiteAdapter(options: { baseUrl: string; accessToken: string; subsidiaryId?: string }): UpstreamAdapter;
}
declare module 'shopify-sync/src/errors.js' {
  export class ErpError extends Error {
    status: number;
    retryable: boolean;
    erp?: string;
  }
}
declare module 'shopify-sync/types' {
  export interface UpstreamCanonicalOrder {
    reference: string;
    externalId: string;
    customerCode: string;
    orderDate: string;
    currency?: string;
    note: string;
    lines: { sku: string; qty: number; unitPrice: number }[];
  }
  export interface UpstreamAdapter {
    name: string;
    findExisting(order: UpstreamCanonicalOrder): Promise<unknown>;
    create(order: UpstreamCanonicalOrder): Promise<{ id?: string; number?: string }>;
  }
  export type UpstreamSyncResult =
    | {
        status: 'created' | 'duplicate';
        erp: string;
        erpOrder: { id?: string; number?: string };
        reference: string;
      }
    | { status: 'rejected' | 'failed'; erp: string; reference: string; message: string };
}
