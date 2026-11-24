/**
 * Onboarding (generic; extracted from slice 5): Connect → Discover → Confirm → Protect, for any integration.
 *
 * One durable record per (customer, integration kind) in `onboardings`, so a customer with several
 * integrations onboards each one separately — sharing their connections (one per provider) — and an
 * interrupted onboarding resumes where it stopped.
 *
 * Generic here: readiness (are this integration's systems connected?), the state machine, the discovery
 * outcome vocabulary, explicit versioned confirmation, creation of the managed integration, the resumable
 * activation driver, and the final transition to managed. Integration-specific and supplied by its
 * implementation: how discovery reads evidence from the connected systems, what the integration record
 * holds, and its activation steps (e.g. register a notification, baseline, record history, verify).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { auditLog, connections, integrations, onboardings, type Db } from '@mi/database';
import type { IntegrationDescriptor, Responsibilities } from './descriptor.ts';

export const ONBOARDING_STATUSES = [
  'connect',
  'discovering',
  'confirm',
  'select',
  'activating',
  'managed',
  'blocked',
] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];
export type OnboardingRow = typeof onboardings.$inferSelect;

export class OnboardingError extends Error {}

export interface Candidate {
  id: string;
  /** adoptable: their existing integration, which we can run; unsupported: another integration we cannot
   *  adopt; new: a managed integration of this kind starting now. */
  kind: 'adoptable' | 'unsupported' | 'new';
  title: string;
  summary: string;
  implementation: string | null;
  confidence: 'established' | 'partial' | null;
  evidence: Record<string, unknown>;
}
export interface Discovery {
  at: string;
  outcome: 'found' | 'ambiguous' | 'unsupported' | 'not_found' | 'insufficient_evidence' | 'already_managed';
  window: { from: string; to: string };
  sampled: number;
  candidates: Candidate[];
}

/** Coverage rule shared by every discovery: how strongly the evidence establishes an integration. */
export function confidenceOf(matched: number, sampled: number): 'established' | 'partial' {
  return sampled > 0 && matched / sampled >= 0.8 && matched >= 3 ? 'established' : 'partial';
}

/** Outcome rule shared by every discovery. */
export function discoveryOutcome(candidates: Candidate[]): Discovery['outcome'] {
  const adoptable = candidates.some((c) => c.kind === 'adoptable');
  const unsupported = candidates.some((c) => c.kind === 'unsupported');
  return adoptable && !unsupported
    ? 'found'
    : adoptable
      ? 'ambiguous'
      : unsupported
        ? 'unsupported'
        : 'not_found';
}

export interface StepContext {
  db: Db;
  tenantId: string;
  integrationId: string;
  confirmation: Confirmation;
  /** Durable record of this step so far (undefined on first run). */
  record: Record<string, unknown> | undefined;
  /** Records of earlier steps. */
  records: Record<string, Record<string, unknown>>;
  save(record: Record<string, unknown> | undefined): Promise<void>;
}
export type StepResult =
  | { state: 'done'; detail: string; record: Record<string, unknown> }
  | { state: 'continue' | 'wait'; detail: string }
  | { state: 'blocked'; detail: string; problem: string };
export interface ActivationStep {
  key: string;
  /** Customer-facing description of what this step establishes. */
  label: string;
  run(ctx: StepContext): Promise<StepResult>;
}

export interface OnboardingImplementation {
  descriptor: IntegrationDescriptor & { responsibilities: Responsibilities };
  /** Reads the customer's connected systems for evidence of an existing integration of this kind. */
  discover(db: Db, tenantId: string, opts: { now?: Date }): Promise<Discovery>;
  /** Registers the integration's contract (idempotent) before the integration row references it. */
  ensureContract(db: Db): Promise<void>;
  integrationValues(
    c: Candidate,
    coverFrom: string,
  ): { displayName: string; contractVersion: string; config: Record<string, unknown> };
  steps: ActivationStep[];
  /** The facts shown once managed (e.g. what the baseline found). */
  baselineResult(db: Db, records: Record<string, Record<string, unknown>>): Promise<Record<string, unknown>>;
}

export interface Confirmation {
  candidateId: string;
  kind: Candidate['kind'];
  implementation: string | null;
  coverFrom: string;
  responsibilitiesVersion: string;
  responsibilities: Responsibilities;
  by: string;
  at: string;
}

/* ================================================================== state */

const CONNECTED = ['authorized', 'verified'];

/** Providers whose connection holds usable credentials for this tenant. */
export async function connectedProviders(db: Db, tenantId: string): Promise<Set<string>> {
  const rows = await db.select().from(connections).where(eq(connections.tenantId, tenantId));
  return new Set(
    rows.filter((c) => CONNECTED.includes(c.status) && !!c.credentialsCiphertext).map((c) => c.providerId),
  );
}

