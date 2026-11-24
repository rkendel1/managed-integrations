/**
 * Same-workload benchmark for System A and System B (docs/experiment/BENCHMARKS.md).
 *
 * The harness belongs to neither system. For each system it creates orders in that system's own Shopify
 * simulator, signs the simulator's orders/create payload exactly as Shopify does, POSTs it to the system's own
 * webhook endpoint, and watches that system's own NetSuite simulator for the sales order the adopted code
 * writes. Measured: acknowledgement latency (webhook POST → HTTP answer), end-to-end latency (POST → record in
 * NetSuite), burst throughput, and CPU/memory consumed by the system's processes during the run.
 *
 * Usage: tsx workload.ts A|B  (environment: see the TARGETS table; B's company is created through B's API)
 */
import { createHmac } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const SYSTEM = (process.argv[2] ?? "").toUpperCase() as "A" | "B";
if (SYSTEM !== "A" && SYSTEM !== "B") throw new Error("usage: workload.ts A|B");
const SEQ = Number(process.env.BENCH_SEQUENTIAL ?? 100);
const BURST = Number(process.env.BENCH_BURST ?? 200);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 20);
const SECRET = "fixture-shopify-client-secret";
const SHOP_DOMAIN = "bluewave-supply.myshopify.com";

const T = {
  A: { shop: "http://127.0.0.1:4011", netsuite: "http://127.0.0.1:4020" },
  B: { shop: "http://127.0.0.1:5011", netsuite: "http://127.0.0.1:5020" },
}[SYSTEM];

async function j(url: string, init: { method?: string; body?: unknown } = {}) {
  const r = await fetch(url, { method: init.method ?? "GET", headers: { "content-type": "application/json" }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  return r.json() as Promise<any>;
}

/* ------------------------------------ targets: where to POST ------------------------------------ */
let webhookUrl: string;
if (SYSTEM === "A") {
  const id = execSync(`docker exec managed-integrations-postgres-1 psql -U mi -d managed_integrations -At -c "select id from integrations where flow_type='adopted.shopify_erp_order_sync.netsuite' limit 1"`).toString().trim();
  webhookUrl = `http://127.0.0.1:3000/webhooks/shopify/${id}`;
} else {
  process.env.MI_B_URL ??= "http://127.0.0.1:3200";
  const { adoptedCompany, FX } = await import("../../systems/b/scenarios/lib.ts");
  const { api } = await import("../../systems/b/feltkit/_generated/api.ts");
  const co = await adoptedCompany(api, "Bench", FX.shopify2);
  webhookUrl = `${process.env.MI_B_URL}/rt/hooks/shopify/${co.workspace}/${co.integrationId}`;
}
// Orders reach the system only through the harness's webhooks (the simulator's own deliveries are dropped).
await j(`${T.shop}/__fixture/drop-webhooks`, { method: "POST", body: { n: SEQ + BURST + 10 } });

/* ------------------------------------ resource accounting ------------------------------------ */
function cpuSeconds(): number {
  if (SYSTEM === "A") {
    let total = 0;
    // Every container of the stack except the simulators: its cgroup's CPU usage (cgroup v2 cpu.stat).
    for (const id of execSync("docker ps -q --filter name=managed-integrations-").toString().trim().split("\n").filter(Boolean)) {
      if (execSync(`docker inspect -f '{{.Name}}' ${id}`).toString().includes("fixtures")) continue;
      const full = execSync(`docker inspect -f '{{.Id}}' ${id}`).toString().trim();
      try {
        total += Number(readFileSync(`/sys/fs/cgroup/cpuacct/docker/${full}/cpuacct.usage`, "utf8")) / 1e9; // cgroup v1 (this host)
      } catch {
        const pid = execSync(`docker inspect -f '{{.State.Pid}}' ${id}`).toString().trim();
        const rel = readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().split("\n").find((l) => l.startsWith("0::"))!.slice(3);
        total += Number(/usage_usec (\d+)/.exec(readFileSync(`/sys/fs/cgroup${rel}/cpu.stat`, "utf8"))![1]) / 1e6; // cgroup v2
      }
    }
    if (!total) throw new Error("could not read System A's CPU usage");
    return total;
  }
  const pid = execSync("pgrep -f 'feltkit.js start' | head -1").toString().trim();
  const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ");
  return (Number(f[11]) + Number(f[12])) / 100; // utime + stime, clock ticks (100/s)
}
function memoryMiB(): number {
  if (SYSTEM === "A") {
    const out = execSync("docker stats --no-stream --format '{{.Name}} {{.MemUsage}}'").toString();
    return out.split("\n").filter((l) => l.startsWith("managed-integrations-") && !l.includes("fixtures")).reduce((s, l) => {
      const m = /([\d.]+)(MiB|GiB)/.exec(l);
      return s + (m ? Number(m[1]) * (m[2] === "GiB" ? 1024 : 1) : 0);
    }, 0);
  }
  const pid = execSync("pgrep -f 'feltkit.js start' | head -1").toString().trim();
  return Number(execSync(`ps -o rss= -p ${pid}`).toString().trim()) / 1024;
}

/* ------------------------------------------ workload ------------------------------------------ */
const run = Date.now().toString(36);
async function makeOrder(i: number) {
  const o = await j(`${T.shop}/__fixture/orders`, { method: "POST", body: { name: `#BENCH-${run}-${i}`, email: "buyer@bluewave.test", lineItems: [{ sku: "SKU-RED", title: "Part", quantity: 1 + (Math.abs(i) % 3), unitPrice: "12.50" }] } });
  const payload = await j(`${T.shop}/__fixture/orders/${o.legacyId}/webhook-payload`);
  return { legacyId: o.legacyId as string, raw: Buffer.from(JSON.stringify(payload)) };
}
async function send(o: { legacyId: string; raw: Buffer }) {
  const t0 = performance.now();
  const r = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": createHmac("sha256", SECRET).update(o.raw).digest("base64"),
      "x-shopify-shop-domain": SHOP_DOMAIN,
      "x-shopify-topic": "orders/create",
      "x-shopify-webhook-id": `bench-${run}-${o.legacyId}`,
      "x-shopify-api-version": "2026-10",
    },
    body: o.raw,
  });
  await r.arrayBuffer();
  if (!r.ok) throw new Error(`webhook ${r.status}`);
  return performance.now() - t0;
}
const delivered = new Map<string, number>(); // legacyId → time first seen in NetSuite
async function pollNetSuite(ids: Set<string>, until: number) {
  while (ids.size && performance.now() < until) {
    const st = await j(`${T.netsuite}/__fixture/state`);
    const now = performance.now();
    for (const so of st.salesOrders as { externalId: string | null }[]) {
      const id = so.externalId?.replace("shopify-", "");
      if (id && ids.has(id)) {
        delivered.set(id, now);
        ids.delete(id);
      }
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]! * 10) / 10 : null;
};
const summary = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: pct(xs, 100) });

