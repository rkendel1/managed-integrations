/**
 * The correction registry for adopted integrations (slice 5). One authority for which adapters and patches
 * change how the adopted code behaves for an integration, and why.
 *
 *   adapter  — translates a provider's changed input at the adoption boundary (before upstream runs).
 *              Upstream code unchanged. Today: `field_moved`.
 *   patch    — a reviewed, exact-text change to one upstream file (patches/*.json), applied to a
 *              content-addressed copy of the pinned package (artifact.ts). Never auto-activated.
 *   unsupported — a change we cannot correct safely (ambiguous, conflicting, meaning-changing, or a
 *              correction previously rolled back). Recorded with its reason; routed to a person.
 *
 * Lifecycle: proposed → validating → validated → active → rolled_back; or → rejected / unsupported.
 * Every transition is appended to `history` and to the audit log. Validation is separate from
 * activation; activation requires a passed validation (and an explicit decision when validation could
 * not cover everything); rollback selects the previous known-good behaviour.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { adaptations, deliveries, integrations, webhookReceipts, type Db } from '@mi/database';
import {
  activateAdaptation as activateGeneric,
  activeAdaptations,
  AdaptationError,
  CheckList,
  recordAdaptation,
  recordValidation,
  rejectAdaptation as rejectGeneric,
  rollbackAdaptation as rollbackGeneric,
  startValidation,
  type AdaptationRow,
  type RuntimeHooks,
} from '@mi/managed';
import {
  DEFAULT_RETRY,
  withRetry,
  type CredentialCipher,
  type RetryPolicy,
} from '@mi/integration-shopify-netsuite';
import { describeError } from '@mi/observability';
import { loadArtifact, patchCatalog, type ExecutorArtifact, type PatchDefinition } from './artifact.ts';
import { AdoptedConfigSchema } from './contract.ts';
import {
  applyInputCompat,
  checkInputContract,
  conflictViolations,
  FieldMovedSpecSchema,
  locateUpstreamRead,
  UPSTREAM_INPUT_CONTRACT,
  upstreamDir,
  type ContractViolation,
  type FieldMovedSpec,
} from './input-contract.ts';
import { ADOPTED } from './provenance.ts';
import { RECOVERY_ORDER_QUERY, type RecoveryOrder } from './source.ts';
import type { AdoptedClients } from './reconcile.ts';

export {
  ADAPTATION_KINDS,
  ADAPTATION_STATUSES,
  AdaptationError,
  activeAdaptations,
  adaptationsAwaitingDecision,
  previouslyRolledBack,
  type AdaptationRow,
  type AdaptationStatus,
  type AdaptationValidation,
  type ValidationCheck,
} from '@mi/managed';

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export const BASE_ARTIFACT = {
  repository: ADOPTED.repository,
  commit: ADOPTED.commit,
  package: ADOPTED.packageName,
};

/* ================================================================== stored evidence helpers */

export async function payloadOf(
  cipher: CredentialCipher,
  r: typeof webhookReceipts.$inferSelect,
): Promise<unknown> {
  const raw = Buffer.from(cipher.decrypt<string>(r.payloadCiphertext, `receipt:${r.id}`), 'base64');
  return JSON.parse(raw.toString('utf8'));
}

/** Recent webhook receipts that satisfied the ORIGINAL contract as received (no adaptation needed). */
export async function baselineReceipts(
  db: Db,
  cipher: CredentialCipher,
  integrationId: string,
  before: Date,
  limit = 50,
) {
  const rows = await db
    .select()
    .from(webhookReceipts)
    .where(
      and(
        eq(webhookReceipts.integrationId, integrationId),
        eq(webhookReceipts.origin, 'webhook'),
        eq(webhookReceipts.topic, 'orders/create'),
        lt(webhookReceipts.receivedAt, before),
      ),
    )
    .orderBy(desc(webhookReceipts.receivedAt))
    .limit(limit * 2);
  const out: { receipt: typeof webhookReceipts.$inferSelect; payload: unknown }[] = [];
  for (const r of rows) {
    const payload = await payloadOf(cipher, r);
    if (checkInputContract(payload).length === 0) out.push({ receipt: r, payload });
    if (out.length >= limit) break;
  }
  return out;
}

/* ================================================================== what runs */

export interface RuntimeSelection {
  artifact: ExecutorArtifact;
  adapters: (FieldMovedSpec & { adaptationId: string })[];
  adaptationIds: string[];
}

