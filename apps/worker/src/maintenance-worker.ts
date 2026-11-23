/**
 * Maintenance worker: runs the maintenance agent and independent validation. Configured WITHOUT
 * credential encryption keys (enforced by loadServiceConfig('maintenance')), so it cannot
 * decrypt any customer connection. It never deploys: approval and release happen elsewhere.
 */
import type { PgBoss } from 'pg-boss';
import { MaintenanceJobSchema, QUEUES, ValidationJobSchema } from '@mi/contracts';
import type { Db } from '@mi/database';
import { DEFAULT_SANDBOX, plannerFromEnv, runMaintenance, validateCandidate, type SandboxConfig } from '@mi/maintenance';
import { describeError, withCorrelation, type Logger } from '@mi/observability';
import { ensureQueues } from './runtime-worker.ts';

export interface MaintenanceWorkerDeps {
  db: Db;
  boss: PgBoss;
  logger: Logger;
  repoDir: string;
  workDir: string;
  artifactDir: string;
  sandbox?: SandboxConfig;
}

export function createMaintenanceWorker(d: MaintenanceWorkerDeps) {
  const sandbox = d.sandbox ?? DEFAULT_SANDBOX;
  const handlers = {
    async maintenance(raw: unknown) {
      const job = MaintenanceJobSchema.parse(raw);
      return runMaintenance(
        {
          db: d.db,
          repoDir: d.repoDir,
          workDir: d.workDir,
          sandbox,
          planner: plannerFromEnv(),
          logger: d.logger,
          onCandidate: async (candidateId) => {
            await d.boss.send(QUEUES.validation, { repairCandidateId: candidateId });
          },
        },
        job.maintenanceRunId,
      );
    },
    async validation(raw: unknown) {
      const job = ValidationJobSchema.parse(raw);
      return validateCandidate({ db: d.db, repoDir: d.repoDir, workDir: d.workDir, artifactDir: d.artifactDir, sandbox, logger: d.logger }, job.repairCandidateId);
    },
  };
  async function start() {
    await ensureQueues(d.boss);
    for (const [queue, fn] of [
      [QUEUES.maintenance, handlers.maintenance],
      [QUEUES.validation, handlers.validation],
    ] as const) {
      await d.boss.work(queue, { batchSize: 1 }, async (jobs) => {
        for (const job of jobs) {
          await withCorrelation({ correlationId: job.id }, async () => {
            try {
              await fn(job.data);
            } catch (err) {
              d.logger.error({ queue, err: describeError(err) }, 'maintenance job failed');
              throw err;
            }
          });
        }
      });
    }
  }
  return { start, handlers };
}
