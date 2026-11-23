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
