import { z } from 'zod';

/** Durable job queues (pg-boss). Job payloads carry ids only — never secrets or customer data. */
export const QUEUES = {
  reliabilityTick: 'reliability.tick',
  sync: 'sync.run',
  reconcile: 'reconcile.run',
  backlog: 'backlog.assess',
  maintenance: 'maintenance.run',
  validation: 'validation.run',
  release: 'release.run',
  adoptedExecute: 'adopted.execute',
  adoptedReconcile: 'adopted.reconcile',
  adoptedRecover: 'adopted.recover',
  /** Drives one maintenance event of an adopted integration (slice 4). */
  adoptedMaintenance: 'adopted.maintenance',
  /** Validates one adaptation (adapter or patch) against stored and affected orders (slice 5). */
  adoptedAdaptationValidate: 'adopted.adaptation.validate',
} as const;

export const SyncJobSchema = z.object({
  integrationId: z.string().uuid(),
  trigger: z.enum(['schedule', 'manual', 'recovery', 'release', 'resume']),
  mode: z.enum(['auto', 'redelivery', 'canary']).default('auto'),
  sourceLegacyIds: z.array(z.string().regex(/^\d+$/)).max(1000).optional(),
});
export const ReconcileJobSchema = z.object({
  integrationId: z.string().uuid(),
  incidentId: z.string().uuid().nullable().default(null),
  trigger: z.enum(['schedule', 'manual', 'incident', 'release']),
});
export const BacklogJobSchema = z.object({ integrationId: z.string().uuid(), incidentId: z.string().uuid() });
export const MaintenanceJobSchema = z.object({ maintenanceRunId: z.string().uuid() });
export const ValidationJobSchema = z.object({ repairCandidateId: z.string().uuid() });
export const ReleaseJobSchema = z.object({ releaseId: z.string().uuid() });
export const AdoptedExecuteJobSchema = z.object({
  deliveryId: z.string().uuid(),
  trigger: z.object({
    kind: z.enum([
      'webhook',
      'automatic_retry',
      'manual_retry',
      'reconciliation_recovery',
      'maintenance_recovery',
    ]),
    maintenanceEventId: z.string().uuid().optional(),
    principalId: z.string().optional(),
    appportRequestId: z.string().optional(),
    reason: z.string().max(500).optional(),
  }),
});
export const AdoptedReconcileJobSchema = z.object({ runId: z.string().uuid() });
export const AdoptedRecoverJobSchema = z.object({ itemId: z.string().uuid() });
export const AdoptedMaintenanceJobSchema = z.object({ incidentId: z.string().uuid() });
export const AdoptedAdaptationValidateJobSchema = z.object({ adaptationId: z.string().uuid() });
