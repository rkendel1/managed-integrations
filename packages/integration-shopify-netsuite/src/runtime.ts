import { eq } from 'drizzle-orm';
import { ProviderError } from '@mi/contracts';
import { integrations, integrationVersions, type Db } from '@mi/database';
import type { Logger } from '@mi/observability';
import { ConnectionCredentials, type ProviderEndpointConfig } from './connections.ts';
import { SyncEngine, type EngineDeps } from './engine.ts';
import type { IntegrationImplementation } from './implementation-api.ts';
import { loadImplementationArtifact } from './loader.ts';
import { NetSuiteClient } from './netsuite-client.ts';
import type { RetryPolicy } from './retry.ts';
import type { CredentialCipher } from './secrets.ts';
import { ShopifyClient } from './shopify-client.ts';

export interface RuntimeDeps {
  db: Db;
  cipher: CredentialCipher;
  endpoints: ProviderEndpointConfig;
  workerId: string;
  logger?: Logger;
  retry?: RetryPolicy;
  /** Override for tests: use this implementation instead of loading the pinned artifact. */
  implementationOverride?: IntegrationImplementation;
}

export interface IntegrationRuntime {
  engine: SyncEngine;
  shopify: ShopifyClient;
  netsuite: NetSuiteClient;
  implementation: IntegrationImplementation;
  implementationVersionId: string | null;
}

/** Resolves the implementation version to execute: the canary version when requested, else the pinned version. */
export async function resolveImplementation(
  db: Db,
  versionId: string | null,
  override?: IntegrationImplementation,
): Promise<{ impl: IntegrationImplementation; versionId: string | null }> {
  if (override) return { impl: override, versionId };
  if (!versionId) throw new Error('Integration has no implementation version pinned');
  const [v] = await db.select().from(integrationVersions).where(eq(integrationVersions.id, versionId));
  if (!v) throw new Error(`Implementation version ${versionId} not found`);
  return { impl: await loadImplementationArtifact(v.artifactPath, v.artifactSha256), versionId: v.id };
}

/** Builds clients and engine for one integration from durable connection state. */
export async function buildRuntime(
  deps: RuntimeDeps,
  integrationId: string,
  opts: { useCanary?: boolean } = {},
): Promise<IntegrationRuntime> {
  const [integration] = await deps.db.select().from(integrations).where(eq(integrations.id, integrationId));
  if (!integration) throw new Error(`Integration ${integrationId} not found`);
  const versionId = opts.useCanary ? integration.canaryVersionId : integration.implementationVersionId;
  const { impl, versionId: resolvedVersion } = await resolveImplementation(
    deps.db,
    versionId,
    deps.implementationOverride,
  );

  const creds = new ConnectionCredentials(deps.db, deps.cipher, deps.endpoints);
  const shopConn = await creds.load(integration.tenantId, 'shopify');
  const nsConn = await creds.load(integration.tenantId, 'netsuite');
  if (!shopConn?.baseUrl || !nsConn?.baseUrl) {
    throw new ProviderError('Integration requires both Shopify and NetSuite connections', 'authentication', {
      provider: !shopConn?.baseUrl ? 'shopify' : 'netsuite',
      code: 'NOT_CONNECTED',
    });
  }
  const shopify = new ShopifyClient({
    baseUrl: shopConn.baseUrl,
    apiVersion: impl.shopifyApiVersion,
    auth: creds.shopifyAuth(shopConn),
  });
  const netsuite = new NetSuiteClient({ baseUrl: nsConn.baseUrl, auth: creds.netsuiteAuth(nsConn) });
  const engineDeps: EngineDeps = {
    db: deps.db,
    implementation: impl,
    implementationVersionId: resolvedVersion,
    shopify,
    netsuite,
    workerId: deps.workerId,
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.retry ? { retry: deps.retry } : {}),
  };
  return {
    engine: new SyncEngine(engineDeps),
    shopify,
    netsuite,
    implementation: impl,
    implementationVersionId: resolvedVersion,
  };
}
