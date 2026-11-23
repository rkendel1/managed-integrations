import { ProviderError, type ErrorClass } from '@mi/contracts';
import { parseRetryAfter } from './retry.ts';

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
  json(): unknown;
}

/**
 * Single HTTP primitive used by both provider clients. Enforces a timeout and converts
 * network-level failures into classified ProviderErrors. Never logs request bodies or headers.
 */
export async function httpRequest(
  provider: 'shopify' | 'netsuite',
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal, redirect: 'manual' });
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    throw new ProviderError(aborted ? 'Request timed out' : `Network error: ${(err as Error).message}`, 'transient', {
      provider,
      code: aborted ? 'TIMEOUT' : 'NETWORK',
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    text,
    json: () => {
      try {
        return JSON.parse(text);
      } catch {
        throw new ProviderError('Response was not valid JSON', 'transient', {
          provider,
          status: res.status,
          code: 'INVALID_JSON',
        });
      }
    },
  };
}

/** Status-code based classification, refined by each provider client using body error codes. */
export function classifyStatus(status: number): ErrorClass {
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'authentication';
  if (status === 403) return 'authorization';
  if (status === 408 || status === 502 || status === 503 || status === 504 || status === 500) return 'transient';
  if (status === 400 || status === 404 || status === 409 || status === 422) return 'invalid_data';
  if (status >= 500) return 'transient';
  if (status >= 400) return 'permanent';
  return 'unknown';
}

export function errorFromResponse(
  provider: 'shopify' | 'netsuite',
  res: HttpResponse,
  message: string,
  override?: { errorClass?: ErrorClass; code?: string },
): ProviderError {
  const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
  return new ProviderError(message, override?.errorClass ?? classifyStatus(res.status), {
    provider,
    status: res.status,
    ...(override?.code ? { code: override.code } : {}),
    ...(retryAfterMs != null ? { retryAfterMs } : {}),
  });
}