export function systemsReady(d: IntegrationDescriptor, connected: Set<string>) {
  return connected.has(d.source.id) && connected.has(d.destination.id);
}

export async function getOnboarding(db: Db, tenantId: string, flowType: string): Promise<OnboardingRow> {
  // An integration of this kind that is already active (enrolled before self-service onboarding) is managed.
  const [active] = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(
      and(
        eq(integrations.tenantId, tenantId),
        eq(integrations.flowType, flowType),
        eq(integrations.lifecycle, 'active'),
      ),
    )
    .limit(1);
  await db
    .insert(onboardings)
    .values({ tenantId, flowType, status: active ? 'managed' : 'connect', integrationId: active?.id ?? null })
    .onConflictDoNothing();
  const [row] = await db
    .select()
    .from(onboardings)
    .where(and(eq(onboardings.tenantId, tenantId), eq(onboardings.flowType, flowType)));
  return row!;
}

export async function onboardingsOf(db: Db, tenantId: string): Promise<OnboardingRow[]> {
  return db.select().from(onboardings).where(eq(onboardings.tenantId, tenantId));
}

async function setOnboarding(
  db: Db,
  tenantId: string,
  flowType: string,
  set: Partial<typeof onboardings.$inferInsert>,
) {
  const [row] = await db
    .update(onboardings)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(onboardings.tenantId, tenantId), eq(onboardings.flowType, flowType)))
    .returning();
  return row!;
}

/** The customer's overall position, from the per-integration records (most actionable first). */
export function overallStatus(rows: Pick<OnboardingRow, 'status'>[]): OnboardingStatus {
  const order: OnboardingStatus[] = ['confirm', 'select', 'blocked', 'activating', 'discovering', 'managed'];
  for (const s of order) if (rows.some((r) => r.status === s)) return s;
  return 'connect';
}

/* ================================================================== discover */

/** Runs discovery for one integration kind and records the result (resumable; never downgrades a managed one). */
export async function runDiscovery(
  db: Db,
  tenantId: string,
  impl: OnboardingImplementation,
  opts: { now?: Date } = {},
) {
  const flowType = impl.descriptor.flowType;
  const ob = await getOnboarding(db, tenantId, flowType);
  if (ob.status === 'activating' || ob.status === 'managed') return ob;
  if (!systemsReady(impl.descriptor, await connectedProviders(db, tenantId)))
    return setOnboarding(db, tenantId, flowType, { status: 'connect', problem: null });
  await setOnboarding(db, tenantId, flowType, { status: 'discovering', problem: null });
  try {
    const discovery = await impl.discover(db, tenantId, opts);
    const status: OnboardingStatus =
      discovery.outcome === 'already_managed'
        ? 'managed'
        : discovery.outcome === 'found'
          ? 'confirm'
          : 'select';
    return setOnboarding(db, tenantId, flowType, { status, discovery });
  } catch (err) {
    return setOnboarding(db, tenantId, flowType, {
      status: 'blocked',
      problem: `We could not read your systems to look for the integration (${err instanceof Error ? err.message : String(err)}). Check the connections and try again.`,
    });
  }
}

/** Runs discovery for every integration kind whose systems the customer has connected. */
export async function discoverAll(
  db: Db,
  tenantId: string,
  impls: OnboardingImplementation[],
  opts: { now?: Date } = {},
) {
  const connected = await connectedProviders(db, tenantId);
  const out: OnboardingRow[] = [];
  for (const impl of impls) {
    if (!systemsReady(impl.descriptor, connected)) continue;
    out.push(await runDiscovery(db, tenantId, impl, opts));
  }
  return out;
}

/* ================================================================== confirm */

