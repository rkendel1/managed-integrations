/**
 * Corrections of the hosted application, on the generic lifecycle (@mi/managed adaptations): only reviewed
 * patches from this package's catalog; validation is a REPLAY of the events this customer's application
 * actually received, through the artifact before and after, each against its own in-memory database.
 */
import { join } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { adaptations, webhookReceipts, type Db } from '@mi/database';
import type { CredentialCipher } from '@mi/integration-shopify-netsuite';
import {
  activateAdaptation,
  AdaptationError,
  appHost,
  CheckList,
  materializeArtifact,
  recordAdaptation,
  recordValidation,
  rejectAdaptation,
  rollbackAdaptation,
  sha256,
  startValidation,
  type AdaptationRow,
  type RuntimeHooks,
} from '@mi/managed';
import { readFileSync } from 'node:fs';
import { patchCatalog, pinnedSource, type AppPatch } from './artifact.ts';
import { shapeOf, type StripeEventPayload } from './execute.ts';
import { activePatches, loadApplication } from './host.ts';
import { memoryStore } from './store.ts';
import { compare, expectationOf } from './verify.ts';
import { STRIPE_SUBSCRIPTIONS_APP } from './provenance.ts';
import { fingerprintOf } from '@mi/managed';

const patchOf = (r: AdaptationRow) => {
  const p = patchCatalog().find((x) => x.id === (r.spec as { patchId?: string }).patchId);
  if (!p) throw new AdaptationError('INVALID', 'Patch is not in the reviewed catalog');
  return p;
};

export const APP_HOOKS: RuntimeHooks = {
  scopeKey: (r) => (r.kind === 'patch' ? `p:${patchOf(r).file}` : `${r.kind}:${r.id}`),
  async loadRuntime(rows) {
    const patches = rows.filter((r) => r.kind === 'patch').map(patchOf);
    materializeArtifact(pinnedSource(), patches, { instance: 'load-check' });
  },
};

export async function proposeAppPatch(
  db: Db,
  p: { integrationId: string; patchId: string; actor: string; reason: string; maintenanceEventId?: string | null },
) {
  const patch = patchCatalog().find((x) => x.id === p.patchId);
  if (!patch) throw new AdaptationError('INVALID', 'Only reviewed patches from the catalog can be proposed');
  return recordAdaptation(db, {
    integrationId: p.integrationId,
    maintenanceEventId: p.maintenanceEventId ?? null,
    kind: 'patch',
    boundary: 'integration',
    provider: patch.addresses.provider,
    artifact: { repository: STRIPE_SUBSCRIPTIONS_APP.repository, commit: STRIPE_SUBSCRIPTIONS_APP.commit, package: STRIPE_SUBSCRIPTIONS_APP.packageName },
    dependency: patch.addresses,
    codePath: { file: patch.file, baseSha256: patch.baseSha256, resultSha256: patch.resultSha256 },
    spec: { patchId: patch.id },
    rationale: `${patch.title}. ${p.reason}`,
    actor: p.actor,
  });
}

/** Replays events through one artifact with its own in-memory database; returns each object's record. */
async function replay(patches: AppPatch[], instance: string, events: StripeEventPayload[]) {
  const art = materializeArtifact(pinnedSource(), patches, { instance });
  const mem = memoryStore();
  appHost().register(art.root, {
    prisma: mem.prisma,
    env: { NODE_ENV: 'production', PORT: 0, DATABASE_URL: 'memory', STRIPE_SECRET_KEY: 'sk_test_replay', STRIPE_WEBHOOK_SECRET: 'replay' },
  });
  const app = await loadApplication(art.root);
  const records = new Map<string, Record<string, unknown> | null>();
  for (const e of events) {
    await app.processStripeEvent(e);
    const x = expectationOf(e.data.object);
    if (x) records.set(e.id, await mem.get(x.model, x.key));
  }
  return { artifact: art, records };
}

const strip = (r: Record<string, unknown> | null) =>
  r ? Object.fromEntries(Object.entries(r).filter(([k]) => !['id', 'createdAt', 'updatedAt'].includes(k))) : null;

