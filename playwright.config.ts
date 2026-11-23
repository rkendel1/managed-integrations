import { defineConfig } from '@playwright/test';

/** Browser tests against the RUNNING stack (make up). Override with E2E_BASE_URL. */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000', screenshot: 'only-on-failure', trace: 'off' },
  reporter: [['list']],
});