export async function confirmOnboarding(
  db: Db,
  tenantId: string,
  impl: OnboardingImplementation,
  p: { candidateId: string; responsibilitiesVersion: string; userId: string },
) {
  const flowType = impl.descriptor.flowType;
  const ob = await getOnboarding(db, tenantId, flowType);
  if (ob.status !== 'confirm' && ob.status !== 'select')
    throw new OnboardingError(`Nothing to confirm (onboarding is ${ob.status})`);
  const responsibilities = impl.descriptor.responsibilities;
  if (p.responsibilitiesVersion !== responsibilities.version)
    throw new OnboardingError('The responsibilities changed; review them again');
  const discovery = ob.discovery as Discovery;
  const c = discovery.candidates.find((x) => x.id === p.candidateId);
  if (!c) throw new OnboardingError('Unknown choice');
  if (c.kind === 'unsupported')
    throw new OnboardingError(
      'We cannot take over that integration’s software; choose the managed integration instead',
    );
  await impl.ensureContract(db);
  // Adopting an existing integration covers its recent history; a NEW integration starts now.
  const coverFrom = c.kind === 'new' ? new Date().toISOString() : discovery.window.from;
  const values = impl.integrationValues(c, coverFrom);
  return db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(onboardings)
      .where(and(eq(onboardings.tenantId, tenantId), eq(onboardings.flowType, flowType)))
      .for('update');
    if (locked!.integrationId) throw new OnboardingError('Already confirmed');
    const [integ] = await tx
      .insert(integrations)
      .values({ tenantId, flowType, ...values, enabled: true, lifecycle: 'setup' })
      .returning();
    const confirmation: Confirmation = {
      candidateId: c.id,
      kind: c.kind,
      implementation: c.implementation,
      coverFrom,
      responsibilitiesVersion: responsibilities.version,
      responsibilities,
      by: p.userId,
      at: new Date().toISOString(),
    };
    await tx
      .update(onboardings)
      .set({
        status: 'activating',
        confirmation,
        integrationId: integ!.id,
        activation: { steps: {}, done: [] },
        problem: null,
        updatedAt: new Date(),
      })
      .where(and(eq(onboardings.tenantId, tenantId), eq(onboardings.flowType, flowType)));
    await tx.insert(auditLog).values({
      actorUserId: p.userId,
      actorRole: 'customer',
      action: 'onboarding.confirmed',
      targetType: 'integration',
      targetId: integ!.id,
      details: { flowType, candidateId: c.id, responsibilitiesVersion: responsibilities.version },
    });
    return integ!;
  });
}

/* ================================================================== protect */

export type OnboardingAdvance = { state: 'continue' | 'wait' | 'done' | 'blocked' | 'noop'; detail: string };
interface Activation {
  steps: Record<string, Record<string, unknown>>;
  done: string[];
}

/** Advances activation by one step; idempotent and resumable. Managed only when every step is done. */
export async function advanceOnboarding(
  db: Db,
  tenantId: string,
  impl: OnboardingImplementation,
): Promise<OnboardingAdvance> {
  const flowType = impl.descriptor.flowType;
  const ob = await getOnboarding(db, tenantId, flowType);
  if (ob.status !== 'activating' || !ob.integrationId) return { state: 'noop', detail: ob.status };
  const act = (ob.activation ?? { steps: {}, done: [] }) as Activation;
  act.steps ??= {};
  act.done ??= [];
  const save = (a: Activation) => setOnboarding(db, tenantId, flowType, { activation: a });

  const step = impl.steps.find((s) => !act.done.includes(s.key));
  if (step) {
    const r = await step.run({
      db,
      tenantId,
      integrationId: ob.integrationId,
      confirmation: ob.confirmation as Confirmation,
      record: act.steps[step.key],
      records: act.steps,
      save: async (record) => {
        const steps = { ...act.steps };
        if (record === undefined) delete steps[step.key];
        else steps[step.key] = record;
        act.steps = steps;
        await save(act);
      },
    });
    if (r.state === 'done') {
      await save({ steps: { ...act.steps, [step.key]: r.record }, done: [...act.done, step.key] });
      return { state: 'continue', detail: r.detail };
    }
    if (r.state === 'blocked') {
      await setOnboarding(db, tenantId, flowType, { status: 'blocked', problem: r.problem });
      return { state: 'blocked', detail: r.detail };
    }
    return r;
  }

  // Managed: every prerequisite is a durable fact now.
  const baselineResult = await impl.baselineResult(db, act.steps);
  await db.transaction(async (tx) => {
    await tx
      .update(integrations)
      .set({ lifecycle: 'active', updatedAt: new Date() })
      .where(eq(integrations.id, ob.integrationId!));
    await tx
      .update(onboardings)
      .set({
        status: 'managed',
        activation: { ...act, steps: { ...act.steps, baselineResult } },
        problem: null,
        updatedAt: new Date(),
      })
      .where(and(eq(onboardings.tenantId, tenantId), eq(onboardings.flowType, flowType)));
    await tx.insert(auditLog).values({
      actorRole: 'system',
      action: 'onboarding.managed',
      targetType: 'integration',
      targetId: ob.integrationId!,
      details: { flowType, baselineResult },
    });
  });
  return { state: 'done', detail: 'managed' };
}

/** Onboardings whose activation should be (re)driven (crash safety: the worker tick picks them up). */
export async function onboardingsActivating(db: Db): Promise<{ tenantId: string; flowType: string }[]> {
  return db
    .select({ tenantId: onboardings.tenantId, flowType: onboardings.flowType })
    .from(onboardings)
    .where(inArray(onboardings.status, ['activating']));
}