function patchOf(row: AdaptationRow): PatchDefinition {
  const id = (row.spec as { patchId: string }).patchId;
  const p = patchCatalog().find((x) => x.id === id);
  if (!p) throw new Error(`Patch ${id} (adaptation ${row.id}) is not in the reviewed catalog`);
  return p;
}

/** The code and adapters selected by a set of adaptation rows. */
export async function selectRuntime(rows: AdaptationRow[]): Promise<RuntimeSelection> {
  const adapters = rows
    .filter((r) => r.kind === 'adapter')
    .map((r) => ({ ...FieldMovedSpecSchema.parse(r.spec), adaptationId: r.id }));
  const artifact = await loadArtifact(rows.filter((r) => r.kind === 'patch').map(patchOf));
  return { artifact, adapters, adaptationIds: rows.map((r) => r.id) };
}

/** The runtime for an integration: what the executor runs right now. */
export async function runtimeFor(db: Db, integrationId: string): Promise<RuntimeSelection> {
  return selectRuntime(await activeAdaptations(db, integrationId));
}

/** Adapts a payload and checks it against the contract of the selected artifact. */
export function evaluateInput(payload: unknown, rt: Pick<RuntimeSelection, 'artifact' | 'adapters'>) {
  const adapted = applyInputCompat(payload, rt.adapters);
  const violations: ContractViolation[] = [
    ...conflictViolations(adapted.conflicts),
    ...checkInputContract(adapted.payload, { precision: rt.artifact.precision }),
  ];
  return { payload: adapted.payload, applied: adapted.applied, conflicts: adapted.conflicts, violations };
}

/* ================================================================== lifecycle (generic: @mi/managed) */

/** Which corrections may not be active together, and the runtime a set of them produces. */
export const RUNTIME_HOOKS: RuntimeHooks = {
  scopeKey: (r: AdaptationRow) =>
    r.kind === 'adapter' ? `a:${(r.spec as { target: string }).target}` : `p:${patchOf(r).file}`,
  loadRuntime: (rows: AdaptationRow[]) => selectRuntime(rows),
};

export interface ProposalInput {
  integrationId: string;
  maintenanceEventId?: string | null;
  kind: 'adapter' | 'patch' | 'unsupported';
  dependency: Record<string, unknown>;
  codePath: Record<string, unknown>;
  spec: Record<string, unknown>;
  rationale: string;
  evidence?: Record<string, unknown>;
  actor: string;
}

export async function proposeAdaptation(db: Db, p: ProposalInput): Promise<AdaptationRow> {
  if (p.kind === 'adapter') FieldMovedSpecSchema.parse(p.spec);
  if (p.kind === 'patch' && !patchCatalog().some((x) => x.id === (p.spec as { patchId?: string }).patchId))
    throw new AdaptationError('INVALID', 'Only reviewed patches from the catalog can be proposed');
  return recordAdaptation(db, { ...p, artifact: BASE_ARTIFACT });
}

/* ================================================================== validation */

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * Validates an adaptation WITHOUT activating it, with the real adopted code (before vs after):
 *  1. it applies to the adopted artifact (commit, contract field / pinned file);
 *  2. upstream files are unchanged (patch: the patched artifact reproduces the reviewed result exactly);
 *  3. regression: stored orders map to exactly the same canonical order before and after;
 *  4. affected (held) orders satisfy the contract and map without error after;
 *  5. business data preserved: mapped quantities and prices equal Shopify's own order record;
 *  6. no conflicting data is silently accepted;
 *  7. rollback target: the current (previous known-good) runtime loads and its upstream files match the pin.
 */
