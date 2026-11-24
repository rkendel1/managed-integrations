/**
 * The correction registry lifecycle (generic; extracted from slice 5). One authority — the `adaptations`
 * table — for which adapters and reviewed patches change how an adopted integration behaves, and why.
 *
 *   proposed → validating → validated → active → rolled_back
 *            ↘ rejected            unsupported (terminal, with its reason)
 *
 * Generic here: the record (provenance, dependency, code path, spec, evidence), the append-only history and
 * audit trail, the validation verdict (passed / requires a decision / failed), activation guards, rollback
 * and rejection. Integration-specific and supplied by the caller: what a spec means, how validation checks
 * are run, which runtime a set of corrections produces (must load before anything switches), and which
 * corrections may not be active together (scope key).
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { adaptations, auditLog, integrations, type Db } from '@mi/database';

/**
 * adapter       — bounded translation at an integration edge (source input or target request), adopted code unchanged;
 * patch         — reviewed change to adopted code (content-addressed copy; operator activation);
 * configuration — controlled change of an explicitly supported runtime setting (e.g. account mapping, subsidiary);
 * decision      — a choice only a person may make (business meaning, financial treatment, legal entity);
 * unsupported   — no correction; affected work stays held, the reason is recorded.
 */
export const ADAPTATION_KINDS = ['adapter', 'patch', 'configuration', 'decision', 'unsupported'] as const;
export type AdaptationKind = (typeof ADAPTATION_KINDS)[number];
export const ADAPTATION_STATUSES = [
  'proposed',
  'validating',
  'validated',
  'active',
  'rejected',
  'rolled_back',
  'unsupported',
] as const;
export type AdaptationStatus = (typeof ADAPTATION_STATUSES)[number];
export type AdaptationRow = typeof adaptations.$inferSelect;

export class AdaptationError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID',
    message: string,
  ) {
    super(message);
  }
}

const actorRole = (actor: string) => (actor.startsWith('system') ? 'system' : 'operator');
const actorUser = (actor: string) => (/^[0-9a-f-]{36}$/.test(actor) ? actor : null);

/** Moves an adaptation between statuses (row-locked), appending history and an audit entry. */
export async function transitionAdaptation(
  db: Db,
  id: string,
  from: AdaptationStatus[],
  to: AdaptationStatus,
  actor: string,
  note: string,
  extra: Partial<typeof adaptations.$inferInsert> = {},
): Promise<AdaptationRow> {
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(adaptations).where(eq(adaptations.id, id)).for('update');
    if (!cur) throw new AdaptationError('NOT_FOUND', `Adaptation ${id} not found`);
    if (!from.includes(cur.status as AdaptationStatus))
      throw new AdaptationError('CONFLICT', `Adaptation is ${cur.status}; cannot move to ${to}`);
    const at = new Date();
    const [row] = await tx
      .update(adaptations)
      .set({
        ...extra,
        status: to,
        history: sql`${adaptations.history} || ${JSON.stringify([{ at: at.toISOString(), from: cur.status, to, actor, note }])}::jsonb`,
        updatedAt: at,
      })
      .where(eq(adaptations.id, id))
      .returning();
    await tx.insert(auditLog).values({
      actorRole: actorRole(actor),
      actorUserId: actorUser(actor),
      action: `adaptation.${to}`,
      targetType: 'adaptation',
      targetId: id,
      details: { from: cur.status, note, integrationId: cur.integrationId },
    });
    return row!;
  });
}

export interface AdaptationRecordInput {
  integrationId: string;
  maintenanceEventId?: string | null;
  kind: AdaptationKind;
  /** The component whose change this answers (slice 7). Defaults to source. */
  boundary?: 'source' | 'integration' | 'target' | 'combined';
  /** Affected operations / transactions. */
  impact?: Record<string, unknown>;
  /** The adopted artifact it applies to (repository, commit, package). */
  artifact: Record<string, unknown>;
  dependency: Record<string, unknown>;
  codePath: Record<string, unknown>;
  spec: Record<string, unknown>;
  rationale: string;
  evidence?: Record<string, unknown>;
  actor: string;
}

