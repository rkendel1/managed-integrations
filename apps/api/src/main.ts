import { resolve } from 'node:path';
import { PgBoss } from 'pg-boss';
import { createDb, migrate } from '@mi/database';
import { bootstrapReferenceData, loadServiceConfig } from '@mi/integration-shopify-netsuite';
import { registerLedgerlyReferenceData } from '@mi/adopted-ledgerly';
import { registerAdoptedContract } from '@mi/adopted-order-sync';
import { buildApp } from './app.ts';
import { ensureQueues } from './queues.ts';

const config = loadServiceConfig('api'); // fails closed on invalid configuration
if (process.env.MIGRATE_ON_START === 'true') await migrate(config.env.DATABASE_URL);
const dbh = createDb(config.env.DATABASE_URL, { max: 10 });
await bootstrapReferenceData(dbh.db);
await registerLedgerlyReferenceData(dbh.db);
await registerAdoptedContract(dbh.db);
const boss = new PgBoss({ connectionString: config.env.DATABASE_URL, schema: 'pgboss' });
await boss.start();
await ensureQueues(boss);

const app = await buildApp({
  db: dbh.db,
  boss,
  config,
  webDir: resolve(process.env.WEB_DIST_DIR ?? 'apps/web/dist'),
});
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    await app.close();
    await boss.stop({ graceful: true, timeout: 10_000 }).catch(() => undefined);
    await dbh.close();
    process.exit(0);
  });
}
