/**
 * Customer product capabilities (slice 4). All observations — there is deliberately no capability that
 * writes maintenance event state: the lifecycle is advanced only by the backend, with evidence checks
 * enforced in `transitionIncident`.
 *
 *  - portfolio.list@1            the integrations we maintain for a tenant, each with an evidence-based status
 *  - portfolio.integration@1     one integration: what it does, what we are responsible for, last verified
 *                                outcome, maintenance history, open items, customer action
 *  - maintenance.events.get@1    one maintenance event as the customer sees it (operators get the same view)
 *  - maintenance.events.evidence@1  operator only (`integrations.read:any`): the facts behind the story
 */
import { defineCapability, type CapabilityDefinition } from '@appport/core';
import { errors } from '@appport/protocol';
import { s } from '@appport/schema';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { adaptations, incidentEvents, incidents, integrations, reconciliationRuns, tenants, type Db } from '@mi/database';
import { correctionsOf, decide, AdaptationError } from '@mi/managed';
import { descriptorFor } from '@mi/integrations';
import { AppPortPermissions, tenantIdOf } from '../identity.ts';
import {
  assessStatus,
  checkSentence,
  presentEvent,
  responsibilitiesFor,
  wordsOf,
  STATUS_CODES,
  STATUS_DEFINITIONS,
  type CustomerEvent,
  type PendingDecision,
  type StatusAssessment,
} from '../product.ts';

const UUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
/** The integration's own words and process, from its descriptor (the registry of managed integrations). */
const wordsFor = (flowType: string) => wordsOf(descriptorFor(flowType));
const processOf = (flowType: string) =>
  descriptorFor(flowType)?.process ?? 'Shopify orders become NetSuite sales orders';
async function wordsForIntegration(db: Db, integrationId: string) {
  const [i] = await db
    .select({ f: integrations.flowType })
    .from(integrations)
    .where(eq(integrations.id, integrationId));
  return wordsFor(i?.f ?? '');
}

const statusSchema = s.object({
  code: s.enum([...STATUS_CODES]),
  label: s.string(),
  definition: s.string(),
  reason: s.string(),
  basis: s.object({ incidentId: s.optional(s.string()), reconciliationRunId: s.optional(s.string()) }),
});
const lastVerifiedSchema = s.nullable(
  s.object({ at: s.string(), ordersChecked: s.integer(), statement: s.string() }),
);
const eventSummarySchema = s.object({
  id: s.string(),
  category: s.string(),
  state: s.enum(['in_progress', 'completed', 'needs_you']),
  headline: s.string(),
  detectedAt: s.string(),
  resolvedAt: s.nullable(s.string()),
  zeroLoss: s.boolean('Zero transactions lost, proven by persisted accounting'),
});
const eventSchema = s.object({
  id: s.string(),
  integrationId: s.string(),
  category: s.string(),
  state: s.enum(['in_progress', 'completed', 'needs_you']),
  headline: s.string(),
  summary: s.string(),
  detectedAt: s.string(),
  resolvedAt: s.nullable(s.string()),
  facts: s.array(s.object({ label: s.string(), value: s.string() })),
  accounting: s.nullable(
    s.object({
      window: s.object({ from: s.string(), to: s.string() }),
      ordersInWindow: s.integer(),
      deliveredBeforeChange: s.integer(),
      delayed: s.integer(),
      failedDuringDisruption: s.integer(),
      foundByChecking: s.integer(),
      recovered: s.integer(),
      verified: s.integer(),
      excluded: s.integer(),
      unresolved: s.integer(),
      duplicates: s.integer(),
    }),
  ),
  claim: s.object({
    zeroLoss: s.boolean('proven zero loss'),
    statement: s.nullable(s.string()),
    basis: s.string(),
  }),
  customerAction: s.object({ required: s.boolean('customer action required'), text: s.nullable(s.string()) }),
  decision: s.nullable(
    s.object({
      id: s.string(),
      question: s.string(),
      options: s.array(s.object({ id: s.string(), label: s.string(), detail: s.optional(s.string()) })),
    }),
  ),
  timeline: s.array(
    s.object({
      at: s.string(),
      step: s.string(),
      title: s.string(),
      text: s.string(),
      details: s.array(s.object({ label: s.string(), value: s.string() })),
    }),
  ),
});