/** Records a proposal (or an unsupported change, which is terminal) with its provenance. */
export async function recordAdaptation(db: Db, p: AdaptationRecordInput): Promise<AdaptationRow> {
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, p.integrationId));
  if (!integ) throw new AdaptationError('NOT_FOUND', 'Integration not found');
  const status: AdaptationStatus = p.kind === 'unsupported' ? 'unsupported' : 'proposed';
  const at = new Date().toISOString();
  const [row] = await db
    .insert(adaptations)
    .values({
      tenantId: integ.tenantId,
      integrationId: integ.id,
      maintenanceEventId: p.maintenanceEventId ?? null,
      kind: p.kind,
      status,
      boundary: p.boundary ?? 'source',
      impact: p.impact ?? {},
      artifact: p.artifact,
      dependency: p.dependency,
      codePath: p.codePath,
      spec: p.spec,
      rationale: p.rationale,
      evidence: p.evidence ?? {},
      history: [{ at, from: null, to: status, actor: p.actor, note: p.rationale }],
    })
    .returning();
  await db.insert(auditLog).values({
    actorRole: actorRole(p.actor),
    actorUserId: actorUser(p.actor),
    action: `adaptation.${status}`,
    targetType: 'adaptation',
    targetId: row!.id,
    details: { kind: p.kind, integrationId: integ.id },
  });
  return row!;
}

export async function activeAdaptations(db: Db, integrationId: string): Promise<AdaptationRow[]> {
  return db
    .select()
    .from(adaptations)
    .where(and(eq(adaptations.integrationId, integrationId), eq(adaptations.status, 'active')))
    .orderBy(asc(adaptations.activatedAt));
}

export async function adaptationsOf(db: Db, integrationId: string): Promise<AdaptationRow[]> {
  return db
    .select()
    .from(adaptations)
    .where(eq(adaptations.integrationId, integrationId))
    .orderBy(desc(adaptations.createdAt));
}

const canon = (v: unknown): string =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? `{${Object.keys(v as object)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
        .join(',')}}`
    : JSON.stringify(v);

/** A correction with the same spec that an operator rolled back (never re-applied automatically). */
export async function previouslyRolledBack(db: Db, integrationId: string, spec: Record<string, unknown>) {
  const rows = await db
    .select()
    .from(adaptations)
    .where(and(eq(adaptations.integrationId, integrationId), eq(adaptations.status, 'rolled_back')));
  // jsonb does not preserve key order: compare canonically.
  return rows.find((r) => canon(r.spec) === canon(spec)) ?? null;
}

/* ================================================================== validation verdict */

export interface ValidationCheck {
  name: string;
  status: 'passed' | 'failed' | 'not_applicable';
  detail: string;
}
export interface AdaptationValidation {
  passed: boolean;
  /** Some checks could not run: activation then needs an explicit human decision. */
  requiresDecision: boolean;
  checks: ValidationCheck[];
  /** Verified after activation by the maintenance event (accounting, destination, duplicates, recovery). */
  postActivation: Record<string, unknown> | null;
  artifact: { before: string; after: string };
  validatedAt: string;
}

/** Collects checks with a uniform status rule: null = could not run (not applicable). */
export class CheckList {
  readonly checks: ValidationCheck[] = [];
  add(name: string, ok: boolean | null, detail: string) {
    this.checks.push({ name, status: ok === null ? 'not_applicable' : ok ? 'passed' : 'failed', detail });
  }
}

export async function startValidation(db: Db, id: string): Promise<AdaptationRow> {
  return transitionAdaptation(
    db,
    id,
    ['proposed', 'validated'],
    'validating',
    'system:validation',
    'Validation started',
  );
}

/** Persists the verdict: any failed check rejects; any check that could not run requires a decision. */
export async function recordValidation(
  db: Db,
  id: string,
  checks: ValidationCheck[],
  artifact: { before: string; after: string },
): Promise<AdaptationRow> {
  const passed = checks.length > 0 && !checks.some((c) => c.status === 'failed');
  const validation: AdaptationValidation = {
    passed,
    requiresDecision: passed && checks.some((c) => c.status === 'not_applicable'),
    checks,
    postActivation: null,
    artifact,
    validatedAt: new Date().toISOString(),
  };
  return transitionAdaptation(
    db,
    id,
    ['validating'],
    passed ? 'validated' : 'rejected',
    'system:validation',
    passed
      ? validation.requiresDecision
        ? 'Validated with limitations (decision required)'
        : 'Validated'
      : `Validation failed: ${checks
          .filter((c) => c.status === 'failed')
          .map((c) => c.name)
          .join(', ')}`,
    { validation },
  );
}

