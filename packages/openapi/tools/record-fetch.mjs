// Records an application's provider HTTP exchanges without changing the application: loaded with
// NODE_OPTIONS="--import <this file>", it wraps globalThis.fetch and appends one JSON line per call whose path
// matches MI_RECORD_PATH_PREFIX (default /v1/) to MI_RECORD_FILE. Request bodies are reduced to their field
// names (form keys or top-level JSON keys); credentials are never written.
import { appendFileSync } from 'node:fs';
const file = process.env.MI_RECORD_FILE;
const prefix = process.env.MI_RECORD_PATH_PREFIX ?? '/v1/';
if (file && typeof globalThis.fetch === 'function') {
  const original = globalThis.fetch;
  globalThis.fetch = async function recorded(input, init = {}) {
    // Transparent: the call is made exactly as given; recording never throws and never changes the result.
    const res = await original.call(this, input, init);
    let url;
    try { url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); } catch { return res; }
    if (!url.pathname.startsWith(prefix)) return res;
    try {
    let requestFields = [];
    const body = init.body;
    if (typeof body === 'string') {
      if (body.trim().startsWith('{')) { try { requestFields = Object.keys(JSON.parse(body)); } catch { /* not JSON: no fields */ } }
      else requestFields = [...new URLSearchParams(body).keys()];
    }
    let response = null;
    try { response = await res.clone().json(); } catch { /* not JSON: no body recorded */ }
    appendFileSync(file, JSON.stringify({ method: (init.method ?? 'GET').toUpperCase(), path: url.pathname, query: [...url.searchParams.keys()], requestFields, status: res.status, response, idempotencyKey: new Headers(init.headers ?? {}).get('idempotency-key'), stripeVersion: new Headers(init.headers ?? {}).get('stripe-version') }) + '\n');
    } catch { /* recording never changes the call */ }
    return res;
  };
}
