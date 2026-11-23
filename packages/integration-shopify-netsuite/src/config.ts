import { z } from 'zod';
import type { ProviderEndpointConfig } from './connections.ts';
import { CredentialCipher, parseKeyRing } from './secrets.ts';

/**
 * Service configuration, validated at startup. Fails closed:
 *  - runtime services (api, worker) refuse to start in production without encryption keys
 *  - fixture endpoint overrides are refused in production
 *  - the maintenance role must NOT be given encryption keys (it never handles credentials)
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  CREDENTIAL_ENCRYPTION_KEYS: z.string().optional(),
  SHOPIFY_CLIENT_ID: z.string().default(''),
  SHOPIFY_CLIENT_SECRET: z.string().default(''),
  SHOPIFY_BASE_URL_OVERRIDE: z.string().url().optional(),
  NETSUITE_BASE_URL_OVERRIDE: z.string().url().optional(),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  SESSION_SECRET: z.string().optional(),
  ARTIFACT_DIR: z.string().default('./var/artifacts'),
  SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(5),
  RECONCILE_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(10080).default(60),
  LOG_LEVEL: z.string().default('info'),
});

export type ServiceRole = 'api' | 'worker' | 'maintenance';

export interface ServiceConfig {
  env: z.infer<typeof EnvSchema>;
  production: boolean;
  cipher: CredentialCipher | null;
  endpoints: ProviderEndpointConfig;
}

export function loadServiceConfig(role: ServiceRole, source: NodeJS.ProcessEnv = process.env): ServiceConfig {
  // Empty values (e.g. `VAR=` in compose overlays) mean "unset".
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const env = parsed.data;
  const production = env.NODE_ENV === 'production';
  if (role === 'maintenance' && env.CREDENTIAL_ENCRYPTION_KEYS) {
    throw new Error('The maintenance role must not be configured with CREDENTIAL_ENCRYPTION_KEYS');
  }
  const ring = role === 'maintenance' ? undefined : parseKeyRing(env.CREDENTIAL_ENCRYPTION_KEYS);
  if (role !== 'maintenance' && !ring) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEYS is required (format keyId:base64-32-bytes)');
  }
  if (production && (env.SHOPIFY_BASE_URL_OVERRIDE || env.NETSUITE_BASE_URL_OVERRIDE)) {
    throw new Error('Provider base URL overrides are not permitted in production');
  }
  if (production && role === 'api' && (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)) {
    throw new Error('SESSION_SECRET (>=32 chars) is required in production');
  }
  if (production && role !== 'maintenance' && (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET)) {
    throw new Error('SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET are required in production');
  }
  return {
    env,
    production,
    cipher: ring ? new CredentialCipher(ring) : null,
    endpoints: {
      shopifyClientId: env.SHOPIFY_CLIENT_ID,
      shopifyClientSecret: env.SHOPIFY_CLIENT_SECRET,
      ...(env.SHOPIFY_BASE_URL_OVERRIDE ? { shopifyBaseUrlOverride: env.SHOPIFY_BASE_URL_OVERRIDE } : {}),
      ...(env.NETSUITE_BASE_URL_OVERRIDE ? { netsuiteBaseUrlOverride: env.NETSUITE_BASE_URL_OVERRIDE } : {}),
      production,
    },
  };
}
