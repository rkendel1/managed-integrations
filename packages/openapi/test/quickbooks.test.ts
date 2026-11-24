/**
 * Second provider: QuickBooks. Intuit publishes no OpenAPI; the community spec is measured unusable. The same
 * pipeline runs on a DERIVED contract (cited to Intuit's docs) for the operations quickbooks-mcp actually uses:
 * the adopted application's real client traffic is checked against it, and the binding mechanism is reused.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApplication, instantiateProvider, MemoryExternalCallRecorder } from '@appport/core';
import { createRequest } from '@appport/protocol';
import { expect, it } from 'vitest';
import { loadApplication } from '@mi/adopted-qbo-tools';
import { createQuickBooksFixture } from '@mi/test-fixtures';
import { checkExchange, checkOverlay, fromFile, normalize, providerFromContract, type Overlay } from '../src/index.ts';

const here = (p: string) => join(import.meta.dirname, '..', p);

it('quickbooks-mcp’s own client (node-quickbooks 2.0.48) speaks the derived contract; the same binding mechanism creates and reads an invoice', async () => {
  const s = fromFile(here('specs/derived/quickbooks-invoice.json'), { authority: 'derived', license: null });
  const c = await normalize(s.document, s.source);
  expect(Object.keys(c.operations).sort()).toEqual(['GET /v3/company/{realmId}/invoice/{invoiceId}', 'GET /v3/company/{realmId}/query', 'POST /v3/company/{realmId}/invoice']);
  const overlay = JSON.parse(readFileSync(here('adoptions/quickbooks-mcp-qbo.overlay.json'), 'utf8')) as Overlay;
  expect(checkOverlay(overlay, c.operations)).toEqual([]);

  const fx = createQuickBooksFixture();
  await fx.app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(fx.app.server.address() as { port: number }).port}`;
  fx.state.accessTokens.set('tok', Date.now() + 3600e3);
  try {
    // 1. The adopted application, unchanged, through its own client library.
    const app = await loadApplication([], 'openapi-bench');
    await app.handleCreateInvoice(app.client({ accessToken: 'tok', realmId: fx.realmId, apiBase: base }), { txn_date: '2026-11-24', customer_name: 'Acme Corp', doc_number: 'OA-1', lines: [{ item_name: 'Consulting', amount: 300 }, { item_name: 'Design', qty: 2, unit_price: 120 }], draft: false });
    const traffic = fx.state.requestLog.filter((r) => r.userAgent?.startsWith('node-quickbooks'));
    expect(traffic.map((r) => r.method).sort()).toEqual(['GET', 'GET', 'GET', 'POST']);
    const violations = traffic.flatMap((r) => checkExchange(c, { method: r.method, path: r.path, requestFields: r.bodyKeys ?? [], status: 0, response: null }));
    expect(violations).toEqual([]);
    expect(new Set(traffic.map((r) => r.minorRequested))).toEqual(new Set([75]));

    // 2. The same mechanism as for Stripe binds the second provider: JSON encoding, OAuth bearer, effect recording.
    const provider = providerFromContract({ id: 'quickbooks', contract: c, overlay, credential: { id: 'access-token', header: (t) => ({ authorization: `Bearer ${t}`, accept: 'application/json' }) } });
    const instance = await provider.start({ name: 'quickbooks', config: { baseUrl: base }, credential: async () => 'tok', log: { info() {}, warn() {}, error() {} }, signal: new AbortController().signal });
    const recorder = new MemoryExternalCallRecorder();
    const caps = instantiateProvider(provider, instance, { name: 'quickbooks', recorder });
    expect(caps.map((x) => x.name).sort()).toEqual(['quickbooks.createinvoice', 'quickbooks.queryentities', 'quickbooks.readinvoice']);
    const host = createApplication({ application: { id: 'mi.openapi.qbo', name: 'qbo', version: '1.0.0' }, capabilities: caps, authorizer: { authorize: async () => ({ allowed: true }) } } as never);
    const call = (name: string, input: unknown) => host.handleRequest(createRequest({ requestId: `r${Math.random()}`, capability: { name, version: 1 }, input }), { transport: 'test' } as never) as Promise<{ ok: boolean; output?: Record<string, any>; error?: { message: string } }>;
    const created = await call('quickbooks.createinvoice', { path: { realmId: fx.realmId }, query: { minorversion: 75 }, body: { CustomerRef: { value: '2' }, Line: [{ Amount: 99.5, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '2' }, Qty: 1, UnitPrice: 99.5 } }], DocNumber: 'OA-2' } });
    expect(created).toMatchObject({ ok: true, output: { Invoice: { DocNumber: 'OA-2', TotalAmt: 99.5 } } });
    const read = await call('quickbooks.readinvoice', { path: { realmId: fx.realmId, invoiceId: created.output!.Invoice.Id }, query: { minorversion: 75 } });
    expect(read.output!.Invoice.Id).toBe(created.output!.Invoice.Id);
    // a field the contract does not describe is refused before anything is sent
    const bad = await call('quickbooks.createinvoice', { path: { realmId: fx.realmId }, body: { CustomerRef: { value: '2' }, Line: [], Surprise: true } });
    expect(bad.error!.message).toMatch(/does not conform/);
    expect(fx.state.invoices.size).toBe(2);
    writeFileSync(join(import.meta.dirname, '../../../docs/evidence/runs/openapi-quickbooks-benchmark.json'), JSON.stringify({ contract: { authority: 'derived', sha256: s.source.sha256, operations: Object.keys(c.operations) }, adoptedClientTraffic: traffic.map((r) => ({ method: r.method, path: r.path, bodyKeys: r.bodyKeys ?? [], minor: r.minorRequested })), violations }, null, 2));
  } finally {
    await fx.app.close();
  }
}, 120_000);