export async function validateAppAdaptation(db: Db, cipher: CredentialCipher, id: string): Promise<AdaptationRow> {
  const row = await startValidation(db, id);
  const patch = patchOf(row);
  const checks = new CheckList();
  const { patches: active } = await activePatches(db, row.integrationId);
  const before = active.filter((p) => p.id !== patch.id);
  // The events this customer's application received, in order (decrypted from the durable receipts).
  const receipts = await db
    .select()
    .from(webhookReceipts)
    .where(and(eq(webhookReceipts.integrationId, row.integrationId), inArray(webhookReceipts.disposition, ['accepted', 'recovery_input'])))
    .orderBy(webhookReceipts.receivedAt);
  const events = receipts.map(
    (r) => JSON.parse(Buffer.from(cipher.decrypt<string>(r.payloadCiphertext, `receipt:${r.id}`), 'base64').toString('utf8')) as StripeEventPayload,
  );
  // An event "at the earlier contract" carries its object in the first representation seen for that object.
  const kind = (e: StripeEventPayload) => String(e.data.object['object']);
  const baseline = new Map<string, string>();
  for (const e of events) if (!baseline.has(kind(e))) baseline.set(kind(e), fingerprintOf(shapeOf(e.data.object)));
  const changed = events.filter((e) => baseline.get(kind(e)) !== fingerprintOf(shapeOf(e.data.object)));
  const unchanged = events.filter((e) => !changed.includes(e));
  let a: Awaited<ReturnType<typeof replay>>, b: Awaited<ReturnType<typeof replay>>;
  try {
    a = await replay(before, `validate-${id}-before`, events);
    b = await replay([...before, patch], `validate-${id}-after`, events);
    checks.add('patch applies to the pinned file and the artifact loads', true, `${b.artifact.id} (${patch.file} ${patch.resultSha256.slice(0, 12)}…)`);
  } catch (err) {
    checks.add('patch applies to the pinned file and the artifact loads', false, String((err as Error).message));
    return recordValidation(db, id, checks.checks, { before: 'unknown', after: 'unknown' });
  }
  const same = unchanged.filter((e) => JSON.stringify(strip(a.records.get(e.id) ?? null)) === JSON.stringify(strip(b.records.get(e.id) ?? null)));
  checks.add(
    'events at the earlier contract are processed exactly as before',
    unchanged.length ? same.length === unchanged.length : null,
    unchanged.length ? `${same.length}/${unchanged.length} identical records` : 'no earlier-contract events recorded',
  );
  const fixedAfter = changed.filter((e) => {
    const x = expectationOf(e.data.object);
    return x ? compare(x, b.records.get(e.id) ?? null).length === 0 : true;
  });
  const brokenBefore = changed.filter((e) => {
    const x = expectationOf(e.data.object);
    return x ? compare(x, a.records.get(e.id) ?? null).length > 0 : false;
  });
  checks.add(
    'events at the changed contract now produce the records Stripe states',
    changed.length ? fixedAfter.length === changed.length : null,
    changed.length
      ? `${fixedAfter.length}/${changed.length} match Stripe after (${brokenBefore.length} did not before)`
      : 'no changed-contract events recorded',
  );
  const handler = 'src/webhooks/stripeWebhook.ts';
  const handlerSha = sha256(readFileSync(join(b.artifact.root, handler)));
  checks.add(
    'signature check, idempotency and retries are unchanged',
    patch.file !== handler && handlerSha === STRIPE_SUBSCRIPTIONS_APP.fileSha256[handler],
    `${handler} ${handlerSha.slice(0, 12)}… equals the pinned commit`,
  );
  checks.add('rollback target loads', true, `${a.artifact.id} (the artifact running now)`);
  return recordValidation(db, id, checks.checks, { before: a.artifact.id, after: b.artifact.id });
}

export const activateAppAdaptation = (db: Db, id: string, actor: string, note: string, opts?: { acceptLimitations?: boolean }) =>
  activateAdaptation(db, id, actor, note, APP_HOOKS, opts);
export const rollbackAppAdaptation = (db: Db, id: string, actor: string, reason: string) =>
  rollbackAdaptation(db, id, actor, reason, APP_HOOKS);
export const rejectAppAdaptation = (db: Db, id: string, actor: string, reason: string) =>
  rejectAdaptation(db, id, actor, reason);

export async function adaptationRows(db: Db, maintenanceEventId: string) {
  return db.select().from(adaptations).where(eq(adaptations.maintenanceEventId, maintenanceEventId)).orderBy(adaptations.createdAt);
}
