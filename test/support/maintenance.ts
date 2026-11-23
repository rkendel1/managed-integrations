/**
 * Test support for the slice-4 maintenance lifecycle: the provider-change scenario (made at the fixture
 * boundary) and a driver that plays the worker (advance the event, run what it enqueued). Shared by the
 * lifecycle tests and the API boundary tests so both observe a real, not seeded, maintenance event.
 */
import { eq } from 'drizzle-orm';
import { incidents } from '@mi/database';
import {
  adoptedClients,
  advanceMaintenance,
  executeDelivery,
  executeRecovery,
  ingestShopifyWebhook,
  recordInputContractFinding,
  scanReconciliation,
  type ExecutionTrigger,
} from '@mi/adopted-order-sync';
import { FAST_RETRY, testCipher, type Harness } from './harness.ts';
import { signedWebhook, type attachAdoptedTenant } from './adopted.ts';

type Adopted = Awaited<ReturnType<typeof attachAdoptedTenant>>;
type Clients = Awaited<ReturnType<typeof adoptedClients>>;
const SECRET = 'fixture-shopify-client-secret';

export function maintenanceKit(h: Harness, a: Adopted, clients: Clients) {
  const db = h.dbh.db;
  let n = 0;
  function shopifyOrder(sku = 'SKU-RED', price = '12.50') {
    n += 1;
    const t = new Date(Date.now() - 3_600_000 + n * 1000).toISOString();
    return a.shopify.control.upsertOrder({
      name: `#M${1000 + n}`,
      createdAt: t,
      updatedAt: t,
      email: 'buyer@bluewave.test',
      lineItems: [{ sku, title: 'Part', quantity: 3, unitPrice: price }],
    });
  }
  /** Shopify sends the order's webhook, in whatever payload version the provider currently uses. */
  async function webhook(legacyId: string) {
    const body = a.shopify.control.webhookPayload(a.shopify.state.orders.get(legacyId)!);
    const w = signedWebhook(body, SECRET, a.shop);
    w.headers['x-shopify-api-version'] = a.shopify.state.webhookVersion;
    const r = await ingestShopifyWebhook({
      db,
      cipher: testCipher,
      integrationId: a.integrationId,
      rawBody: w.raw,
      headers: w.headers,
      webhookSecret: SECRET,
    });
    const exec = await executeDelivery({
      db,
      cipher: testCipher,
      endpoints: h.endpoints,
      deliveryId: r.deliveryId!,
      trigger: { kind: 'webhook' },
    });
    // What the worker does with a held result.
    const finding =
      exec.executed && exec.outcome === 'held'
        ? await recordInputContractFinding(db, testCipher, r.deliveryId!)
        : null;
    return { deliveryId: r.deliveryId!, exec, finding };
  }
  /** Plays the worker: advances the event and runs whatever it enqueued, until it settles. */
  async function drive(incidentId: string) {
    const exec: { id: string; trigger: ExecutionTrigger }[] = [];
    const recon: string[] = [];
    const recov: string[] = [];
    const states: string[] = [];
    for (let i = 0; i < 80; i++) {
      const r = await advanceMaintenance({
        db,
        cipher: testCipher,
        incidentId,
        clients,
        retry: FAST_RETRY,
        enqueueExecution: async (id, trigger) => void exec.push({ id, trigger }),
        enqueueReconciliation: async (runId) => void recon.push(runId),
        enqueueRecovery: async (itemId) => void recov.push(itemId),
      });
      states.push(`${r.state}:${r.detail}`);
      for (const e of exec.splice(0))
        await executeDelivery({
          db,
          cipher: testCipher,
          endpoints: h.endpoints,
          deliveryId: e.id,
          trigger: e.trigger,
        });
      for (const runId of recon.splice(0))
        await scanReconciliation({ db, runId, workerId: 'w', clients, retry: FAST_RETRY });
      for (const itemId of recov.splice(0))
        await executeRecovery({
          db,
          cipher: testCipher,
          endpoints: h.endpoints,
          itemId,
          clients,
          retry: FAST_RETRY,
        });
      if (r.state === 'resolved' || r.state === 'escalated' || r.state === 'noop') break;
    }
    const [inc] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
    return { inc: inc!, states };
  }
  /** Normal operation, then the provider changes its payload: two orders arrive, one webhook is lost. */
  async function scenario() {
    const before = [shopifyOrder(), shopifyOrder('SKU-BLUE', '7.25')];
    for (const o of before) await webhook(o.legacyId);
    a.shopify.control.setWebhookVersion('2027-01'); // the provider change, at the fixture boundary
    const delayed = [shopifyOrder('SKU-RED', '12.50'), shopifyOrder('SKU-BLUE', '7.25')];
    const held = [];
    for (const o of delayed) held.push(await webhook(o.legacyId));
    const lost = shopifyOrder('SKU-RED', '9.99'); // its webhook never reaches us
    return { before, delayed, held, lost };
  }
  return { shopifyOrder, webhook, drive, scenario };
}