interface IntegrationAssessment {
  id: string;
  name: string;
  process: string;
  status: StatusAssessment;
  lastVerified: { at: string; ordersChecked: number; statement: string } | null;
  openIssues: number;
  customerActions: string[];
}

async function assess(db: Db, integ: typeof integrations.$inferSelect): Promise<IntegrationAssessment> {
  const open = await db
    .select()
    .from(incidents)
    .where(and(eq(incidents.integrationId, integ.id), ne(incidents.status, 'resolved')))
    .orderBy(desc(incidents.detectedAt));
  const [lastResolved] = await db
    .select()
    .from(incidents)
    .where(and(eq(incidents.integrationId, integ.id), eq(incidents.status, 'resolved')))
    .orderBy(desc(incidents.resolvedAt))
    .limit(1);
  const [lastCheck] = await db
    .select()
    .from(reconciliationRuns)
    .where(and(eq(reconciliationRuns.integrationId, integ.id), ne(reconciliationRuns.status, 'running')))
    .orderBy(desc(reconciliationRuns.finishedAt))
    .limit(1);
  const [lastConsistent] = await db
    .select()
    .from(reconciliationRuns)
    .where(and(eq(reconciliationRuns.integrationId, integ.id), eq(reconciliationRuns.outcome, 'consistent')))
    .orderBy(desc(reconciliationRuns.finishedAt))
    .limit(1);
  return {
    id: integ.id,
    name: integ.displayName || descriptorFor(integ.flowType)?.name || 'Shopify → NetSuite',
    process: processOf(integ.flowType),
    status: assessStatus(open, lastResolved, lastCheck, new Date(), wordsFor(integ.flowType)),
    lastVerified: lastConsistent?.finishedAt
      ? {
          at: lastConsistent.finishedAt.toISOString(),
          ordersChecked: lastConsistent.expectedCount ?? lastConsistent.sourceCount ?? 0,
          statement: checkSentence(lastConsistent, wordsFor(integ.flowType)),
        }
      : null,
    openIssues: open.length,
    customerActions: open
      .filter((i) => i.status === 'requires_action')
      .map((i) => i.customerAction ?? i.title),
  };
}

const tenantOf = (input: { tenantId?: string }, principal: Parameters<typeof tenantIdOf>[0]) => {
  const t = tenantIdOf(principal) ?? input.tenantId;
  if (!t) throw errors.forbidden('A tenantId is required for a principal without a tenant');
  return t;
};

export function createPortfolioListCapability(
  db: Db,
): CapabilityDefinition<
  { tenantId?: string },
  { tenant: { id: string; name: string }; statusDefinitions: unknown; integrations: IntegrationAssessment[] }
> {
  return defineCapability({
    name: 'portfolio.list',
    version: 1,
    description:
      'The integrations Managed Integrations maintains for the tenant, each with a customer status derived from evidence (with the rule that defines it), the last verified outcome and any decision needed from the customer.',
    effect: 'observation',
    authorization: [AppPortPermissions.read],
    input: s.object({ tenantId: s.optional(s.string({ pattern: UUID })) }),
    output: s.object({
      tenant: s.object({ id: s.string(), name: s.string() }),
      statusDefinitions: s.unknown(),
      integrations: s.array(
        s.object({
          id: s.string(),
          name: s.string(),
          process: s.string(),
          status: statusSchema,
          lastVerified: lastVerifiedSchema,
          openIssues: s.integer(),
          customerActions: s.array(s.string()),
        }),
      ),
    }),
    async handler(input, context) {
      const tenantId = tenantOf(input, context.principal);
      const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
      if (!tenant) throw errors.notFound('Tenant not found');
      const rows = await db
        .select()
        .from(integrations)
        .where(eq(integrations.tenantId, tenantId))
        .orderBy(integrations.createdAt);
      return {
        tenant: { id: tenant.id, name: tenant.name },
        statusDefinitions: STATUS_DEFINITIONS,
        integrations: await Promise.all(rows.map((r) => assess(db, r))),
      };
    },
  });
}

export function createPortfolioIntegrationCapability(
  db: Db,
  reconcileIntervalMinutes: number | null,
): CapabilityDefinition<
  { integrationId: string },
  IntegrationAssessment & { responsibilities: string[]; maintenance: unknown[] }
