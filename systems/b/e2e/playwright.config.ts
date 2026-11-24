import { defineConfig } from "@playwright/test";

/** Browser journeys against a running System B (`feltkit dev` on 3100 after scripts/reset.sh). */
export default defineConfig({
  testDir: ".",
  timeout: 90_000,
  retries: 0,
  workers: 1,
  use: { baseURL: process.env.E2E_B_URL ?? "http://127.0.0.1:3100", screenshot: "only-on-failure", trace: "off" },
  reporter: [["list"]],
});
