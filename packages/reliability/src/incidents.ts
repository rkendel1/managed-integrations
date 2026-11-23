import { and, eq, ne, sql } from 'drizzle-orm';
import type { IncidentKind, IncidentStatus } from '@mi/contracts';
import { incidentEvents, incidents, type Db } from '@mi/database';
import { redact } from '@mi/observability';

/**
 * Incident lifecycle (spec §13):
 *   detected → classified → investigating → (recoverable | requires_action) → recovery → verification → resolved
 * `resolved` is reachable only from `verification`: nothing is closed without verification evidence.
 */
export const INCIDENT_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  detected: ['classified'],
  classified: ['investigating', 'recoverable', 'requires_action'],
  investigating: ['recoverable', 'requires_action', 'recovery'],
  recoverable: ['recovery', 'requires_action', 'investigating'],
  requires_action: ['recovery', 'investigating', 'recoverable'],
  recovery: ['verification', 'investigating', 'requires_action', 'recoverable'],
  verification: ['resolved', 'investigating', 'recovery', 'recoverable', 'requires_action'],
  resolved: [],
};

export function canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  return INCIDENT_TRANSITIONS[from].includes(to);
}

export class InvalidIncidentTransition extends Error {}

export type IncidentRow = typeof incidents.$inferSelect;

export interface OpenIncidentInput {
  tenantId: string;
  integrationId: string;
  kind: IncidentKind;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  reason: string;
  errorClass?: string | null;
  affectedScope?: Record<string, unknown>;
  impact?: string;
  customerSummary: string;
  customerAction?: string | null;
  evidence?: Record<string, unknown>;
  implementationVersionId?: string | null;
  /** Classification applied immediately after detection. */
  classifyAs: 'investigating' | 'recoverable' | 'requires_action';
  classificationNote: string;
}

export function dedupeKeyFor(integrationId: string, kind: IncidentKind): string {
  return `${integrationId}:${kind}`;
}

/**
 * Opens an incident unless one with the same dedupe key is already open, in which case the
 * existing incident's evidence and affected scope are refreshed. Returns [incident, created].
 */
export async function openIncident(db: Db, input: OpenIncidentInput): Promise<[IncidentRow, boolean]> {
  const dedupeKey = dedupeKeyFor(input.integrationId, input.kind);
  const existing = await findOpenIncident(db, input.integrationId, input.kind);
  if (existing) {
    const [updated] = await db
      .update(incidents)
      .set({
        // Merged, not replaced: keys recorded by other writers (e.g. the backlog's affected orders) survive.
        affectedScope: sql`coalesce(${incidents.affectedScope}, '{}'::jsonb) || ${JSON.stringify(redact(input.affectedScope ?? {}) ?? {})}::jsonb`,
        evidence: { ...(existing.evidence as object), ...((redact(input.evidence ?? {}) ?? {}) as object) },
        updatedAt: new Date(),
      })
      .where(eq(incidents.id, existing.id))
      .returning();
    return [updated!, false];
  }
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(incidents)
      .values({
        tenantId: input.tenantId,
        integrationId: input.integrationId,
        kind: input.kind,
        status: 'detected',
        severity: input.severity,
        title: input.title,
        reason: String(redact(input.reason)),
        errorClass: input.errorClass ?? null,
        dedupeKey,
        affectedScope: (redact(input.affectedScope ?? {}) ?? {}) as object,
        impact: input.impact ?? null,
        customerSummary: input.customerSummary,
        customerAction: input.customerAction ?? null,
        evidence: (redact(input.evidence ?? {}) ?? {}) as object,
        implementationVersionId: input.implementationVersionId ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted[0]) {
      // Lost a race with a concurrent detector; return the winner.
      const [winner] = await tx
        .select()
        .from(incidents)
        .where(and(eq(incidents.dedupeKey, dedupeKey), ne(incidents.status, 'resolved')));
      return [winner!, false] as [IncidentRow, boolean];
    }
    const inc = inserted[0];
    await tx.insert(incidentEvents).values([
      { incidentId: inc.id, fromStatus: null, toStatus: 'detected', actor: 'system', note: input.reason },
      {
        incidentId: inc.id,
        fromStatus: 'detected',
        toStatus: 'classified',
        actor: 'system',
        note: input.classificationNote,
      },
    ]);
    await tx.update(incidents).set({ status: 'classified' }).where(eq(incidents.id, inc.id));
    await tx.insert(incidentEvents).values({
      incidentId: inc.id,
      fromStatus: 'classified',
      toStatus: input.classifyAs,
      actor: 'system',
      note:
        input.classifyAs === 'requires_action'
          ? (input.customerAction ?? 'Action required')
          : input.classificationNote,
    });
    const [final] = await tx
      .update(incidents)
      .set({ status: input.classifyAs, updatedAt: new Date() })
      .where(eq(incidents.id, inc.id))
      .returning();
    return [final!, true] as [IncidentRow, boolean];
  });
}

