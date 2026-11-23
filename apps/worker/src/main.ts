import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { PgBoss } from 'pg-boss';
import { createDb, migrate } from '@mi/database';
import { loadServiceConfig } from '@mi/integration-shopify-netsuite';
import { createLogger } from '@mi/observability';
import { createMaintenanceWorker } from './maintenance-worker.ts';
import { createRuntimeWorker } from './runtime-worker.ts';

const role = process.env.WORKER_ROLE === 'maintenance' ? 'maintenance' : 'worker';
const logger = createLogger(`mi-${role}`);
const config = loadServiceConfig(role); // fails closed on invalid configuration
if (process.env.MIGRATE_ON_START === 'true') await migrate(config.env.DATABASE_URL);

const dbh = createDb(config.env.DATABASE_URL, { max: 10 });
const boss = new PgBoss({ connectionString: config.env.DATABASE_URL, schema: 'pgboss' });
boss.on('error', (err) => logger.error({ err: err.message }, 'pg-boss error'));
await boss.start();

const workerId = `${role}:${hostname()}:${process.pid}`;
if (role === 'maintenance') {
  await createMaintenanceWorker({
    db: dbh.db,
    boss,
    logger,
    repoDir: resolve(process.env.MAINTENANCE_REPO_DIR ?? '.'),
    workDir: resolve(process.env.MAINTENANCE_WORK_DIR ?? '.maintenance'),
    artifactDir: resolve(config.env.ARTIFACT_DIR),
  }).start();
} else {
  await createRuntimeWorker({ db: dbh.db, boss, config, logger, workerId }).start();
}
logger.info({ workerId }, 'worker started');

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down');
  await boss.stop({ graceful: true, timeout: 20_000 }).catch(() => undefined);
  await dbh.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