/* ================================================================== activation and rollback */

export interface RuntimeHooks {
  /** Corrections that cannot be active together share a scope key (e.g. the same field or file). */
  scopeKey(row: AdaptationRow): string;
  /** Builds the runtime a set of active corrections produces; must throw if it cannot load. */
  loadRuntime(rows: AdaptationRow[]): Promise<unknown>;
  /** Configuration corrections: make the setting take effect (before the row becomes active). */
  apply?(row: AdaptationRow): Promise<void>;
  /** Configuration corrections: restore the previous setting (before the row is rolled back). */
  revert?(row: AdaptationRow): Promise<void>;
}

export async function activateAdaptation(
  db: Db,
  adaptationId: string,
  actor: string,
  note: string,
  hooks: RuntimeHooks,
  opts: { acceptLimitations?: boolean } = {},
): Promise<AdaptationRow> {
  const [row] = await db.select().from(adaptations).where(eq(adaptations.id, adaptationId));
  if (!row) throw new AdaptationError('NOT_FOUND', 'Adaptation not found');
  const v = row.validation as AdaptationValidation | null;
  if (row.status !== 'validated' || !v?.passed)
    throw new AdaptationError('CONFLICT', 'Only a validated adaptation can be activated');
  if (v.requiresDecision && !opts.acceptLimitations)
    throw new AdaptationError(
      'CONFLICT',
      'Validation could not cover everything; activation needs an explicit decision to accept its limitations',
    );
  const active = await activeAdaptations(db, row.integrationId);
  const scope = hooks.scopeKey(row);
  if (active.some((r) => hooks.scopeKey(r) === scope))
    throw new AdaptationError(
      'CONFLICT',
      `Another active correction already changes the same behaviour (${scope})`,
    );
  // The runtime it produces must load before anything switches.
  await hooks.loadRuntime([...active, row]);
  // A configuration correction changes a setting: it takes effect first; if the row cannot become active the
  // setting is restored, so the setting and the correction's status never disagree.
  if (row.kind === 'configuration') {
    if (!hooks.apply) throw new AdaptationError('CONFLICT', 'This integration cannot apply configuration corrections');
    await hooks.apply(row);
  }
  try {
    return await transitionAdaptation(db, adaptationId, ['validated'], 'active', actor, note, {
      activatedAt: new Date(),
    });
  } catch (err) {
    if (row.kind === 'configuration') await hooks.revert?.(row);
    throw err;
  }
}

export async function rollbackAdaptation(
  db: Db,
  adaptationId: string,
  actor: string,
  reason: string,
  hooks: Pick<RuntimeHooks, 'loadRuntime' | 'revert'>,
): Promise<AdaptationRow> {
  const [row] = await db.select().from(adaptations).where(eq(adaptations.id, adaptationId));
  if (!row) throw new AdaptationError('NOT_FOUND', 'Adaptation not found');
  if (row.status !== 'active')
    throw new AdaptationError(
      'CONFLICT',
      `Adaptation is ${row.status}; only an active one can be rolled back`,
    );
  const remaining = (await activeAdaptations(db, row.integrationId)).filter((r) => r.id !== row.id);
  // The previous known-good runtime must load before we switch to it; otherwise the correction stays active.
  try {
    await hooks.loadRuntime(remaining);
  } catch (err) {
    throw new AdaptationError(
      'CONFLICT',
      `Rollback refused: the previous runtime does not load (${err instanceof Error ? err.message : String(err)}); the correction stays active`,
    );
  }
  if (row.kind === 'configuration') {
    if (!hooks.revert) throw new AdaptationError('CONFLICT', 'This integration cannot revert configuration corrections');
    await hooks.revert(row);
  }
  return transitionAdaptation(db, adaptationId, ['active'], 'rolled_back', actor, reason, {
    rolledBackAt: new Date(),
  });
}

