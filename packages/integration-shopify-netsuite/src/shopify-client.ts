import { ProviderError } from '@mi/contracts';
import { errorFromResponse, httpRequest } from './http.ts';

export interface ShopifyAuth {
  getAccessToken(): Promise<string>;
  /** Forces a refresh (after a 401). Throws ProviderError('authentication') if impossible. */
  forceRefresh(): Promise<string>;
}

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface GraphqlResult {
  data: unknown;
  cost?: { requestedQueryCost?: number; actualQueryCost?: number | null; throttleStatus?: ThrottleStatus };
}

interface GraphqlError {
  message?: string;
  extensions?: { code?: string };
}

const SCHEMA_ERROR_CODES = new Set([
  'undefinedField',
  'argumentNotAccepted',
  'undefinedType',
  'GRAPHQL_VALIDATION_FAILED',
]);

/** Classifies a GraphQL error list returned with HTTP 200. Exported for unit tests. */
export function classifyGraphqlErrors(errors: GraphqlError[], cost?: GraphqlResult['cost']): ProviderError {
  const first = errors[0] ?? {};
  const code = first.extensions?.code ?? '';
  const message = errors
    .map((e) => e.message ?? '')
    .join('; ')
    .slice(0, 1000);
  if (code === 'THROTTLED') {
    const ts = cost?.throttleStatus;
    const need = (cost?.requestedQueryCost ?? 0) - (ts?.currentlyAvailable ?? 0);
    const retryAfterMs =
      ts && ts.restoreRate > 0 ? Math.max(1000, Math.ceil((need / ts.restoreRate) * 1000)) : 1000;
    return new ProviderError('Shopify GraphQL throttled', 'rate_limited', {
      provider: 'shopify',
      code,
      retryAfterMs,
      context: { throttleStatus: ts },
    });
  }
  if (code === 'ACCESS_DENIED') {
    return new ProviderError(`Shopify access denied: ${message}`, 'authorization', {
      provider: 'shopify',
      code,
    });
  }
  if (code === 'MAX_COST_EXCEEDED') {
    return new ProviderError(`Shopify query cost exceeded: ${message}`, 'permanent', {
      provider: 'shopify',
      code,
    });
  }
  if (
    SCHEMA_ERROR_CODES.has(code) ||
    /Cannot query field|doesn't exist on type|Unknown argument|Unknown type/i.test(message)
  ) {
    return new ProviderError(`Shopify GraphQL schema mismatch: ${message}`, 'schema', {
      provider: 'shopify',
      code: code || 'SCHEMA',
      context: { errors: errors.slice(0, 5).map((e) => ({ message: e.message, code: e.extensions?.code })) },
    });
  }
  if (code === 'INTERNAL_SERVER_ERROR') {
    return new ProviderError(`Shopify internal error: ${message}`, 'transient', {
      provider: 'shopify',
      code,
    });
  }
  return new ProviderError(`Shopify GraphQL error: ${message}`, 'unknown', { provider: 'shopify', code });
}

export class ShopifyClient {
  constructor(
    private readonly opts: {
      baseUrl: string; // https://{shop}.myshopify.com (or fixture URL in tests)
      apiVersion: string;
      auth: ShopifyAuth;
      timeoutMs?: number;
    },
  ) {}

  get apiVersion(): string {
    return this.opts.apiVersion;
  }

  async graphql(query: string, variables: Record<string, unknown>): Promise<GraphqlResult> {
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/admin/api/${this.opts.apiVersion}/graphql.json`;
    let token = await this.opts.auth.getAccessToken();
    for (let authAttempt = 0; authAttempt < 2; authAttempt++) {
      const res = await httpRequest('shopify', url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
        body: JSON.stringify({ query, variables }),
        timeoutMs: this.opts.timeoutMs ?? 30_000,
      });
      if (res.status === 401 && authAttempt === 0) {
        token = await this.opts.auth.forceRefresh();
        continue;
      }
      if (res.status === 402) {
        throw errorFromResponse('shopify', res, 'Shopify shop is frozen (payment required)', {
          errorClass: 'authorization',
          code: 'PAYMENT_REQUIRED',
        });
      }
      if (res.status === 423) {
        throw errorFromResponse('shopify', res, 'Shopify shop is locked', {
          errorClass: 'authorization',
          code: 'LOCKED',
        });
      }
      if (res.status !== 200) throw errorFromResponse('shopify', res, `Shopify HTTP ${res.status}`);
      const body = res.json() as {
        data?: unknown;
        errors?: GraphqlError[] | string;
        extensions?: { cost?: GraphqlResult['cost'] };
      };
      const cost = body.extensions?.cost;
      if (typeof body.errors === 'string') {
        throw new ProviderError(`Shopify error: ${body.errors}`, 'unknown', { provider: 'shopify' });
      }
      if (body.errors?.length) throw classifyGraphqlErrors(body.errors, cost);
      return { data: body.data, ...(cost ? { cost } : {}) };
    }
    throw new ProviderError('Shopify rejected credentials after refresh', 'authentication', {
      provider: 'shopify',
      status: 401,
    });
  }
}
