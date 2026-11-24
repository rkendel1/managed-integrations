/**
 * @mi/openapi against the REAL Stripe contracts (stripe/openapi v1267 = API 2024-06-20, v1618 = 2025-03-31.basil,
 * official, MIT) and small purpose-built documents for parser edge cases.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createApplication, instantiateProvider, MemoryExternalCallRecorder } from '@appport/core';
import { createRequest } from '@appport/protocol';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildRequest,
  checkExchange,
  checkOverlay,
  ContractError,
  diffContracts,
  fromFile,
  generateTypes,
  impactOf,
  normalize,
  providerFromContract,
  sha256,
  subset,
  type NormalizedContract,
  type Overlay,
  type UsageManifest,
} from '../src/index.ts';
import { createStripeFixture } from '@mi/test-fixtures';

const here = (p: string) => join(import.meta.dirname, '..', p);
const PROV = JSON.parse(readFileSync(here('specs/PROVENANCE.json'), 'utf8')) as Record<string, { sha256: string; commit: string }>;
const tmp = mkdtempSync(join(tmpdir(), 'mi-openapi-'));
function stripe(tag: 'v1267' | 'v1618') {
  const raw = gunzipSync(readFileSync(here(`specs/stripe-${tag}.json.gz`))).toString('utf8');
  const path = join(tmp, `stripe-${tag}.json`);
  writeFileSync(path, raw);
  return fromFile(path, { authority: 'official', license: 'MIT' });
}
const json = (o: unknown) => {
  const p = join(tmp, `doc-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(o));
  return fromFile(p, { authority: 'derived' });
};
const mini = (extra: Record<string, unknown> = {}) => ({
  openapi: '3.0.3',
  info: { title: 'Mini', version: '1' },
  paths: {
    '/things': {
      get: { operationId: 'ListThings', parameters: [{ name: 'starting_after', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Thing' } }, has_more: { type: 'boolean' } } } } } } } },
      post: { operationId: 'PostThings', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, size: { type: 'integer' } } } } } }, responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } } } } },
    },
    '/things/{id}': { delete: { operationId: 'DeleteThing', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok' } } } },
  },
  components: {
    schemas: { Thing: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, name: { type: 'string' }, status: { type: 'string', enum: ['active', 'archived'] } } } },
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
  },
  security: [{ bearerAuth: [] }],
  ...extra,
});

let v1267: NormalizedContract;
let v1618: NormalizedContract;
let doc1267: Record<string, unknown>;
beforeAll(async () => {
  const a = stripe('v1267');
  doc1267 = a.document;
  v1267 = await normalize(a.document, a.source);
  const b = stripe('v1618');
  v1618 = await normalize(b.document, b.source);
}, 120_000);

const saaskitUsage = JSON.parse(readFileSync(here('adoptions/saaskit-stripe.usage.json'), 'utf8')) as UsageManifest;
const appUsage = JSON.parse(readFileSync(here('adoptions/subscriptions-app-stripe.usage.json'), 'utf8')) as UsageManifest;
const saaskitOverlay = JSON.parse(readFileSync(here('adoptions/saaskit-stripe.overlay.json'), 'utf8')) as Overlay;

describe('contract: acquire and normalize', () => {
  it('imports the official Stripe contract: provenance, operations, security, pagination; normalization is deterministic', async () => {
    expect(v1267.source.sha256).toBe(PROV['stripe-v1267.json.gz']!.sha256);
    expect(v1267).toMatchObject({ version: '2024-06-20', openapi: '3.0.0', source: { authority: 'official', license: 'MIT' } });
    expect(Object.keys(v1267.operations)).toHaveLength(550);
    expect(Object.keys(v1267.schemas).length).toBeGreaterThan(1000);
    const again = stripe('v1267');
    expect((await normalize(again.document, again.source)).contractHash).toBe(v1267.contractHash);
    expect(Object.keys(v1267.securitySchemes).sort()).toEqual(['basicAuth', 'bearerAuth']);
    expect(v1267.operations['GET /v1/payment_intents']!.pagination).toEqual({ kind: 'cursor', parameters: ['ending_before', 'limit', 'starting_after'], status: 'inferred' });
    expect(v1267.operations['POST /v1/payment_intents']!).toMatchObject({ effect: { value: 'write', status: 'inferred' }, request: { contentType: 'application/x-www-form-urlencoded' } });
    expect(v1267.operations['POST /v1/payment_intents']!.request.fields['amount']).toEqual({ type: 'integer', required: true });
    expect(v1267.schemas['payment_intent']!.fields['amount_received']).toMatchObject({ type: 'integer' });
    // Stripe's OpenAPI declares no webhooks: event payloads are not described as such (recorded, not invented).
    expect(Object.keys(v1267.webhooks)).toHaveLength(0);
    // every operation SaaSKit's client calls is in the contract it pins
    for (const o of saaskitUsage.operations) expect(v1267.operations[o.key], o.key).toBeTruthy();
  });

  it('refuses invalid documents and unresolvable references; Swagger 2.0 is refused with a reason', async () => {
    await expect(normalize({ openapi: '3.0.3', info: { title: 'x' }, paths: 7 }, json({ openapi: '3.0.3', info: {}, paths: {} }).source)).rejects.toBeInstanceOf(ContractError);
    const bad = mini();
    (bad.paths['/things'].post.responses['200'].content['application/json'].schema as { $ref: string }).$ref = '#/components/schemas/Missing';
    await expect(normalize(bad, json(bad).source)).rejects.toThrow(/Invalid OpenAPI document/);
    await expect(normalize({ swagger: '2.0', info: { title: 'x', version: '1' }, paths: {} }, json({ openapi: '3.0.0' }).source)).rejects.toThrow(/2\.0/);
  });

  it('circular references normalize (stopping at the named schema); external references are bundled', async () => {
    const circ = mini();
    (circ.components.schemas as Record<string, unknown>)['Node'] = { type: 'object', properties: { id: { type: 'string' }, children: { type: 'array', items: { $ref: '#/components/schemas/Node' } } } };
    const c = await normalize(circ, json(circ).source);
    expect(c.schemas['Node']!.fields['children']).toEqual({ type: 'array<ref:Node>', required: false });
    const dir = mkdtempSync(join(tmpdir(), 'mi-ext-'));
    writeFileSync(join(dir, 'thing.json'), JSON.stringify({ type: 'object', properties: { id: { type: 'string' }, weight: { type: 'number' } } }));
    const ext = mini();
    (ext.components.schemas as Record<string, unknown>)['Thing'] = { $ref: './thing.json' };
    writeFileSync(join(dir, 'api.json'), JSON.stringify(ext));
    const s = fromFile(join(dir, 'api.json'), { authority: 'derived' });
    const prev = process.cwd();
    process.chdir(dir);
    try {
      const e = await normalize(s.document, s.source);
      expect(Object.values(e.schemas).some((x) => 'weight' in x.fields)).toBe(true);
    } finally {
      process.chdir(prev);
    }
  });

  it('discovers OpenAPI 3.1 webhooks and their payload fields', async () => {
    const d = { ...mini(), openapi: '3.1.0', webhooks: { thingCreated: { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Thing' } } } }, responses: { '200': { description: 'ok' } } } } } };
    const c = await normalize(d, json(d).source);
    expect(c.webhooks['thingCreated']).toMatchObject({ schema: 'Thing', fields: { id: { type: 'string', required: true } } });
  });
});

describe('generation and binding', () => {
  it('generates types for the subset an adoption uses — reproducible, with provenance, nothing else', async () => {
    const keys = saaskitUsage.operations.map((o) => o.key);
    const a = await generateTypes(doc1267, keys, { sourceSha256: v1267.source.sha256, label: 'Stripe 2024-06-20 for SaaSKit' });
    const b = await generateTypes(doc1267, keys, { sourceSha256: v1267.source.sha256, label: 'Stripe 2024-06-20 for SaaSKit' });
    expect(sha256(a.source)).toBe(sha256(b.source));
    expect(a.source).toMatch(/GENERATED — do not edit/);
    expect(a.source).toContain(v1267.source.sha256);
    expect(a.source).toContain('"/v1/payment_intents"');
    expect(a.source).not.toContain('"/v1/accounts"');
    expect(Object.keys(a.subset['paths'] as object).sort()).toEqual(['/v1/checkout/sessions', '/v1/customers', '/v1/payment_intents', '/v1/payment_intents/{intent}', '/v1/payment_methods/{payment_method}', '/v1/refunds']);
  }, 120_000);

  it('the overlay is checked: "known" needs a source; a destructive operation is never exposed by inference', async () => {
    expect(checkOverlay(saaskitOverlay, v1267.operations)).toEqual([]);
    const m = await normalize(mini(), json(mini()).source);
    const risky: Overlay = { format: 'mi.openapi.overlay/1', application: 't', provider: 'mini', contract: { version: '1', sha256: '' }, invariants: [], operations: { 'DELETE /things/{id}': { expose: true, effect: { status: 'inferred', value: 'destructive' }, idempotency: { status: 'known', value: 'x' }, identity: { status: 'unverified', value: 'id' } } } };
    expect(checkOverlay(risky, m.operations)).toEqual(expect.arrayContaining(['DELETE /things/{id}: destructive operation exposed without a known effect', 'DELETE /things/{id}.idempotency: "known" needs a source']));
  });

  it('a bound operation runs as an AppPort provider capability: request built from the contract, effect recorded, refusal recorded as failed, non-conforming input never sent', async () => {
    const fx = createStripeFixture({ prefix: 'Oa' });
    await fx.app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(fx.app.server.address() as { port: number }).port}`;
    try {
      const contract = subset(v1267, saaskitUsage.operations.map((o) => o.key));
      const provider = providerFromContract({ id: 'stripe', contract, overlay: saaskitOverlay, credential: { id: 'secret-key', header: (k) => ({ authorization: `Bearer ${k}`, 'stripe-version': '2024-06-20' }) } });
      expect(provider.capabilities).toHaveLength(6);
      const instance = await provider.start({ name: 'stripe', config: { baseUrl: base }, credential: async () => fx.apiKey(), log: { info() {}, warn() {}, error() {} }, signal: new AbortController().signal });
      const recorder = new MemoryExternalCallRecorder();
      const caps = instantiateProvider(provider, instance, { name: 'stripe', recorder });
      const app = createApplication({ application: { id: 'mi.openapi.test', name: 'test', version: '1.0.0' }, capabilities: caps, authorizer: { authorize: async () => ({ allowed: true }) } } as never);
      const call = (name: string, input: unknown) => app.handleRequest(createRequest({ requestId: `r${Math.random()}`, capability: { name, version: 1 }, input }), { transport: 'test' } as never) as Promise<{ ok: boolean; output?: Record<string, unknown>; error?: { code: string; message: string } }>;
      const name = 'stripe.postpaymentintents';
      expect(caps.map((c) => c.name).sort()).toEqual(['stripe.getpaymentintentsintent', 'stripe.getpaymentmethodspaymentmethod', 'stripe.postcheckoutsessions', 'stripe.postcustomers', 'stripe.postpaymentintents', 'stripe.postrefunds']);
      const ok = await call(name, { body: { amount: 1200, currency: 'usd', metadata: { invoiceId: 'inv_1' } }, idempotencyKey: 'charge:inv_1:1' });
      expect(ok).toMatchObject({ ok: true, output: { object: 'payment_intent', amount: 1200 } });
      const missing = await call(name, { body: { currency: 'usd' } }); // refused before anything is sent (amount is required)
      expect(missing.error!.message).toMatch(/requires amount/);
      const refused = await call(name, { body: { amount: 0, currency: 'usd' } }); // conforming, but the provider refuses it
      expect(refused.ok).toBe(false);
      const unknownField = await call(name, { body: { amount: 5, currency: 'usd', not_a_stripe_field: 'x' } });
      expect(unknownField).toMatchObject({ ok: false });
      expect(unknownField.error!.message).toMatch(/does not conform/);
      const calls = [...((recorder as unknown as { calls: Map<string, { outcome?: string }> }).calls?.values?.() ?? [])];
      if (calls.length) expect(calls.map((c) => c.outcome).sort()).toEqual(['failed', 'succeeded']);
      expect(fx.state.paymentIntents.size).toBe(1); // the non-conforming request was never sent
      expect([...fx.state.idempotency.keys()].some((k) => k.endsWith(':charge:inv_1:1'))).toBe(true);
    } finally {
      await fx.app.close();
    }
  });

  it('builds the same request SaaSKit’s own client sends (form keys and idempotency key)', () => {
    const op = v1267.operations['POST /v1/payment_intents']!;
    const r = buildRequest(op, 'https://api.stripe.com', { body: { amount: 2900, currency: 'usd', customer: 'cus_1', payment_method: 'pm_1', off_session: true, confirm: true, description: 'Invoice', metadata: { accountId: 'a', invoiceId: 'i' } }, idempotencyKey: 'charge:i:1' }, { authorization: 'Bearer k' });
    // SaaSKit components/stripe/stripe.ts:125 sends exactly these fields (formEncode, same bracket convention)
    expect(r.formKeys.sort()).toEqual(['amount', 'confirm', 'currency', 'customer', 'description', 'metadata[accountId]', 'metadata[invoiceId]', 'off_session', 'payment_method']);
    expect(r.headers['idempotency-key']).toBe('charge:i:1');
    expect(checkExchange(v1267, { method: 'POST', path: '/v1/payment_intents', requestFields: r.formKeys, status: 0, response: null })).toEqual([]);
  });
});

describe('compatibility: contract changes attributed to adopted applications', () => {
  it('2024-06-20 → 2025-03-31.basil: the change Slice 7 met is found in the official contracts and attributed to the code that reads it; SaaSKit is assessed separately', () => {
    const changes = diffContracts(v1267, v1618);
    expect(changes.find((c) => c.kind === 'version.changed')).toMatchObject({ before: '2024-06-20', after: '2025-03-31.basil' });
    const subs = impactOf(changes, appUsage, v1267, v1618);
    expect(subs.verdict).toBe('affected_breaking');
    const hits = subs.affected.map((i) => `${i.change.subject} ${i.change.field} ${i.change.kind} @ ${i.usedAt.split(':').pop()}`).sort();
    // Exactly the three fields Slice 7's reviewed patch p0001 reads from their new places — nothing else.
    expect(hits).toEqual(['schema:invoice paid response.field_removed @ 50', 'schema:invoice subscription response.field_removed @ 46', 'schema:subscription current_period_end response.field_removed @ 21']);
    expect(changes.length).toBeGreaterThan(1000);
    const sk = impactOf(changes, saaskitUsage, v1267, v1618);
    // Nothing SaaSKit sends (observed) or reads (cited) changed in basil.
    expect(sk).toMatchObject({ verdict: 'unaffected', affected: [] });
    writeFileSync(join(tmp, 'saaskit-basil-impact.json'), JSON.stringify(sk, null, 2));
  });

  it('classifies each kind of change', async () => {
    const a = await normalize(mini(), json(mini()).source);
    const changed = mini();
    changed.info.version = '2';
    (changed.paths['/things'].post.requestBody.content['application/json'].schema as { required: string[] }).required.push('size'); // now required
    (changed.paths['/things'].post.requestBody.content['application/json'].schema.properties as Record<string, unknown>)['color'] = { type: 'string' };
    (changed.paths['/things'] as Record<string, unknown>)['get'] = undefined;
    delete (changed.paths['/things'] as Record<string, unknown>)['get'];
    (changed.components.schemas.Thing.properties as Record<string, unknown>)['label'] = { type: 'string' };
    delete (changed.components.schemas.Thing.properties as Record<string, unknown>)['name'];
    changed.components.schemas.Thing.properties.status.enum = ['active'];
    (changed.components.securitySchemes as Record<string, unknown>)['bearerAuth'] = { type: 'apiKey', in: 'header', name: 'X-Key' };
    const b = await normalize(changed, json(changed).source);
    const kinds = diffContracts(a, b).map((c) => `${c.kind}${c.breaking ? '!' : ''}`).sort();
    expect(kinds).toEqual(expect.arrayContaining(['version.changed', 'request.field_became_required!', 'request.field_added_optional', 'operation.removed!', 'response.field_added', 'response.field_removed!', 'response.enum_value_removed!', 'security.scheme_changed!']));
    const w1 = { ...mini(), openapi: '3.1.0', webhooks: { thingCreated: { post: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } }, responses: { '200': { description: 'ok' } } } } } };
    const w2 = structuredClone(w1);
    (w2.webhooks.thingCreated.post.requestBody.content['application/json'].schema.properties as Record<string, unknown>)['id'] = { type: 'integer' };
    const wd = diffContracts(await normalize(w1, json(w1).source), await normalize(w2, json(w2).source));
    expect(wd.map((c) => c.kind)).toContain('webhook.changed');
    // attribution: only the application that uses the removed operation is affected
    const user: UsageManifest = { application: 'lister', operations: [{ key: 'GET /things', usedAt: 'lister.ts:3' }], reads: [] };
    const other: UsageManifest = { application: 'creator', operations: [{ key: 'POST /things', usedAt: 'creator.ts:9' }], reads: [] };
    const all = diffContracts(a, b);
    expect(impactOf(all, user, a, b).affected.map((i) => i.change.kind)).toEqual(['operation.removed']);
    expect(impactOf(all, other, a, b).verdict).toBe('affected_breaking'); // size became required
  });
});

describe('SaaSKit benchmark (its own client, its own suite, unchanged)', () => {
  it('every Stripe request SaaSKit sent during its 33-test suite conforms to the contract it pins; the simulator’s answers are measured against real Stripe', () => {
    // Recorded by packages/openapi/tools/record-fetch.mjs while `feltkit test` ran SaaSKit @ 8ead17d (33/33 passed).
    const log = readFileSync(join(import.meta.dirname, '../../../docs/evidence/runs/saaskit-stripe-exchanges.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Parameters<typeof checkExchange>[1] & { stripeVersion: string; idempotencyKey: string | null });
    expect(log.length).toBe(70);
    expect(new Set(log.map((x) => x.stripeVersion))).toEqual(new Set(['2024-06-20']));
    // every write carried an idempotency key (the overlay's "known" idempotency, observed)
    expect(log.filter((x) => x.method === 'POST' && !x.idempotencyKey)).toEqual([]);
    const req: string[] = [];
    const resp: Record<string, Set<string>> = {};
    for (const x of log)
      for (const v of checkExchange(v1267, x)) {
        if (v.side === 'response') (resp[v.operation!] ??= new Set()).add(`${v.problem}:${v.field}`);
        else req.push(`${x.method} ${x.path}: ${v.detail}`);
      }
    expect(req).toEqual([]); // SaaSKit's client speaks the 2024-06-20 contract exactly
    const fidelity = Object.fromEntries(Object.entries(resp).map(([k, v]) => [k, [...v].sort()]));
    // The simulator is not Stripe: it omits fields Stripe marks required and adds fields Stripe does not have.
    expect(fidelity['POST /v1/checkout/sessions']).toEqual(expect.arrayContaining(['unknown_field:pi_metadata', 'missing_required:expires_at']));
    expect(Object.keys(fidelity).sort()).toEqual(['GET /v1/payment_intents/{intent}', 'GET /v1/payment_methods/{payment_method}', 'POST /v1/checkout/sessions', 'POST /v1/customers', 'POST /v1/payment_intents', 'POST /v1/refunds']);
    const changes = diffContracts(v1267, v1618);
    writeFileSync(
      join(import.meta.dirname, '../../../docs/evidence/runs/openapi-saaskit-benchmark.json'),
      JSON.stringify({ contract: { tag: 'v1267', version: v1267.version, sha256: v1267.source.sha256, contractHash: v1267.contractHash }, exchanges: log.length, requestViolations: req, simulatorResponseFidelity: fidelity, basil: { saaskit: impactOf(changes, saaskitUsage, v1267, v1618), subscriptionsApp: impactOf(changes, appUsage, v1267, v1618), changesInContract: changes.length, breakingInContract: changes.filter((c) => c.breaking).length } }, null, 2),
    );
  });
});
