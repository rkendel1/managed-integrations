/** Runtime work for the hosted applications. */
import type { ComponentWorkItem, ComponentWorkOutcome } from "@feltdb/feltkit/server";
import type { Runtime } from "./component.ts";
import { AuthorizationLost } from "./netsuite.ts";
import { grant, query } from "./quickbooks.ts";
import { stripeClient } from "./ledgerly.ts";
import { APP_PATCHES, QBO_TOOLS, STRIPE_APP, createInvoice, differences, findInvoiceByDoc, processWith, stripeAppArtifact, stripeTruth } from "./apps.ts";
import { materialize } from "./artifacts.ts";

type Handler = (item: ComponentWorkItem, ws: string) => Promise<ComponentWorkOutcome>;

/** Upstream releases reviewed for adoption (each fact checked against the upstream repository). */
export const RELEASES = {
  "quickbooks-mcp": [
    {
      version: "0.12.0",
      commit: "611ca6d05165e405834bc121762026b285ff5526",
      source: "https://github.com/laf-rge/quickbooks-mcp/commit/611ca6d05165e405834bc121762026b285ff5526",
      // git diff --name-only ce1317e 611ca6d
      changedFiles: [".gitignore", "CLAUDE.md", "README.md", "package-lock.json", "package.json", "server.json", "src/lambda.ts", "src/tools/definitions.ts", "src/tools/handlers/index.ts", "src/tools/handlers/vendor.ts", "src/tools/index.ts", "src/types/node-quickbooks.d.ts", "tests/auth/lambda-fail-closed.test.ts", "tests/auth/remote-tool-allowlist.test.ts", "tests/tools/annotations.test.ts", "tests/tools/vendor.test.ts"],
      dependencyChanges: [{ name: "node-quickbooks", from: "2.0.48", to: "2.0.50" }],
    },
  ],
} as const;

async function stripeKey(rt: Runtime, ws: string) {
  const c = await rt.call<{ sealed: string } | null>(ws, "runtime:sealedConnection", { provider: "stripe" });
  if (!c) throw new Error("Stripe is not connected");
  return rt.open<{ apiKey: string }>(ws, "connection:stripe", c.sealed).apiKey;
}

/** Process one Stripe event with the application's own code, commit its writes, compare with Stripe. */
export async function processAndVerify(rt: Runtime, ws: string, integrationId: string, event: any, patches: string[]) {
  const recs = await rt.call<{ model: string; key: string; data: Record<string, unknown> }[]>(ws, "apps:currentRecords", { integrationId });
  const current = new Map(recs.map((r) => [`${r.model}|${r.key}`, r.data]));
  const r = await processWith(patches, event, (m, k) => (current.get(`${m}|${k}`) as Record<string, unknown> | undefined) ?? null);
  const key = await stripeKey(rt, ws);
  const writes = [];
  for (const w of r.writes) writes.push({ ...w, differs: differences(w.row, await stripeTruth(key, w.model, w.key)) });
  await rt.call(ws, "apps:writeRecords", { integrationId, sourceEventId: event.id, writes });
  return { outcome: r.outcome, artifact: r.artifact, writes };
}

/** The lines of the application's processor that read a field (file:line), for the finding. */
async function readsOf(fields: string[]) {
  const { readFileSync } = await import("node:fs");
  const a = await stripeAppArtifact([]);
  const lines = readFileSync(`${a.dir}/src-tree/${STRIPE_APP.processorFile}`, "utf8").split("\n");
  const source: Record<string, string> = { currentPeriodEnd: "current_period_end", stripeSubscriptionId: "inv.subscription", paid: "inv.paid" };
  return fields.flatMap((f) => lines.flatMap((l, i) => (source[f] && l.includes(source[f]!) ? [`${STRIPE_APP.processorFile}:${i + 1}`] : []))).filter((v, i, x) => x.indexOf(v) === i);
}