> {
  return defineCapability({
    name: 'portfolio.integration',
    version: 1,
    description:
      'One maintained integration: the business process it supports, what Managed Integrations is responsible for, its status and evidence, the last verified outcome, and its maintenance history.',
    effect: 'observation',
    authorization: [AppPortPermissions.read],
    input: s.object({ integrationId: s.string({ pattern: UUID }) }),
    output: s.object({
      id: s.string(),
      name: s.string(),
      process: s.string(),
      status: statusSchema,
      lastVerified: lastVerifiedSchema,
      openIssues: s.integer(),
      customerActions: s.array(s.string()),
      responsibilities: s.array(s.string()),
      maintenance: s.array(eventSummarySchema),
    }),
    async handler(input) {
      const [integ] = await db.select().from(integrations).where(eq(integrations.id, input.integrationId));
      if (!integ) throw errors.notFound('Integration not found');
      const rows = await db
        .select()
        .from(incidents)
        .where(eq(incidents.integrationId, integ.id))
        .orderBy(desc(incidents.detectedAt))
        .limit(50);
      const maintenance = rows.map((r) => {
        const e = presentEvent(r, [], wordsFor(integ.flowType));
        return {
          id: e.id,
          category: e.category,
          state: e.state,
          headline: e.headline,
          detectedAt: e.detectedAt,
          resolvedAt: e.resolvedAt,
          zeroLoss: e.claim.zeroLoss,
        };
      });
      return {
        ...(await assess(db, integ)),
        responsibilities: responsibilitiesFor(
          integ.flowType,
          reconcileIntervalMinutes,
          descriptorFor(integ.flowType),
        ),
        maintenance,
      };
    },
  });
}

async function loadEvent(db: Db, eventId: string) {
  const [inc] = await db.select().from(incidents).where(eq(incidents.id, eventId));
  if (!inc?.integrationId) throw errors.notFound('Maintenance event not found');
  const events = await db.select().from(incidentEvents).where(eq(incidentEvents.incidentId, inc.id));
  return { inc, events, decision: await pendingCustomerDecision(db, inc.id) };
}

/** The customer's open question for an event, if any (slice 7). */
async function pendingCustomerDecision(db: Db, eventId: string): Promise<PendingDecision | null> {
  const rows = await db
    .select()
    .from(adaptations)
    .where(and(eq(adaptations.maintenanceEventId, eventId), eq(adaptations.kind, 'decision'), eq(adaptations.status, 'proposed')));
  const d = rows.find((r) => (r.spec as { authority?: string }).authority === 'customer');
  if (!d) return null;
  const spec = d.spec as { question: string; options: PendingDecision['options'] };
  return { id: d.id, question: spec.question, options: spec.options };
}

export function createMaintenanceEventGetCapability(
  db: Db,
): CapabilityDefinition<{ eventId: string }, CustomerEvent> {
  return defineCapability({
    name: 'maintenance.events.get',
    version: 1,
    description:
      'One maintenance event as the customer sees it: what changed, what we did, the transactions affected and recovered, the verified outcome and whether anything is needed from the customer. Every statement is derived from persisted evidence; a zero-loss statement appears only when the accounting proves it.',
    effect: 'observation',
    authorization: [AppPortPermissions.read],
    input: s.object({ eventId: s.string({ pattern: UUID }) }),
    output: eventSchema,
    async handler(input) {
      const { inc, events, decision } = await loadEvent(db, input.eventId);
      return presentEvent(inc, events, await wordsForIntegration(db, inc.integrationId!), decision);
    },
  });
}