// warm-up (not measured)
for (let i = 0; i < 5; i++) {
  const o = await makeOrder(-1 - i);
  await send(o);
  await pollNetSuite(new Set([o.legacyId]), performance.now() + 30_000);
}

const cpu0 = cpuSeconds();
const mem0 = memoryMiB();

// 1. Sequential: one order at a time (latency without load).
const ack1: number[] = [];
const e2e1: number[] = [];
for (let i = 0; i < SEQ; i++) {
  const o = await makeOrder(i);
  const t0 = performance.now();
  ack1.push(await send(o));
  await pollNetSuite(new Set([o.legacyId]), performance.now() + 60_000);
  if (!delivered.has(o.legacyId)) throw new Error(`order ${o.legacyId} not delivered`);
  e2e1.push(delivered.get(o.legacyId)! - t0);
}

// 2. Burst: BURST orders, webhooks sent with CONCURRENCY in flight.
const orders = [];
for (let i = 0; i < BURST; i++) orders.push(await makeOrder(SEQ + i));
const pending = new Set(orders.map((o) => o.legacyId));
const sentAt = new Map<string, number>();
const ack2: number[] = [];
const tb0 = performance.now();
const poller = pollNetSuite(pending, tb0 + Number(process.env.BENCH_DRAIN_SECONDS ?? 900) * 1000);
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < orders.length) {
      const o = orders[next++]!;
      sentAt.set(o.legacyId, performance.now());
      ack2.push(await send(o));
    }
  }),
);
const ackedAt = performance.now();
await poller;
const tb1 = Math.max(...orders.map((o) => delivered.get(o.legacyId) ?? Infinity));
const e2e2 = orders.filter((o) => delivered.has(o.legacyId)).map((o) => delivered.get(o.legacyId)! - sentAt.get(o.legacyId)!);
const cpu1 = cpuSeconds();
const mem1 = memoryMiB();

const result = {
  system: SYSTEM,
  at: new Date().toISOString(),
  config: { sequential: SEQ, burst: BURST, concurrency: CONCURRENCY },
  sequential: { ackMs: summary(ack1), endToEndMs: summary(e2e1) },
  burst: {
    ackMs: summary(ack2),
    endToEndMs: summary(e2e2),
    delivered: e2e2.length,
    acceptSeconds: Math.round(ackedAt - tb0) / 1000,
    drainSeconds: Number.isFinite(tb1) ? Math.round(tb1 - tb0) / 1000 : null,
    throughputOrdersPerSecond: Number.isFinite(tb1) ? Math.round((BURST / ((tb1 - tb0) / 1000)) * 10) / 10 : null,
  },
  resources: { cpuSeconds: Math.round((cpu1 - cpu0) * 100) / 100, memoryMiBBefore: Math.round(mem0), memoryMiBAfter: Math.round(mem1) },
};
console.log(JSON.stringify(result, null, 2));
mkdirSync("docs/evidence/runs/bench", { recursive: true });
writeFileSync(`docs/evidence/runs/bench/${SYSTEM}-${run}.json`, JSON.stringify(result, null, 2));