export async function rejectAdaptation(db: Db, adaptationId: string, actor: string, reason: string) {
  return transitionAdaptation(db, adaptationId, ['proposed', 'validated'], 'rejected', actor, reason);
}

/** Adaptations needing a person: unsupported, awaiting activation decision, or proposed. */
export async function adaptationsAwaitingDecision(db: Db) {
  return db
    .select()
    .from(adaptations)
    .where(inArray(adaptations.status, ['unsupported', 'validated', 'proposed']))
    .orderBy(desc(adaptations.createdAt));
}

/** Writes the maintenance event's post-activation verification back onto the correction. */
export async function recordPostActivation(
  db: Db,
  adaptationId: string,
  postActivation: Record<string, unknown>,
) {
  await db
    .update(adaptations)
    .set({
      validation: sql`jsonb_set(coalesce(${adaptations.validation}, '{}'::jsonb), '{postActivation}', ${JSON.stringify(postActivation)}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(eq(adaptations.id, adaptationId));
}

/* ================================================================== decisions (slice 7) */

export interface DecisionOption {
  id: string;
  label: string;
  detail?: string;
}
export interface DecisionSpec {
  question: string;
  options: DecisionOption[];
  /** Who may decide: the customer (business meaning, financial treatment) or an operator. */
  authority: 'customer' | 'operator';
  choice?: string;
  decidedBy?: string;
  decidedAt?: string;
}

/** Records a question only a person may answer, as a correction of kind `decision` (proposed until decided). */
export async function requestDecision(
  db: Db,
  p: Omit<AdaptationRecordInput, 'kind' | 'spec' | 'artifact' | 'codePath' | 'dependency'> & {
    dependency?: Record<string, unknown>;
    question: string;
    options: DecisionOption[];
    authority: 'customer' | 'operator';
    artifact?: Record<string, unknown>;
  },
) {
  return recordAdaptation(db, {
    ...p,
    kind: 'decision',
    dependency: p.dependency ?? {},
    artifact: p.artifact ?? {},
    codePath: {},
    spec: { question: p.question, options: p.options, authority: p.authority } satisfies DecisionSpec,
  });
}

/**
 * Records the decision. Customers may decide only what is theirs to decide; operators may decide operator
 * questions (and are refused customer ones — they are not the customer). The choice must be one of the
 * offered options. History keeps who decided, when, and what.
 */
export async function decide(
  db: Db,
  adaptationId: string,
  p: { optionId: string; actor: string; role: 'customer' | 'operator'; tenantId?: string | null },
) {
  const [row] = await db.select().from(adaptations).where(eq(adaptations.id, adaptationId));
  if (!row || row.kind !== 'decision') throw new AdaptationError('NOT_FOUND', 'Decision not found');
  if (p.role === 'customer' && row.tenantId !== p.tenantId) throw new AdaptationError('NOT_FOUND', 'Decision not found');
  const spec = row.spec as unknown as DecisionSpec;
  if (spec.authority !== p.role)
    throw new AdaptationError('CONFLICT', `This decision belongs to the ${spec.authority}`);
  const option = spec.options.find((o) => o.id === p.optionId);
  if (!option) throw new AdaptationError('INVALID', 'Not one of the offered options');
  const decided: DecisionSpec = { ...spec, choice: option.id, decidedBy: p.actor, decidedAt: new Date().toISOString() };
  // A decision is "validated" by being one of the offered, evidence-backed options; it becomes active when made.
  return transitionAdaptation(db, adaptationId, ['proposed'], 'active', p.actor, `Decided: ${option.label}`, {
    spec: decided as unknown as Record<string, unknown>,
    validation: {
      passed: true,
      requiresDecision: false,
      checks: [{ name: 'decided by the authorized party', status: 'passed', detail: `${p.role} chose "${option.label}"` }],
      postActivation: null,
      artifact: { before: '', after: '' },
      validatedAt: new Date().toISOString(),
    },
    activatedAt: new Date(),
  });
}

/** Corrections of one maintenance event (a window can need several, each independently reviewable). */
export async function correctionsOf(db: Db, maintenanceEventId: string) {
  return db
    .select()
    .from(adaptations)
    .where(eq(adaptations.maintenanceEventId, maintenanceEventId))
    .orderBy(asc(adaptations.createdAt));
}
