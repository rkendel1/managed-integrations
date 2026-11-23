# Roadmap (locked order — spec §24)

| Phase                       | Status                                              | Gate / evidence                                                                                                              |
| --------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 0 Inspection & feasibility  | DONE                                                | empty repo; tools inventoried; provider research (`architecture/PROVIDER-RESEARCH.md`)                                       |
| 1 Foundation                | DONE                                                | monorepo, strict TS, Drizzle migrations, Fastify, React, Zod, Vitest, Pino, health checks, config validation, Docker Compose |
| 2 Deterministic integration | DONE (fixtures)                                     | acceptance suite 27 tests                                                                                                    |
| 3 Reliability               | DONE                                                | reliability tests; customer + operator views                                                                                 |
| 4 Maintenance agent         | DONE (playbook verified; Claude planner unexecuted) | pipeline test, Docker demo                                                                                                   |
| 5 Release safety            | DONE                                                | pipeline + release tests (canary, auto/operator rollback)                                                                    |
| 6 End-to-end proof          | DONE (fixtures)                                     | Docker demo, crash test, Playwright                                                                                          |
| 7 Pilot readiness           | PARTIAL                                             | see `evidence/PILOT-READINESS.md`; blocked on real provider access                                                           |
| 8 AppPort-native foundation  | DONE (one capability)                               | `capabilities/test/integrations-list.test.ts`, `apps/api/test/appport-mcp.test.ts`, Playwright; `architecture/APPORT-CAPABILITY-MAP.md` |

## Next (within the locked roadmap)

1. **Real-provider verification (Phase 7 blocker):** Shopify dev store + NetSuite sandbox; run the
   acceptance scenarios manually against them; resolve every UNVERIFIED item in PROVIDER-RESEARCH.
2. **Capability parity for configuration (recommended next slice):** add one consequential capability,
   `integrations.configure@1`, that reads and updates the integration's contract-validated config with
   `config_version` optimistic concurrency and an `integrations.write` permission. It replaces the
   customer config REST path as the UI's mutation, exercises AppPort idempotency/effect handling, and
   proves UI/MCP equivalence for a write. Do this only after deciding how CSRF is expressed across
   capability transports; the current cookie + custom-header CSRF applies to the REST path, not to
   AppPort calls.
3. Onboarding checklist + NetSuite certificate generation helper (openssl) in the Connections UI.
4. Run the maintenance service on a separate host; production deploy to a VPS; restore drill.
5. Execute the Claude planner against a recorded non-playbook failure with an API key; measure cost.

No additional integrations until the first flow is proven with a real customer.
