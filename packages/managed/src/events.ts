/**
 * Maintenance events (generic; extracted from slice 4). A maintenance event is an incident row whose facts —
 * finding, investigation, correction, validation, accounting — are written one step at a time with their
 * own evidence, plus timeline notes (customer-visible or operator-only). The customer story is DERIVED from
 * these facts (capabilities/product.ts); nothing customer-facing is stored as free text except the notes.
 *
 * Resolution is guarded in @mi/reliability (`resolutionBlockers`): no event with maintenance facts resolves
 * without a finding, a validated and activated correction, complete accounting and passed verification.
 */
import { eq, sql } from 'drizzle-orm';
import type { IncidentKind } from '@mi/contracts';
import { incidentEvents, incidents, type Db } from '@mi/database';
import { openIncident, type IncidentRow } from '@mi/reliability';

export const MAINTENANCE_ACTOR = 'system:maintenance';

export type FactName = 'finding' | 'investigation' | 'correction' | 'validation' | 'accounting';

export async function setFacts(db: Db, id: string, facts: Partial<Record<FactName, unknown>>) {
  await db
    .update(incidents)
    .set({ ...(facts as object), updatedAt: new Date() })
    .where(eq(incidents.id, id));
}

/** First write wins: a fact recorded by an earlier observation is not overwritten. */
export async function setFindingOnce(db: Db, id: string, finding: unknown) {
  await db
    .update(incidents)
    .set({
      finding: sql`coalesce(${incidents.finding}, ${JSON.stringify(finding)}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(eq(incidents.id, id));
}

/** Driver progress, kept under evidence.maintenance (merged). */
export async function setProgress(db: Db, id: string, progress: Record<string, unknown>) {
  await db
    .update(incidents)
    .set({
      evidence: sql`jsonb_set(${incidents.evidence}, '{maintenance}', coalesce(${incidents.evidence}->'maintenance', '{}'::jsonb) || ${JSON.stringify(progress)}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(eq(incidents.id, id));
}

export function progressOf<T extends object>(inc: IncidentRow): Partial<T> {
  return ((inc.evidence as { maintenance?: T }).maintenance ?? {}) as Partial<T>;
}

export async function note(
  db: Db,
  inc: Pick<IncidentRow, 'id' | 'status'>,
  text: string,
  customerVisible: boolean,
  evidence: Record<string, unknown> = {},
  actor = MAINTENANCE_ACTOR,
) {
  await db.insert(incidentEvents).values({
    incidentId: inc.id,
    fromStatus: inc.status,
    toStatus: inc.status,
    actor,
    note: text,
    customerVisible,
    evidence,
  });
}

export async function escalate(db: Db, inc: IncidentRow, reason: string) {
  await setProgress(db, inc.id, { escalated: reason });
  await note(db, inc, `Escalated to an operator: ${reason}`, false);
  return { state: 'escalated' as const, detail: reason };
}

/**
 * Opens a maintenance event (or attaches to the open one of the same kind). The generic lifecycle's
 * transition notes are for operators; the customer gets exactly one plain note, written here.
 */
export async function openMaintenanceEvent(
  db: Db,
  p: {
    tenantId: string;
    integrationId: string;
    kind: IncidentKind;
    severity: 'low' | 'medium' | 'high' | 'critical';
    title: string;
    reason: string;
    customerSummary: string;
    customerNote: string;
    customerAction?: string | null;
    classifyAs: 'investigating' | 'recoverable' | 'requires_action';
    classificationNote: string;
    finding: unknown;
    evidence?: Record<string, unknown>;
  },
): Promise<{ incident: IncidentRow; created: boolean }> {
  const [inc, created] = await openIncident(db, {
    tenantId: p.tenantId,
    integrationId: p.integrationId,
    kind: p.kind,
    severity: p.severity,
    title: p.title,
    reason: p.reason,
    customerSummary: p.customerSummary,
    customerAction: p.customerAction ?? null,
    classifyAs: p.classifyAs,
    classificationNote: p.classificationNote,
    evidence: p.evidence ?? {},
  });
  if (created) {
    await db
      .update(incidentEvents)
      .set({ customerVisible: false })
      .where(eq(incidentEvents.incidentId, inc.id));
    await note(db, inc, p.customerNote, true, { step: 'noticed' });
  }
  await setFindingOnce(db, inc.id, p.finding);
  const [fresh] = await db.select().from(incidents).where(eq(incidents.id, inc.id));
  return { incident: fresh!, created };
}