export async function validateAdaptation(
  db: Db,
  cipher: CredentialCipher,
  adaptationId: string,
  clients: AdoptedClients,
  retry: RetryPolicy = DEFAULT_RETRY,
): Promise<AdaptationRow> {
  const row0 = await startValidation(db, adaptationId);
  const list = new CheckList();
  const checks = list.checks;
  const add = (name: string, ok: boolean | null, detail: string) => list.add(name, ok, detail);
  let artifactIds = { before: '', after: '' };
  try {
    const [integ] = await db.select().from(integrations).where(eq(integrations.id, row0.integrationId));
    const config = AdoptedConfigSchema.parse(integ!.config);
    const opts = { customerByEmail: config.customerByEmail, defaultCustomer: config.defaultCustomer };
    const current = (await activeAdaptations(db, row0.integrationId)).filter((r) => r.id !== row0.id);
    const before = await selectRuntime(current);
    const after = await selectRuntime([...current, row0]);
    artifactIds = { before: before.artifact.id, after: after.artifact.id };

    // 1. applies to the adopted artifact
    if (row0.kind === 'adapter') {
      const spec = FieldMovedSpecSchema.parse(row0.spec);
      const field = UPSTREAM_INPUT_CONTRACT.find((f) => f.path === spec.target);
      const reads = field ? locateUpstreamRead(field) : [];
      add(
        'applies to the adopted artifact',
        (row0.artifact as { commit: string }).commit === ADOPTED.commit && !!field && reads.length > 0,
        field
          ? `${spec.target} is read at ${reads.map((r) => `${r.file}:${r.line}`).join(', ')} in ${ADOPTED.commit.slice(0, 12)}`
          : `${spec.target} is not a field the adopted code reads`,
      );
    } else {
      const p = patchOf(row0);
      add(
        'applies to the adopted artifact',
        p.artifact.commit === ADOPTED.commit &&
          p.baseSha256 === ADOPTED.fileSha256[p.file as keyof typeof ADOPTED.fileSha256],
        `${p.file} at ${p.artifact.commit.slice(0, 12)}; base sha256 ${p.baseSha256.slice(0, 12)}`,
      );
    }

    // 2. upstream unchanged; patched artifact reproduces the reviewed result
    const dir = upstreamDir();
    const drift = Object.entries(ADOPTED.fileSha256).filter(
      ([f, h]) => sha256(readFileSync(join(dir, f))) !== h,
    );
    add(
      'original adopted code unchanged',
      drift.length === 0,
      drift.length
        ? `changed: ${drift.map(([f]) => f).join(', ')}`
        : `${Object.keys(ADOPTED.fileSha256).length} files match ${ADOPTED.commit.slice(0, 12)}`,
    );
    if (row0.kind === 'patch') {
      const p = patchOf(row0);
      const others = Object.entries(after.artifact.files).filter(
        ([f, h]) => f !== p.file && h !== ADOPTED.fileSha256[f as keyof typeof ADOPTED.fileSha256],
      );
      add(
        'patch reproduces the reviewed change exactly',
        after.artifact.files[p.file] === p.resultSha256 && others.length === 0,
        `${p.file} sha256 ${after.artifact.files[p.file]?.slice(0, 12)} (reviewed ${p.resultSha256.slice(0, 12)}); other files unchanged: ${others.length === 0}`,
      );
    }

    // 3. regression on stored orders
    const baseline = await baselineReceipts(db, cipher, row0.integrationId, new Date());
    let same = 0;
    const differ: string[] = [];
    for (const b of baseline) {
      const x = evaluateInput(b.payload, before);
      const y = evaluateInput(b.payload, after);
      const m = (rt: RuntimeSelection, p: unknown) => {
        try {
          return JSON.stringify(rt.artifact.modules.toCanonicalOrder(p, opts));
        } catch (err) {
          return `error:${describeError(err).message}`;
        }
      };
      if (m(before, x.payload) === m(after, y.payload)) same++;
      else differ.push(b.receipt.id);
    }
    add(
      'regression: stored orders unchanged',
      baseline.length ? differ.length === 0 : null,
      baseline.length
        ? `${same}/${baseline.length} stored orders map identically${differ.length ? `; differ: ${differ.join(', ')}` : ''}`
        : 'no stored orders to replay',
    );

    // 4–6. affected orders, against the independent source
    const held = await db
      .select()
      .from(deliveries)
      .where(and(eq(deliveries.integrationId, row0.integrationId), eq(deliveries.outcome, 'held')))
      .orderBy(asc(deliveries.createdAt));
    let mapped = 0;
    let matched = 0;
    let conflicts = 0;
    const problems: string[] = [];
    for (const d of held) {
      const [r] = await db.select().from(webhookReceipts).where(eq(webhookReceipts.id, d.receiptId!));
      const ev = evaluateInput(await payloadOf(cipher, r!), after);
      conflicts += ev.conflicts.length;
      if (ev.violations.length) {
        problems.push(`${d.sourceName}: ${ev.violations.map((v) => `${v.path} ${v.observed}`).join(', ')}`);
        continue;
      }
      let canonical;
      try {
        canonical = after.artifact.modules.toCanonicalOrder(ev.payload, opts);
        mapped++;
      } catch (err) {
        problems.push(`${d.sourceName}: ${describeError(err).message}`);
        continue;
      }
      const res = await withRetry(
        () => clients.shopify.graphql(RECOVERY_ORDER_QUERY, { id: d.sourceId }),
        retry,
      );
      const order = (res.data as { order?: RecoveryOrder | null }).order;
      const dp = after.artifact.precision['line_items[].price'] ?? 2;
      const expected = (order?.lineItems.nodes ?? [])
        .filter((l) => !!l.sku)
        .map((l) => ({
          sku: l.sku,
          qty: l.quantity,
          unitPrice: round(Number(l.originalUnitPriceSet.shopMoney.amount), dp),
        }));
      if (JSON.stringify(expected) === JSON.stringify(canonical.lines)) matched++;
      else problems.push(`${d.sourceName}: mapped lines differ from Shopify's order record`);
    }
    add(
      'affected orders handled',
      held.length ? mapped === held.length : null,
      held.length
        ? `${mapped}/${held.length} held orders satisfy the contract and map without error`
        : 'no held orders to validate against',
    );
    add(
      'business data preserved (Shopify Admin API)',
      held.length ? matched === held.length : null,
      held.length
        ? `${matched}/${held.length} orders: quantities and unit prices equal Shopify's order record`
        : 'no held orders to compare',
    );
    add(
      'no conflicting data accepted',
      conflicts === 0,
      conflicts ? `${conflicts} conflicting value(s) between a field and its replacement` : 'no conflicts',
    );

    // 7. rollback target
    const pinned = Object.entries(before.artifact.files).every(
      ([f, h]) =>
        before.artifact.patches.some((p) => p.file === f) ||
        h === ADOPTED.fileSha256[f as keyof typeof ADOPTED.fileSha256],
    );
    add(
      'rollback target available',
      pinned,
      `rolling back selects ${before.artifact.id} (${before.adapters.length} adapter(s))`,
    );
    if (problems.length)
      checks.push({ name: 'problems', status: 'failed', detail: problems.slice(0, 10).join('; ') });
  } catch (err) {
    add('validation ran', false, describeError(err).message);
  }
  return recordValidation(db, adaptationId, checks, artifactIds);
}

