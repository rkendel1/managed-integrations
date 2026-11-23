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

## Next (within the locked roadmap)

1. **Real-provider verification (Phase 7 blocker):** Shopify dev store + NetSuite sandbox; run the
   acceptance scenarios manually against them; resolve every UNVERIFIED item in PROVIDER-RESEARCH.
2. Onboarding checklist + NetSuite certificate generation helper (openssl) in the Connections UI.
3. Run the maintenance service on a separate host; production deploy to a VPS; restore drill.
4. Execute the Claude planner against a recorded non-playbook failure with an API key; measure cost.

No additional integrations until the first flow is proven with a real customer.
