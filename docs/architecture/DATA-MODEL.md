# Data model (PostgreSQL, Drizzle — `packages/database/src/schema.ts`)

| Entity                              | Purpose / notable fields                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tenants, users, sessions, audit_log | identity; sessions store only sha256(token) + CSRF token; audit for operator/customer actions                                                                                               |
| providers                           | provider id, pinned API version, capabilities, doc references                                                                                                                               |
| connections                         | per tenant+provider: status (pending/authorized/verified/error/revoked/disconnected), scopes, base URL, AES-GCM credential envelope (AAD = connection id), token expiries, OAuth state hash |
| integration_contracts               | immutable contract versions + sha256                                                                                                                                                        |
| integration_versions                | immutable implementation artifacts: source commit, path, sha256, release state                                                                                                              |
| integrations                        | config, enabled/lifecycle, contract version, pinned + canary implementation version, health, **cursor watermark**, backfill completion, last successful sync, **lease** (owner/expiry)      |
| sync_runs                           | mode, status, trigger, version, cursor before/after, page/record counts, error class, heartbeat, evidence                                                                                   |
| deliveries                          | one per (integration, source order): idempotency key, external id, destination id, outcome, attempts, validation, non-PII summary (lines, total), source updatedAt delivered vs latest      |
| delivery_attempts                   | every attempt: outcome, HTTP status, error class, retry delay, version                                                                                                                      |
| observations                        | sanitized provider errors/anomalies/rate limits/schema changes with trace id                                                                                                                |
| incidents, incident_events          | kind, severity, status, dedupe key (unique while open), scope, impact, customer summary/action, evidence, resolution, verification; timeline with customer visibility                       |
| reconciliation_runs                 | window, counts, missing/duplicates/inconsistent/stale/unexpected/unresolved lists, outcome                                                                                                  |
| maintenance_runs                    | trigger, planner, sanitized context, tool call log, hypothesis, outcome, cost, human decisions                                                                                              |
| repair_candidates                   | branch, base/candidate commit, diff, changed files, hypothesis, agent test results (non-authoritative), status, decision                                                                    |
| validation_runs                     | suite sha256, candidate commit, protected-paths check, per-suite results, sandbox info                                                                                                      |
| releases                            | version, previous version, approver, canary run/result, post-release reconciliation, rollback reason                                                                                        |

## State machines

- **Sync run**: running → succeeded | partial | failed; running → interrupted (lease/heartbeat expiry).
- **Delivery**: pending → delivered | skipped | rejected | failed (failed/rejected can be re-attempted).
- **Incident**: detected → classified → investigating | recoverable | requires_action → recovery →
  verification → resolved (resolved **only** from verification, with verification evidence).
- **Candidate**: submitted → validating → validated | validation_failed → approved | rejected → released |
  rolled_back.
- **Release**: approved → canary → released | rolled_back (automatic on canary failure; manual later).
- **Implementation version**: candidate/validated → canary → released → retired | rolled_back.

Migrations: `packages/database/migrations` (generated by drizzle-kit, applied by `pnpm db:migrate` or the
`migrate` compose service).
