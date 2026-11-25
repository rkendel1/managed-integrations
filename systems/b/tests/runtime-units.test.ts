/**
 * Deterministic pieces of the runtime that need no server: the reviewed OneWorld patch against the pinned
 * upstream source, refusal parsing, the input contract and its adapter, and the sealer's binding.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ADAPTERS, ORDER_SYNC_PATCHES, contractViolations, orderSyncCode, requiredFieldOf } from "../runtime/order-sync.ts";
import { createSealer } from "../runtime/seal.ts";

const pinned = readFileSync(join(dirname(createRequire(import.meta.url).resolve("shopify-sync/package.json")), "src/adapters/netsuite.js"), "utf8");

test("the reviewed OneWorld patch applies exactly once to the pinned source and only adds the subsidiary option", () => {
  const p = ORDER_SYNC_PATCHES["netsuite-oneworld-subsidiary"]!;
  assert.equal(pinned.split(p.find).length - 1, 1);
  const added = p.replace.split("\n").filter((l) => !p.find.split("\n").includes(l));
  assert.ok(added.every((l) => l.startsWith("//") || /subsidiaryId/.test(l)), added.join("\n"));
});

test("the patched code sends exactly the original request plus the subsidiary, and the original without one", async () => {
  const bodies: Record<string, unknown[]> = { pinned: [], withSub: [], without: [] };
  const fake = (into: unknown[]) => (async (url: string, init?: { method?: string; body?: string }) => {
    if (String(url).includes("suiteql")) {
      const q = JSON.parse(init!.body!).q as string;
      const items = /FROM customer/.test(q) ? [{ id: "5", entityid: "WEB" }] : [{ id: "7", itemid: "SKU-1" }];
      return new Response(JSON.stringify({ items }), { status: 200, headers: { "content-type": "application/json" } });
    }
    into.push(JSON.parse(init!.body!));
    return new Response(null, { status: 204, headers: { location: "/salesOrder/1" } });
  }) as typeof fetch;
  const order = { id: 1, name: "#1", line_items: [{ sku: "SKU-1", quantity: 2, price: "3.50" }] };
  const run = async (patches: string[], into: unknown[], subsidiaryId?: string) => {
    const code = await orderSyncCode(patches);
    const real = globalThis.fetch;
    globalThis.fetch = fake(into);
    try {
      const o = code.module.toCanonicalOrder(order, { defaultCustomer: "WEB", customerByEmail: {} });
      await code.module.syncOrder(code.module.createNetSuiteAdapter({ baseUrl: "http://ns", accessToken: "t", ...(subsidiaryId ? { subsidiaryId } : {}) }), o);
    } finally {
      globalThis.fetch = real;
    }
  };
  await run([], bodies.pinned!);
  await run(["netsuite-oneworld-subsidiary"], bodies.withSub!, "2");
  await run(["netsuite-oneworld-subsidiary"], bodies.without!);
  const { subsidiary, ...rest } = bodies.withSub![0] as { subsidiary?: { id: string } };
  assert.deepEqual(subsidiary, { id: "2" });
  assert.deepEqual(rest, bodies.pinned![0]);
  assert.deepEqual(bodies.without, bodies.pinned);
});

test("refusal parsing finds the newly required field", () => {
  assert.equal(requiredFieldOf("Please enter value(s) for: Subsidiary"), "Subsidiary");
  assert.equal(requiredFieldOf("Invalid item reference key 9."), null);
  assert.equal(requiredFieldOf(undefined), null);
});

test("the 2027-01 adapter restores exactly what the input contract lacks", () => {
  const p = { id: 1, name: "#1", line_items: [{ sku: "A", quantity: 1, price_set: { shop_money: { amount: "4.00" } } }] };
  assert.deepEqual(contractViolations(p), ["line_items[].price"]);
  const fixed = ADAPTERS["line-price-from-price-set"]!.apply(p);
  assert.deepEqual(contractViolations(fixed), []);
  assert.equal(fixed.line_items![0]!.price, "4.00");
});

test("a sealed value opens only for its own workspace and purpose", () => {
  const s = createSealer(`k1:${Buffer.alloc(32, 7).toString("base64")}`);
  const env = s.seal("secret", "ws-a:connection:netsuite");
  assert.equal(s.open(env, "ws-a:connection:netsuite"), "secret");
  assert.throws(() => s.open(env, "ws-b:connection:netsuite"));
  assert.throws(() => s.open(env, "ws-a:receipt"));
});