export async function deliverStripeApp(rt: Runtime, ws: string, c: any, record: (o: string, x?: Record<string, unknown>) => Promise<{ retry: boolean }>): Promise<ComponentWorkOutcome> {
  const event = rt.open<any>(ws, "receipt", c.receipt.sealed);
  const patches = (c.patches ?? []).map((p: { patch: string }) => p.patch);
  const correction = (c.patches ?? []).map((p: { id: string }) => p.id).join(",") || undefined;
  const r = await processAndVerify(rt, ws, c.integration.id, event, patches);
  const differs = [...new Set(r.writes.flatMap((w) => w.differs))];
  await record("delivered", { detail: `application: ${r.outcome}; ${r.writes.length} record(s); ${differs.length ? `DIFFERS from Stripe: ${differs.join(", ")}` : "match Stripe"}; artifact ${r.artifact}`, ...(correction ? { correction } : {}) });
  if (differs.length) {
    // Answered success but stored something other than what Stripe states: a provider contract change.
    const eventId = await rt.call<string>(ws, "apps:openDataEvent", {
      integrationId: c.integration.id,
      contract: `stripe.webhook.${event.api_version ?? "unknown"}`,
      finding: {
        provider: "stripe", contract: "webhook event payload", endpointApiVersion: event.api_version ?? null, applicationApiVersion: STRIPE_APP.apiVersion,
        fields: differs, location: await readsOf(differs), patch: "stripe-basil-field-locations",
        summary: `Events at ${event.api_version} are stored with ${differs.join(", ")} different from Stripe (the processor answered success)`,
        source: "https://docs.stripe.com/webhooks/versioning",
      },
    });
    await rt.call(ws, "runtime:markAffected", { deliveryId: c.delivery.id, eventId });
  }
  return { outcome: "done", receipt: { outcome: r.outcome, differs } };
}

