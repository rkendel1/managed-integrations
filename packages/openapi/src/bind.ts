/**
 * Bind: AppPort provider capabilities for the operations an overlay exposes — no hand-written HTTP client, and no
 * second invocation layer. Each capability is an ordinary AppPort capability (`defineProvider` +
 * `providerCapability`, instantiated by the host with its external-call recorder), so authorization, idempotency,
 * the external-effect lifecycle (begin → succeeded | failed | unknown) and MCP exposure are AppPort's.
 *
 * Generated per operation from the normalized contract: path/query/body placement, encoding (form or JSON, from the
 * operation's content type), the credential, and pre-flight conformance (unknown or missing request fields are
 * refused before anything is sent). Not generated: what the operation MEANS — that is the overlay's.
 */
import { defineProvider, effectFailed, providerCapability, type ProviderDefinition } from '@appport/core';
import { s } from '@appport/schema';
import { checkExchange } from './conformance.ts';
import type { NormalizedContract, NormalizedOperation } from './normalize.ts';
import type { Overlay } from './overlay.ts';

/** Stripe-style form encoding (a[b]=v, a[0][b]=v) — the convention `application/x-www-form-urlencoded` APIs use. */
export function formEncode(value: Record<string, unknown>, prefix = ''): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (item && typeof item === 'object' ? out.push(...formEncode(item as Record<string, unknown>, `${key}[${i}]`)) : out.push([`${key}[${i}]`, String(item)])));
    else if (typeof v === 'object') out.push(...formEncode(v as Record<string, unknown>, key));
    else out.push([key, String(v)]);
  }
  return out;
}

export interface BoundRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  formKeys: string[];
}

/** Builds the HTTP request for one operation from structured input. Pure (testable without a network). */
export function buildRequest(op: NormalizedOperation, baseUrl: string, input: { path?: Record<string, string>; query?: Record<string, unknown>; body?: Record<string, unknown>; idempotencyKey?: string }, auth: Record<string, string>): BoundRequest {
  let path = op.path;
  for (const p of op.parameters.filter((x) => x.in === 'path')) {
    const v = input.path?.[p.name];
    if (v === undefined) throw new Error(`${op.key}: path parameter ${p.name} is required`);
    path = path.replace(`{${p.name}}`, encodeURIComponent(v));
  }
  const q = new URLSearchParams(formEncode(input.query ?? {}));
  const url = `${baseUrl.replace(/\/$/, '')}${path}${q.size ? `?${q}` : ''}`;
  const headers: Record<string, string> = { ...auth };
  let body: string | undefined;
  let formKeys: string[] = [];
  if (input.body && op.request.contentType === 'application/x-www-form-urlencoded') {
    const pairs = formEncode(input.body);
    formKeys = pairs.map(([k]) => k);
    body = new URLSearchParams(pairs).toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  } else if (input.body) {
    formKeys = Object.keys(input.body);
    body = JSON.stringify(input.body);
    headers['content-type'] = 'application/json';
  }
  if (input.idempotencyKey) headers['idempotency-key'] = input.idempotencyKey;
  return { method: op.method, url, headers, body, formKeys };
}

/** AppPort capability names are lowercase `<namespace>.<operation>` (ASCII letters and digits). */
export const capabilityName = (provider: string, op: NormalizedOperation) =>
  `${provider.toLowerCase().replace(/[^a-z0-9]/g, '')}.${(op.operationId ?? op.key).toLowerCase().replace(/[^a-z0-9]/g, '')}`;

export interface ProviderRuntime {
  baseUrl: string;
  auth: Record<string, string>;
  fetch: typeof fetch;
}

/**
 * The provider definition for an adoption: one capability per operation the overlay exposes. Destructive
 * operations are never bound unless the overlay exposes them with a known effect (checkOverlay enforces it).
 */
export function providerFromContract(p: {
  id: string;
  contract: NormalizedContract;
  overlay: Overlay;
  credential: { id: string; header: (secret: string) => Record<string, string> };
  extraHeaders?: Record<string, string>;
  fetch?: typeof fetch;
}): ProviderDefinition<{ baseUrl: string }, ProviderRuntime> {
  const bound = Object.entries(p.overlay.operations).filter(([key, o]) => o.expose && p.contract.operations[key]);
  return defineProvider<{ baseUrl: string }, ProviderRuntime>({
    id: p.id,
    version: p.contract.version,
    description: `${p.contract.title} ${p.contract.version} (contract ${p.contract.contractHash.slice(0, 12)})`,
    configuration: s.object({ baseUrl: s.string() }),
    credentials: [{ id: p.credential.id, description: `${p.contract.title} credential` }],
    async start(ctx) {
      const secret = await ctx.credential(p.credential.id);
      if (!secret) throw new Error(`${p.credential.id} is not set`);
      return { runtime: { baseUrl: ctx.config.baseUrl, auth: { ...p.credential.header(secret), ...(p.extraHeaders ?? {}) }, fetch: p.fetch ?? fetch } };
    },
    capabilities: bound.map(([key, o]) => {
      const op = p.contract.operations[key]!;
      const write = op.effect.value !== 'read';
      return providerCapability<ProviderRuntime, Record<string, unknown>, Record<string, unknown>>({
        name: capabilityName(p.id, op),
        version: 1,
        description: `${op.key} — ${o.identity.value}`,
        input: s.object({
          path: s.optional(s.record(s.string())),
          query: s.optional(s.record(s.unknown())),
          body: s.optional(s.record(s.unknown())),
          idempotencyKey: s.optional(s.string()),
        }),
        output: s.record(s.unknown()),
        async handler(input, ctx) {
          const req = buildRequest(op, ctx.provider.runtime.baseUrl, input as never, ctx.provider.runtime.auth);
          // Pre-flight conformance: nothing that the contract does not describe is sent.
          const pre = checkExchange(p.contract, { method: op.method, path: new URL(req.url).pathname, requestFields: req.formKeys, status: 0, response: null }).filter((v) => v.side !== 'response');
          if (pre.length) throw effectFailed('INVALID_INPUT', `Request does not conform to ${op.key}: ${pre.map((v) => v.detail).join('; ')}`);
          if (write) await ctx.effect.begin({ operation: op.key, ...(req.headers['idempotency-key'] ? { idempotencyKey: req.headers['idempotency-key'] } : {}) });
          const res = await ctx.provider.runtime.fetch(req.url, { method: req.method, headers: req.headers, ...(req.body !== undefined ? { body: req.body } : {}) });
          const text = await res.text();
          const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
          // A 4xx answer is the provider saying it did not do it; a 5xx after begin() leaves the outcome unknown.
          if (res.status >= 400 && res.status < 500) throw effectFailed('CONFLICT', `${op.key} refused (${res.status})`, json as never);
          if (res.status >= 500) throw new Error(`${op.key} answered ${res.status}`);
          return json;
        },
      });
    }),
  });
}