export function createMaintenanceEvidenceCapability(
  db: Db,
): CapabilityDefinition<{ eventId: string }, Record<string, unknown>> {
  return defineCapability({
    name: 'maintenance.events.evidence',
    version: 1,
    description:
      'Operators only: the evidence behind a maintenance event — detection finding, investigation (upstream code path, dry run), correction and its derivation, validation checks, transaction accounting per order, verification, reconciliation runs and the full timeline.',
    effect: 'observation',
    authorization: [AppPortPermissions.readAny],
    input: s.object({ eventId: s.string({ pattern: UUID }) }),
    output: s.object({
      event: eventSchema,
      boundary: s.nullable(s.string()),
      provider: s.nullable(s.string()),
      impactAssessment: s.unknown(),
      corrections: s.unknown(),
      kind: s.string(),
      status: s.string(),
      finding: s.unknown(),
      investigation: s.unknown(),
      correction: s.unknown(),
      validation: s.unknown(),
      accounting: s.unknown(),
      verification: s.unknown(),
      progress: s.unknown(),
      reconciliationRuns: s.unknown(),
      timeline: s.unknown(),
    }),
    async handler(input) {
      const { inc, events, decision } = await loadEvent(db, input.eventId);
      const progress =
        (inc.evidence as { maintenance?: { reconcileRunId?: string; verifyRunId?: string } }).maintenance ??
        null;
      const runIds = [progress?.reconcileRunId, progress?.verifyRunId].filter((x): x is string => !!x);
      const runs = runIds.length
        ? await db.select().from(reconciliationRuns).where(inArray(reconciliationRuns.id, runIds))
        : [];
      return {
        event: presentEvent(inc, events, await wordsForIntegration(db, inc.integrationId!), decision),
        boundary: inc.boundary,
        provider: inc.provider ?? null,
        impactAssessment: inc.impactAssessment,
        corrections: (await correctionsOf(db, inc.id)).map((c) => ({
          id: c.id,
          kind: c.kind,
          boundary: c.boundary,
          provider: c.provider ?? null,
          status: c.status,
          rationale: c.rationale,
          spec: c.spec,
          impact: c.impact,
          validation: c.validation,
          history: c.history,
        })),
        kind: inc.kind,
        status: inc.status,
        finding: inc.finding,
        investigation: inc.investigation,
        correction: inc.correction,
        validation: inc.validation,
        accounting: inc.accounting,
        verification: inc.verification,
        progress,
        reconciliationRuns: runs.map((r) => ({
          id: r.id,
          role: r.id === progress?.reconcileRunId ? 'recovery' : 'verification',
          status: r.status,
          outcome: r.outcome,
          windowFrom: r.windowFrom.toISOString(),
          windowTo: r.windowTo.toISOString(),
          sourceCount: r.sourceCount,
          matchedCount: r.matchedCount,
        })),
        timeline: events
          .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())
          .map((e) => ({
            at: e.createdAt.toISOString(),
            from: e.fromStatus,
            to: e.toStatus,
            actor: e.actor,
            note: e.note,
            customerVisible: e.customerVisible,
          })),
      };
    },
  });
}

export type EnqueueMaintenance = (incidentId: string) => Promise<void>;

/**
 * maintenance.decide@1 (slice 7): the answer to a question only a person may answer — e.g. which QuickBooks
 * account replaces one that was made inactive, or which NetSuite subsidiary orders belong to. Customers answer
 * customer questions for their own events; operators answer operator questions. The choice must be one of
 * the evidence-backed options offered; maintenance continues from it (the correction it implies is still
 * validated before anything is switched on).
 */
export function createMaintenanceDecideCapability(
  db: Db,
  enqueue: EnqueueMaintenance | undefined,
): CapabilityDefinition<{ eventId: string; decisionId: string; optionId: string }, { decisionId: string; status: string }> {
  return defineCapability({
    name: 'maintenance.decide',
    version: 1,
    description:
      'Answers a decision a maintenance event is waiting for, choosing one of the offered options. Customers decide business questions for their own integrations; operators decide operator questions.',
    effect: 'consequential',
    authorization: [AppPortPermissions.operate],
    input: s.object({
      eventId: s.string({ pattern: UUID }),
      decisionId: s.string({ pattern: UUID }),
      optionId: s.string({ minLength: 1, maxLength: 200 }),
    }),
    output: s.object({ decisionId: s.string(), status: s.string() }),
    async handler(input, context) {
      const [row] = await db.select().from(adaptations).where(eq(adaptations.id, input.decisionId));
      if (!row || row.maintenanceEventId !== input.eventId) throw errors.notFound('Decision not found');
      const tenantId = tenantIdOf(context.principal);
      try {
        const r = await decide(db, row.id, {
          optionId: input.optionId,
          actor: context.principal?.id ?? 'unknown',
          role: tenantId ? 'customer' : 'operator',
          tenantId,
        });
        if (enqueue) await enqueue(input.eventId);
        return { decisionId: r.id, status: r.status };
      } catch (err) {
        if (err instanceof AdaptationError)
          throw err.code === 'NOT_FOUND' ? errors.notFound(err.message) : err.code === 'CONFLICT' ? errors.forbidden(err.message) : errors.invalidInput(err.message);
        throw err;
      }
    },
  });
}
