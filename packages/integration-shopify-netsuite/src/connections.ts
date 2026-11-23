import { createHmac, generateKeyPairSync } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { ProviderError } from '@mi/contracts';
import { connections, type Db } from '@mi/database';
import { httpRequest } from './http.ts';
import { NetSuiteM2MAuth, type NetSuiteM2MCredentials } from './netsuite-client.ts';
import { safeEqualHex, type CredentialCipher } from './secrets.ts';
import type { ShopifyAuth } from './shopify-client.ts';

export const SHOPIFY_REQUIRED_SCOPES = ['read_orders'] as const;

export interface ProviderEndpointConfig {
  shopifyClientId: string;
  shopifyClientSecret: string;
  /** Dev/test only: route all Shopify calls to a fixture. Refused in production. */
  shopifyBaseUrlOverride?: string;
  netsuiteBaseUrlOverride?: string;
  production: boolean;
}

export interface ShopifyCredentials {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  scope: string;
}

/* ----------------------------------- SSRF-safe endpoint resolution ----------------------------------- */

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/;
const NETSUITE_HOST_RE = /^[a-z0-9][a-z0-9-]{0,40}\.suitetalk\.api\.netsuite\.com$/;

export function normalizeShopDomain(input: string): string {
  const d = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (!SHOP_DOMAIN_RE.test(d)) throw new Error('Shop domain must look like <store>.myshopify.com');
  return d;
}

export function resolveShopifyBaseUrl(shopDomain: string, cfg: ProviderEndpointConfig): string {
  const domain = normalizeShopDomain(shopDomain);
  if (cfg.shopifyBaseUrlOverride) {
    if (cfg.production) throw new Error('SHOPIFY_BASE_URL_OVERRIDE is not permitted in production');
    return cfg.shopifyBaseUrlOverride;
  }
  return `https://${domain}`;
}

/**
 * NetSuite account domains must not be constructed from the account id (Oracle guidance); the
 * customer supplies the domain shown under Setup > Company > Company URLs and we validate it.
 */
export function resolveNetSuiteBaseUrl(accountDomain: string, cfg: ProviderEndpointConfig): string {
  if (cfg.netsuiteBaseUrlOverride) {
    if (cfg.production) throw new Error('NETSUITE_BASE_URL_OVERRIDE is not permitted in production');
    return cfg.netsuiteBaseUrlOverride;
  }
  const host = accountDomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (!NETSUITE_HOST_RE.test(host))
    throw new Error('NetSuite domain must look like <account>.suitetalk.api.netsuite.com');
  return `https://${host}`;
}

/* ----------------------------------- Shopify OAuth (authorization code grant) ----------------------------------- */

