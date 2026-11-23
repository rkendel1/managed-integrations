import type { PgBoss } from 'pg-boss';
import { QUEUES } from '@mi/contracts';

/** Same queue definitions as the worker; creation is idempotent. */
export async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const q of Object.values(QUEUES)) {
    if (!(await boss.getQueue(q)))
      await boss.createQueue(q, {
        retryLimit: q === QUEUES.sync ? 0 : 2,
        retryDelay: 30,
        retryBackoff: true,
        expireInSeconds: 30 * 60,
      });
  }
}