/* ================================================================== activation and rollback */

export async function activateAdaptation(
  db: Db,
  adaptationId: string,
  actor: string,
  note: string,
  opts: { acceptLimitations?: boolean } = {},
): Promise<AdaptationRow> {
  return activateGeneric(db, adaptationId, actor, note, RUNTIME_HOOKS, opts);
}

export async function rollbackAdaptation(db: Db, adaptationId: string, actor: string, reason: string) {
  return rollbackGeneric(db, adaptationId, actor, reason, RUNTIME_HOOKS);
}

export async function rejectAdaptation(db: Db, adaptationId: string, actor: string, reason: string) {
  return rejectGeneric(db, adaptationId, actor, reason);
}

/* ================================================================== "what exact code is running and why" */

export async function runningCode(db: Db, integrationId: string) {
  const rows = await db
    .select()
    .from(adaptations)
    .where(eq(adaptations.integrationId, integrationId))
    .orderBy(desc(adaptations.createdAt));
  const active = rows.filter((r) => r.status === 'active');
  let artifact: ExecutorArtifact | null = null;
  let problem: string | null = null;
  try {
    artifact = (await selectRuntime(active)).artifact;
  } catch (err) {
    problem = describeError(err).message;
  }
  const dir = upstreamDir();
  const pinned = Object.entries(ADOPTED.fileSha256).map(([file, expected]) => {
    const actual = sha256(readFileSync(join(dir, file)));
    return { file, expected, actual, matches: actual === expected };
  });
  return {
    adopted: {
      repository: ADOPTED.repository,
      commit: ADOPTED.commit,
      license: ADOPTED.license,
      package: ADOPTED.packageName,
    },
    pinnedFiles: pinned,
    running: artifact
      ? { id: artifact.id, patches: artifact.patches, files: artifact.files, precision: artifact.precision }
      : null,
    problem,
    contracts: UPSTREAM_INPUT_CONTRACT.map((f) => ({
      path: f.path,
      label: f.label,
      expected: f.kind,
      effect: f.upstream.effect,
      precision: artifact?.precision[f.path] ?? null,
      reads: locateUpstreamRead(f).map((r) => ({
        file: r.file,
        line: r.line,
        code: r.code,
        matchesPinnedCommit: r.matchesPinnedCommit,
      })),
    })),
    adaptations: rows,
    catalog: patchCatalog().map((p) => ({ id: p.id, title: p.title, file: p.file, addresses: p.addresses })),
  };
}