export function buildShopifyAuthorizeUrl(p: {
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const u = new URL('/admin/oauth/authorize', p.baseUrl);
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('scope', SHOPIFY_REQUIRED_SCOPES.join(','));
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('state', p.state);
  return u.toString();
}

/** Verifies the `hmac` query parameter Shopify appends to the OAuth callback. */
export function verifyShopifyCallbackHmac(query: Record<string, string>, clientSecret: string): boolean {
  const { hmac, signature: _signature, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('&');
  const digest = createHmac('sha256', clientSecret).update(message).digest('hex');
  return safeEqualHex(digest, hmac);
}

async function tokenRequest(baseUrl: string, body: Record<string, string>): Promise<ShopifyCredentials> {
  const res = await httpRequest('shopify', `${baseUrl.replace(/\/$/, '')}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    timeoutMs: 20_000,
  });
  if (res.status === 401 || res.status === 400) {
    throw new ProviderError(
      'Shopify rejected the token request; the merchant must re-authorize',
      'authentication',
      {
        provider: 'shopify',
        status: res.status,
        code: 'REAUTHORIZE',
      },
    );
  }
  if (res.status !== 200) {
    throw new ProviderError(
      `Shopify token endpoint HTTP ${res.status}`,
      res.status >= 500 || res.status === 429 ? 'transient' : 'unknown',
      {
        provider: 'shopify',
        status: res.status,
      },
    );
  }
  const b = res.json() as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    refresh_token_expires_in: number;
    scope: string;
  };
  if (!b.access_token || !b.refresh_token) {
    throw new ProviderError('Shopify token response missing expiring token fields', 'unknown', {
      provider: 'shopify',
    });
  }
  const now = Date.now();
  return {
    accessToken: b.access_token,
    refreshToken: b.refresh_token,
    accessTokenExpiresAt: new Date(now + b.expires_in * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(now + b.refresh_token_expires_in * 1000).toISOString(),
    scope: b.scope,
  };
}

export function exchangeShopifyCode(baseUrl: string, cfg: ProviderEndpointConfig, code: string) {
  return tokenRequest(baseUrl, {
    client_id: cfg.shopifyClientId,
    client_secret: cfg.shopifyClientSecret,
    code,
    expiring: '1',
  });
}

export function refreshShopifyToken(baseUrl: string, cfg: ProviderEndpointConfig, refreshToken: string) {
  return tokenRequest(baseUrl, {
    client_id: cfg.shopifyClientId,
    client_secret: cfg.shopifyClientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}

/* ----------------------------------- NetSuite M2M key material ----------------------------------- */

/**
 * Generates the RSA key pair whose public half the customer's NetSuite administrator maps to
 * the integration (Setup > Integration > OAuth 2.0 Client Credentials). NetSuite expects an
 * X.509 certificate; the runbook documents producing one from this key with openssl.
 */
export function generateNetSuiteKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/* ----------------------------------- DB-backed credential providers ----------------------------------- */

type ConnectionRow = typeof connections.$inferSelect;

export class ConnectionCredentials {
  constructor(
    private readonly db: Db,
    private readonly cipher: CredentialCipher,
    private readonly cfg: ProviderEndpointConfig,
  ) {}

  aad(row: Pick<ConnectionRow, 'id'>): string {
    return `connection:${row.id}`;
  }

  async load(tenantId: string, providerId: 'shopify' | 'netsuite'): Promise<ConnectionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(connections)
      .where(and(eq(connections.tenantId, tenantId), eq(connections.providerId, providerId)));
    return row;
  }

  private async markRevoked(id: string, reason: string): Promise<void> {
    await this.db
      .update(connections)
      .set({ status: 'revoked', revokedAt: new Date(), verificationError: reason, updatedAt: new Date() })
      .where(eq(connections.id, id));
  }

  /** Shopify auth with proactive refresh (5 min before expiry) and rotation-safe persistence. */
  shopifyAuth(row: ConnectionRow): ShopifyAuth {
    const self = {
      db: this.db,
      cipher: this.cipher,
      cfg: this.cfg,
      aad: (r: Pick<ConnectionRow, 'id'>) => this.aad(r),
      load: (t: string, p: 'shopify' | 'netsuite') => this.load(t, p),
      markRevoked: (id: string, reason: string) => this.markRevoked(id, reason),
    };
    let current = row;
    const usable = () => {
      if (
        !current.credentialsCiphertext ||
        current.status === 'revoked' ||
        current.status === 'disconnected'
      ) {
        throw new ProviderError('Shopify connection is not authorized', 'authentication', {
          provider: 'shopify',
          code: 'NOT_AUTHORIZED',
        });
      }
      return self.cipher.decrypt<ShopifyCredentials>(current.credentialsCiphertext, self.aad(current));
    };
    async function refresh(): Promise<string> {
      const creds = usable();
      const before = current.credentialsCiphertext!;
      let next: ShopifyCredentials;
      try {
        next = await refreshShopifyToken(current.baseUrl!, self.cfg, creds.refreshToken);
      } catch (err) {
        if (err instanceof ProviderError && err.errorClass === 'authentication') {
          // Another worker may have rotated the refresh token first: reload before giving up.
          const fresh = await self.load(current.tenantId, 'shopify');
          if (fresh && fresh.credentialsCiphertext && fresh.credentialsCiphertext !== before) {
            current = fresh;
            return usable().accessToken;
          }
          await self.markRevoked(current.id, 'Shopify refresh token rejected; merchant must re-authorize');
        }
        throw err;
      }
      const ciphertext = self.cipher.encrypt(next, self.aad(current));
      // Optimistic concurrency: only replace the envelope we refreshed from.
      const updated = await self.db
        .update(connections)
        .set({
          credentialsCiphertext: ciphertext,
          credentialsKeyId: self.cipher.keyId,
          accessTokenExpiresAt: new Date(next.accessTokenExpiresAt),
          refreshTokenExpiresAt: new Date(next.refreshTokenExpiresAt),
          updatedAt: new Date(),
        })
        .where(and(eq(connections.id, current.id), eq(connections.credentialsCiphertext, before)))
        .returning();
      if (updated[0]) current = updated[0];
      else current = (await self.load(current.tenantId, 'shopify')) ?? current;
      return updated[0] ? next.accessToken : usable().accessToken;
    }
    return {
      async getAccessToken() {
        const creds = usable();
        if (Date.parse(creds.accessTokenExpiresAt) - 5 * 60_000 <= Date.now()) return refresh();
        return creds.accessToken;
      },
      forceRefresh: refresh,
    };
  }

  netsuiteAuth(row: ConnectionRow): NetSuiteM2MAuth {
    if (!row.credentialsCiphertext || row.status === 'revoked' || row.status === 'disconnected') {
      throw new ProviderError('NetSuite connection is not authorized', 'authentication', {
        provider: 'netsuite',
        code: 'NOT_AUTHORIZED',
      });
    }
    const creds = this.cipher.decrypt<NetSuiteM2MCredentials>(row.credentialsCiphertext, this.aad(row));
    return new NetSuiteM2MAuth(row.baseUrl!, creds);
  }
}