export function workers(get: () => Runtime, qboSecret: () => string, publicUrl: string): Record<string, Handler> {
  return {
    async "app-invoke"(item, ws) {
      const rt = get();
      const integrationId = String(item.input.integrationId);
      const requestId = String(item.input.requestId);
      const c = await rt.call(ws, "apps:requestContext", { integrationId, requestId });
      if (c.request.status === "succeeded") return { outcome: "done" };
      const deps = await rt.call<{ id: string; spec: Record<string, unknown> }[]>(ws, "apps:activeDependencyChanges", { integrationId });
      const version = String(deps[0]?.spec.to ?? QBO_TOOLS.pinnedDependency.version);
      const correction = deps.map((d) => d.id).join(",") || undefined;
      const rec = (outcome: string, x: Record<string, unknown> = {}) => rt.call(ws, "apps:recordRequest", { integrationId, requestId, outcome, ...(correction ? { correction } : {}), ...x });
      const input = c.request.input as any;
      let g;
      try {
        g = await grant(rt, ws, qboSecret());
      } catch (err) {
        if (err instanceof AuthorizationLost) {
          await rec("awaiting_authorization", { detail: err.message });
          return { outcome: "done" };
        }
        throw err;
      }
      // Not idempotent at QuickBooks: never send twice. A DocNumber already present means it ran.
      let found = await findInvoiceByDoc(g, input.doc_number);
      if (found.status === 401) {
        try {
          g = await grant(rt, ws, qboSecret(), true);
          found = await findInvoiceByDoc(g, input.doc_number);
        } catch (err) {
          if (err instanceof AuthorizationLost) {
            await rec("awaiting_authorization", { detail: err.message });
            return { outcome: "done" };
          }
          throw err;
        }
      }
      if (found.invoice) {
        await rec("succeeded", { result: { invoiceId: found.invoice.Id, totalAmt: found.invoice.TotalAmt, verified: true, alreadyPresent: true }, detail: "found by DocNumber; not sent again" });
        return { outcome: "done" };
      }
      try {
        await createInvoice(g, qboSecret(), input, version);
      } catch (err) {
        const after = await findInvoiceByDoc(g, input.doc_number).catch(() => ({ invoice: null }));
        if (after.invoice) {
          await rec("succeeded", { result: { invoiceId: after.invoice.Id, totalAmt: after.invoice.TotalAmt, verified: true }, detail: `node-quickbooks@${version}; error after send, verified present` });
          return { outcome: "done" };
        }
        await rec("failed", { detail: `node-quickbooks@${version}: ${(err as Error).message}` });
        return { outcome: "done" };
      }
      const v = await findInvoiceByDoc(g, input.doc_number);
      await rec(v.invoice ? "succeeded" : "unknown", { result: { invoiceId: v.invoice?.Id ?? null, totalAmt: v.invoice?.TotalAmt ?? null, verified: Boolean(v.invoice) }, detail: `node-quickbooks@${version}; read back ${v.invoice ? "present" : "ABSENT"}` });
      return { outcome: "done" };
    },
    /** Compare the adopted code with reviewed upstream releases: what this deployment executes vs what changed. */
    async "check-app-release"(item, ws) {
      const rt = get();
      const integrationId = String(item.input.integrationId);
      const a = await materialize({ pkg: "quickbooks-mcp", from: "vendor", entry: "mi-entry.ts", entrySource: "export { handleCreateInvoice } from './src/tools/handlers/invoice.js';\nexport { default as QuickBooks } from 'node-quickbooks';\n", patches: [], alias: { "node-quickbooks": `nqb-${QBO_TOOLS.pinnedDependency.version}` } });
      for (const rel of RELEASES["quickbooks-mcp"]) {
        const touched = a.manifest.executed.filter((f) => (rel.changedFiles as readonly string[]).includes(f));
        await rt.call(ws, "apps:openReleaseEvent", {
          integrationId,
          release: rel.version,
          finding: {
            provider: "quickbooks-mcp", release: rel.version, commit: rel.commit, source: rel.source, executedFiles: a.manifest.executed.length,
            executedFilesChanged: touched, dependencyChanges: rel.dependencyChanges,
            summary: `Upstream ${rel.version}: ${touched.length} of the ${a.manifest.executed.length} executed files changed; ${rel.dependencyChanges.map((d) => `${d.name} ${d.from} → ${d.to}`).join(", ")}`,
          },
        });
      }
      return { outcome: "done" };
    },
    async "app-setup"(item, ws) {
      const rt = get();
      const integrationId = String(item.input.integrationId);
      const kind = String(item.input.kind);
      if (kind === "qbo_tools") {
        const g = await grant(rt, ws, qboSecret());
        const r = await query(g, "select * from CompanyInfo");
        await rt.call(ws, "apps:setStatus", { integrationId, status: "protected", settings: { companyVerified: r.status === 200 } });
        await rt.call(ws, "onboarding:recordBaseline", { kind, webhook: true, baseline: { companyVerified: r.status === 200 } });
        return { outcome: "done" };
      }
      // Stripe application: our endpoint at the application's API version, then rebuild its records from Stripe.
      const key = await stripeKey(rt, ws);
      const stripe = stripeClient(key);
      const theirs = (await stripe.webhookEndpoints.list({ limit: 100 })).data.find((e) => new URL(e.url).pathname === STRIPE_APP.route);
      const endpoint = await stripe.webhookEndpoints.create({ url: `${publicUrl}/rt/hooks/stripe/${ws}/${integrationId}`, api_version: STRIPE_APP.apiVersion as any, enabled_events: (theirs?.enabled_events ?? ["*"]) as any });
      await rt.call(ws, "apps:setStatus", { integrationId, status: "checking", settings: { endpointId: endpoint.id, endpointSecret: rt.seal(ws, `endpoint:${integrationId}`, endpoint.secret), replaced: theirs?.url ?? null } });
      const events = [];
      for await (const e of stripe.events.list({ limit: 100 })) events.push(e);
      events.sort((x, y) => x.created - y.created);
      let records = 0;
      let mismatches = 0;
      for (const e of events) {
        const r = await processAndVerify(rt, ws, integrationId, e, []);
        records += r.writes.length;
        mismatches += r.writes.filter((w) => w.differs.length).length;
      }
      const all = await rt.call<unknown[]>(ws, "apps:currentRecords", { integrationId });
      const baseline = { events: events.length, records: all.length, writes: records, mismatches };
      await rt.call(ws, "apps:setStatus", { integrationId, status: "protected", settings: { baseline } });
      await rt.call(ws, "onboarding:recordBaseline", { kind, webhook: true, baseline });
      return { outcome: "done", receipt: { events: events.length, records: all.length, mismatches } };
    },
  };
}

export { APP_PATCHES };
