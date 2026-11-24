/**
 * Provider connections are shared by every integration and application that uses the provider (slice 7):
 * they live in @mi/provider-connections. Ledgerly-specific helpers that read QuickBooks journal entries stay
 * re-exported here for the modules of this package.
 */
export * from '@mi/provider-connections';
