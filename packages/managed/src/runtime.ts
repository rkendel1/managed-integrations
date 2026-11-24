/**
 * The integration runtime contract (slice 6): what an integration implements so the shared queues,
 * worker, onboarding, adaptation, monitoring and operator tooling can manage it. Every hook is optional
 * because integrations differ — a missing hook is an explicit "not supported", visible in the descriptor —
 * and none of them is a generic implementation: each is the integration's own behaviour.
 */
import { eq } from 'drizzle-orm';
import {
  deliveries,
  incidents,
  integrations,
  reconciliationItems,
  reconciliationRuns,
  adaptations,
  type Db,
} from '@mi/database';
import type { AdaptationRow } from './adaptations.ts';
import type { IntegrationDescriptor } from './descriptor.ts';
import type { Probe } from './monitoring.ts';
import type { OnboardingImplementation } from './onboarding.ts';

export interface ExecutionTrigger {
  kind: 'webhook' | 'automatic_retry' | 'manual_retry' | 'reconciliation_recovery' | 'maintenance_recovery';
  maintenanceEventId?: string;
  principalId?: string;
  appportRequestId?: string;
  reason?: string;
}

/** Shared queues, provided by the worker (pg-boss), so integrations never talk to the queue directly. */
export interface WorkServices {
  enqueueExecution(deliveryId: string, trigger: ExecutionTrigger, afterSeconds?: number): Promise<void>;
  enqueueReconciliation(runId: string): Promise<void>;
  enqueueRecovery(itemId: string): Promise<void>;
  enqueueMaintenance(incidentId: string, afterSeconds?: number): Promise<void>;
}

/** "What exact code is running, what does it depend on, and what changed it" — one shape for every integration. */
export interface RunningCode {
  adopted: { repository: string; commit: string; license: string; package: string } | null;
  pinnedFiles: { file: string; expected: string; actual: string; matches: boolean }[];
  running: {
    id: string;
    patches: { id: string; file: string; resultSha256: string }[];
    files: Record<string, string>;
  } | null;
  problem: string | null;
  contracts: {
    path: string;
    label: string;
    expected: string;
    effect: string;
    reads: { file: string; line: number; code: string; matchesPinnedCommit: boolean }[];
  }[];
  adaptations: AdaptationRow[];
  catalog: { id: string; title: string; file: string }[];
}

export interface AdaptationOperations {
  /** Proposes a REVIEWED patch from the integration's catalog (adapters are proposed by maintenance). */
  propose(p: {
    integrationId: string;
    patchId: string;
    actor: string;
    reason: string;
    maintenanceEventId?: string | null;
  }): Promise<AdaptationRow>;
  validate(adaptationId: string): Promise<AdaptationRow>;
  activate(
    adaptationId: string,
    actor: string,
    note: string,
    opts?: { acceptLimitations?: boolean },
  ): Promise<AdaptationRow>;
  rollback(adaptationId: string, actor: string, reason: string): Promise<AdaptationRow>;
  reject(adaptationId: string, actor: string, reason: string): Promise<AdaptationRow>;
}

export type RecoveryDecision =
  | { sourceId: string; accepted: true; itemId: string; deliveryId: string | null; mode: 'new' | 'retry' }
  | { sourceId: string; accepted: false; reason: string };

/** Customer/operator-requested reconciliation and recovery (the AppPort reconciliation capabilities). */
export interface ReconciliationOperations {
  start(p: {
    integrationId: string;
    requestedBy: string;
  }): Promise<{ runId: string; deduplicated: boolean; windowFrom: string; windowTo: string }>;
  /** Records the durable recovery intent per source transaction; the caller queues the accepted items. */
  requestRecovery(p: {
    runId: string;
    sourceIds: string[];
    principalId: string;
    requestId: string;
    reason: string;
  }): Promise<RecoveryDecision[]>;
}

export interface IntegrationRuntime {
  reconciliation?: ReconciliationOperations;
  descriptor: IntegrationDescriptor;
  onboarding?: OnboardingImplementation;
  /** Runs one delivery through the integration's executor (queue: adopted.execute). */
  execute?(deliveryId: string, trigger: ExecutionTrigger): Promise<unknown>;
  /** Scans the source for a reconciliation run (queue: adopted.reconcile). */
  scan?(runId: string): Promise<unknown>;
  /** Recovers one reconciliation item (queue: adopted.recover). */
  recover?(itemId: string): Promise<unknown>;
  /** Advances one maintenance event by one step (queue: adopted.maintenance). */
  maintain?(
    incidentId: string,
  ): Promise<{ state: 'continue' | 'wait' | 'escalated' | 'resolved' | 'noop'; detail: string }>;
  adaptations?: AdaptationOperations;
  inspect?(integrationId: string): Promise<RunningCode>;
  probe?(integration: typeof integrations.$inferSelect): Promise<Probe>;
  /** Periodic integration-specific work on the shared tick (orphans, scheduled reconciliation, …). */
  sweep?(): Promise<void>;
}

/** Resolves the runtime that owns a piece of durable work, by its integration's flow type. */
export class IntegrationRegistry {
  private readonly byFlow = new Map<string, IntegrationRuntime>();
  constructor(
    private readonly db: Db,
    runtimes: IntegrationRuntime[],
  ) {
    for (const r of runtimes) this.byFlow.set(r.descriptor.flowType, r);
  }
  all(): IntegrationRuntime[] {
    return [...this.byFlow.values()];
  }
  get(flowType: string): IntegrationRuntime | undefined {
    return this.byFlow.get(flowType);
  }
  onboardable() {
    return this.all().flatMap((r) => (r.onboarding ? [r.onboarding] : []));
  }
  async forIntegration(integrationId: string) {
    const [i] = await this.db
      .select({ f: integrations.flowType })
      .from(integrations)
      .where(eq(integrations.id, integrationId));
    return i ? this.get(i.f) : undefined;
  }
  async forDelivery(id: string) {
    const [d] = await this.db
      .select({ i: deliveries.integrationId })
      .from(deliveries)
      .where(eq(deliveries.id, id));
    return d ? this.forIntegration(d.i) : undefined;
  }
  async forRun(id: string) {
    const [r] = await this.db
      .select({ i: reconciliationRuns.integrationId })
      .from(reconciliationRuns)
      .where(eq(reconciliationRuns.id, id));
    return r ? this.forIntegration(r.i) : undefined;
  }
  async forItem(id: string) {
    const [r] = await this.db
      .select({ i: reconciliationItems.integrationId })
      .from(reconciliationItems)
      .where(eq(reconciliationItems.id, id));
    return r ? this.forIntegration(r.i) : undefined;
  }
  async forIncident(id: string) {
    const [r] = await this.db
      .select({ i: incidents.integrationId })
      .from(incidents)
      .where(eq(incidents.id, id));
    return r?.i ? this.forIntegration(r.i) : undefined;
  }
  async forAdaptation(id: string) {
    const [r] = await this.db
      .select({ i: adaptations.integrationId })
      .from(adaptations)
      .where(eq(adaptations.id, id));
    return r ? this.forIntegration(r.i) : undefined;
  }
}
