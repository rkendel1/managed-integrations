import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    // DB-backed tests share one test database; run files sequentially for isolation.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL_TEST:
        process.env.DATABASE_URL_TEST ??
        'postgres://mi:mi_dev_password@localhost:5432/managed_integrations_test',
    },
  },
});
