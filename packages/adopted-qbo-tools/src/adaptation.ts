/**
 * Corrections of the QuickBooks application on the generic lifecycle: reviewed DEPENDENCY CHANGES from the
 * catalog (kind patch: a change to the code that runs). Validation replays the customer's own recent requests
 * through the artifact before and after against a RECORDING double of QuickBooks, fed read-only with the
 * customer's own customers and items, and compares every request the application's client sends.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, desc, eq } from 'drizzle-orm';
import { deliveries, integrations, type Db } from '@mi/database';
import type { CredentialCipher, ProviderEndpointConfig } from '@mi/integration-shopify-netsuite';
import {
  activateAdaptation,
  AdaptationError,
  CheckList,
  materializeArtifact,
  recordAdaptation,
  recordValidation,
  rejectAdaptation,
  rollbackAdaptation,
  startValidation,
  type AdaptationRow,
  type RuntimeHooks,
  type ReviewedDependencyChange,
} from '@mi/managed';
import { QuickBooksAccess } from '@mi/provider-connections';
import { dependencyChangeCatalog, pinnedSource } from './artifact.ts';
import { loadApplication } from './host.ts';
import { activeChanges, type InvoiceInput } from './invoke.ts';
import { QBO_TOOLS_APP } from './provenance.ts';

const changeOf = (r: AdaptationRow) => {
  const c = dependencyChangeCatalog().find((x) => x.id === (r.spec as { dependencyChangeId?: string }).dependencyChangeId);
  if (!c) throw new AdaptationError('INVALID', 'Dependency change is not in the reviewed catalog');
  return c;
};

export const QBO_HOOKS: RuntimeHooks = {
  scopeKey: (r) => (r.kind === 'patch' ? `d:${changeOf(r).dependency}` : `${r.kind}:${r.id}`),
  async loadRuntime(rows) {
    materializeArtifact(pinnedSource(), [], { dependencyChanges: rows.filter((r) => r.kind === 'patch').map(changeOf), instance: 'load-check' });
  },
};

export async function proposeDependencyChange(
  db: Db,
  p: { integrationId: string; changeId: string; actor: string; reason: string; maintenanceEventId?: string | null },
) {
  const c = dependencyChangeCatalog().find((x) => x.id === p.changeId);
  if (!c) throw new AdaptationError('INVALID', 'Only reviewed changes from the catalog can be proposed');
  return recordAdaptation(db, {
    integrationId: p.integrationId,
    maintenanceEventId: p.maintenanceEventId ?? null,
    kind: 'patch',
    boundary: 'integration',
    provider: 'quickbooks',
    artifact: { repository: QBO_TOOLS_APP.repository, commit: QBO_TOOLS_APP.commit, package: QBO_TOOLS_APP.packageName },
    dependency: { name: c.dependency, from: c.from, to: c.to },
    codePath: { dependency: c.dependency },
    spec: { dependencyChangeId: c.id },
    rationale: `${c.title}. ${p.reason}`,
    actor: p.actor,
  });
}

type Rec = { method: string; path: string; query: Record<string, string>; body: unknown; headers: Record<string, string> };

/** A QuickBooks double that answers from a snapshot of the customer's catalog and records every request. */
async function recordingDouble(catalog: { Customer: Record<string, any>[]; Item: Record<string, any>[] }) {
  const recorded: Rec[] = [];
  let seq = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const u = new URL(req.url ?? '/', 'http://double');
      const query = Object.fromEntries(u.searchParams.entries());
      const body = raw ? JSON.parse(raw) : null;
      recorded.push({ method: req.method!, path: u.pathname.replace(/\/v3\/company\/[^/]+/, '/v3/company/{realm}'), query, body, headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])) });
      res.setHeader('content-type', 'application/json');
      if (u.pathname.endsWith('/query')) {
        const q = query['query'] ?? '';
        const ent = /from (\w+)/i.exec(q)?.[1]?.toLowerCase() === 'item' ? 'Item' : 'Customer';
        const conds = [...q.matchAll(/(\w+) (=|LIKE) '((?:[^'\\]|\\.)*)'/gi)].map((m) => [m[1]!, m[2]!.toUpperCase(), m[3]!.replace(/\\'/g, "'")] as const);
        const rows = catalog[ent].filter((r) => r['Active'] !== false && conds.every(([f, op, v]) => (op === 'LIKE' ? new RegExp(`^${v.replace(/%/g, '.*')}$`, 'i').test(String(r[f])) : String(r[f]) === v)));
        res.end(JSON.stringify({ QueryResponse: rows.length ? { [ent]: rows } : {} }));
      } else {
        const lines = ((body?.Line ?? []) as { Amount: number }[]);
        res.end(JSON.stringify({ Invoice: { ...body, Id: String(9000 + ++seq), SyncToken: '0', TotalAmt: lines.reduce((a, l) => a + l.Amount, 0) } }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, recorded, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const VOLATILE = new Set(['user-agent', 'request-id', 'host', 'content-length', 'connection']);
const normalize = (r: Rec) => ({ method: r.method, path: r.path, query: r.query, body: r.body, headers: Object.fromEntries(Object.entries(r.headers).filter(([k]) => !VOLATILE.has(k)).sort()) });

export async function validateDependencyChange(
  db: Db,
  cipher: CredentialCipher,
  endpoints: ProviderEndpointConfig,
  id: string,
): Promise<AdaptationRow> {
  const row = await startValidation(db, id);
  const change = changeOf(row);
  const checks = new CheckList();
  const { changes } = await activeChanges(db, row.integrationId);
  const before: ReviewedDependencyChange[] = changes.filter((c) => c.id !== change.id);
  // The customer's own recent requests (inputs) and catalog (read-only from QuickBooks).
  const recent = await db
    .select()
    .from(deliveries)
    .where(and(eq(deliveries.integrationId, row.integrationId), eq(deliveries.outcome, 'delivered')))
    .orderBy(desc(deliveries.createdAt))
    .limit(20);
  const inputs = recent.map((d) => (d.summary as { input?: InvoiceInput }).input).filter(Boolean) as InvoiceInput[];
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, row.integrationId));
  const qbo = new QuickBooksAccess(db, cipher, endpoints, integ!.tenantId);
  const catalog = {
    Customer: ((await qbo.query<{ Customer?: Record<string, any>[] }>('select * from Customer')).Customer ?? []),
    Item: ((await qbo.query<{ Item?: Record<string, any>[] }>('select * from Item')).Item ?? []),
  };
  const run = async (set: ReviewedDependencyChange[], tag: string) => {
    const app = await loadApplication(set, `validate-${id}-${tag}`);
    const dbl = await recordingDouble(catalog);
    try {
      for (const input of inputs)
        await app.handleCreateInvoice(app.client({ accessToken: 'validation', realmId: 'validation', apiBase: dbl.url }), { ...input, draft: false });
    } finally {
      await dbl.close();
    }
    return { app, recorded: dbl.recorded };
  };
  let a: Awaited<ReturnType<typeof run>>, b: Awaited<ReturnType<typeof run>>;
  try {
    a = await run(before, 'before');
    b = await run([...before, change], 'after');
    checks.add('the artifact with the change loads', true, `${b.app.artifact.id}: ${change.dependency} ${b.app.artifact.dependencies[change.dependency]}`);
  } catch (err) {
    checks.add('the artifact with the change loads', false, (err as Error).message);
    return recordValidation(db, id, checks.checks, { before: 'unknown', after: 'unknown' });
  }
  const sameFiles = JSON.stringify(a.app.artifact.files) === JSON.stringify(b.app.artifact.files);
  checks.add('the application’s executed files are unchanged', sameFiles, sameFiles ? `${Object.keys(b.app.artifact.files).length} files, same sha256` : 'executed files differ');
  const na = a.recorded.map(normalize);
  const nb = b.recorded.map(normalize);
  const same = na.length === nb.length && na.every((x, i) => JSON.stringify(x) === JSON.stringify(nb[i]));
  const ua = [...new Set(b.recorded.map((r) => r.headers['user-agent']))].join(', ');
  checks.add(
    'every request to QuickBooks is the same (method, path, minor version, query, body, headers)',
    inputs.length ? same : null,
    inputs.length
      ? same
        ? `${nb.length} requests from ${inputs.length} of your requests identical; differs only in User-Agent (now “${ua}”) and the per-request Request-Id`
        : `${na.length} vs ${nb.length} requests; first difference at #${na.findIndex((x, i) => JSON.stringify(x) !== JSON.stringify(nb[i])) + 1}`
      : 'no recorded requests to replay',
  );
  checks.add('rollback target loads', true, `${a.app.artifact.id}`);
  return recordValidation(db, id, checks.checks, { before: a.app.artifact.id, after: b.app.artifact.id });
}

export const activateQboAdaptation = (db: Db, id: string, actor: string, note: string, opts?: { acceptLimitations?: boolean }) =>
  activateAdaptation(db, id, actor, note, QBO_HOOKS, opts);
export const rollbackQboAdaptation = (db: Db, id: string, actor: string, reason: string) => rollbackAdaptation(db, id, actor, reason, QBO_HOOKS);
export const rejectQboAdaptation = (db: Db, id: string, actor: string, reason: string) => rejectAdaptation(db, id, actor, reason);
