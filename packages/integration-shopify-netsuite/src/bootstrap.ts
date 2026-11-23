import { CONTRACT_V1, type IntegrationContractDefinition } from '@mi/contracts';
import { integrationContracts, providers, type Db } from '@mi/database';
import { sha256Hex } from './secrets.ts';
import { SHOPIFY_API_VERSION } from './implementation/shopify-orders.ts';

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function contractSha256(def: IntegrationContractDefinition): string {
  return sha256Hex(canonicalJson(def));
}

/** Idempotently registers providers and the published contract. Contracts are immutable. */
export async function bootstrapReferenceData(db: Db): Promise<void> {
  await db
    .insert(providers)
    .values([
      {
        id: 'shopify',
        displayName: 'Shopify',
        apiVersion: SHOPIFY_API_VERSION,
        capabilities: [
          'orders.read (GraphQL Admin API)',
          'oauth.authorization_code (expiring offline tokens)',
        ],
        documentation: [
          'https://shopify.dev/docs/api/admin-graphql/latest/queries/orders',
          'https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens',
          'https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits',
        ],
      },
      {
        id: 'netsuite',
        displayName: 'NetSuite',
        apiVersion: 'record/v1',
        capabilities: ['salesOrder.upsert (eid)', 'suiteql.query', 'oauth2.client_credentials (M2M)'],
        documentation: [
          'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156335203191.html',
          'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_162755359851.html',
          'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_157909186990.html',
        ],
      },
    ])
    .onConflictDoNothing();
  const sha = contractSha256(CONTRACT_V1);
  await db
    .insert(integrationContracts)
    .values({
      version: CONTRACT_V1.version,
      flowType: CONTRACT_V1.flowType,
      definition: CONTRACT_V1,
      definitionSha256: sha,
    })
    .onConflictDoNothing();
}