export async function findOpenIncident(
  db: Db,
  integrationId: string,
  kind: IncidentKind,
): Promise<IncidentRow | undefined> {
  const [row] = await db
    .select()
    .from(incidents)
    .where(and(eq(incidents.dedupeKey, dedupeKeyFor(integrationId, kind)), ne(incidents.status, 'resolved')));
  return row;
}

/** Durable, validated transition with a timeline event. Optimistic on the current status. */
export async function transitionIncident(
  db: Db,
  incidentId: string,
  to: IncidentStatus,
  p: {
    actor: string;
    note: string;
    evidence?: Record<string, unknown>;
    customerVisible?: boolean;
    resolution?: string;
    verification?: Record<string, unknown>;
  },
): Promise<IncidentRow> {
  return db.transaction(async (tx) => {
    const [cur] = await tx.select().from(incidents).where(eq(incidents.id, incidentId)).for('update');
    if (!cur) throw new Error(`Incident ${incidentId} not found`);
    const from = cur.status as IncidentStatus;
    if (from === to) return cur;
    if (!canTransition(from, to))
      throw new InvalidIncidentTransition(`Incident ${incidentId}: ${from} → ${to} is not permitted`);
    if (to === 'resolved' && !p.verification)
      throw new InvalidIncidentTransition('Resolving an incident requires verification evidence');
    const now = new Date();
    const [updated] = await tx
      .update(incidents)
      .set({
        status: to,
        updatedAt: now,
        ...(to === 'resolved'
          ? { resolvedAt: now, resolution: p.resolution ?? p.note, verification: p.verification as object }
          : {}),
      })
      .where(eq(incidents.id, incidentId))
      .returning();
    await tx.insert(incidentEvents).values({
      incidentId,
      fromStatus: from,
      toStatus: to,
      actor: p.actor,
      note: String(redact(p.note)),
      customerVisible: p.customerVisible ?? true,
      evidence: (redact(p.evidence ?? {}) ?? {}) as object,
    });
    return updated!;
  });
}

/** Appends a timeline note without changing status (e.g. "maintenance candidate submitted"). */
export async function noteIncident(
  db: Db,
  incidentId: string,
  note: string,
  opts: { actor?: string; customerVisible?: boolean; evidence?: Record<string, unknown> } = {},
) {
  const [cur] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!cur) return;
  await db.insert(incidentEvents).values({
    incidentId,
    fromStatus: cur.status,
    toStatus: cur.status,
    actor: opts.actor ?? 'system',
    note: String(redact(note)),
    customerVisible: opts.customerVisible ?? false,
    evidence: (redact(opts.evidence ?? {}) ?? {}) as object,
  });
}

/** Walks an incident through the remaining lifecycle states to `resolved` with verification. */
export async function resolveWithVerification(
  db: Db,
  incidentId: string,
  p: { actor: string; resolution: string; verification: Record<string, unknown> },
): Promise<IncidentRow> {
  const [cur] = await db.select().from(incidents).where(eq(incidents.id, incidentId));
  if (!cur) throw new Error('incident not found');
  const path: IncidentStatus[] = [];
  const s = cur.status as IncidentStatus;
  if (s === 'resolved') return cur;
  if (s === 'classified' || s === 'investigating' || s === 'recoverable' || s === 'requires_action')
    path.push('recovery', 'verification');
  else if (s === 'recovery') path.push('verification');
  else if (s === 'detected') path.push('classified', 'recoverable', 'recovery', 'verification');
  for (const step of path) {
    await transitionIncident(db, incidentId, step, {
      actor: p.actor,
      note: step === 'recovery' ? 'Recovery in progress' : 'Verifying recovery against durable evidence',
    });
  }
  return transitionIncident(db, incidentId, 'resolved', {
    actor: p.actor,
    note: p.resolution,
    resolution: p.resolution,
    verification: p.verification,
  });
}
