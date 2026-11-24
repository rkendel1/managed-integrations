// Types for the adopted upstream modules (plain JavaScript, no published types).
declare module "shopify-sync/src/mapping.js" {
  export function toCanonicalOrder(order: unknown, options?: { customerByEmail?: Record<string, string>; defaultCustomer?: string }): unknown;
}
declare module "shopify-sync/src/adapters/netsuite.js" {
  export function createNetSuiteAdapter(options: { baseUrl: string; accessToken: string }): unknown;
}
declare module "shopify-sync/src/sync.js" {
  export function syncOrder(adapter: unknown, order: unknown): Promise<unknown>;
}
declare module "shopify-sync/src/webhook.js" {
  export function verifyShopifyHmac(rawBody: Buffer | string, hmacHeader: string | undefined, secret: string): boolean;
}
