# Runbook (founder / operator)

Daily: open `/ops` (Inbox). If it is empty, nothing needs you. Everything below is triggered by an inbox item.

## Incident kinds

| Kind                         | What happened                                                          | Automatic behaviour                                                                                        | Your decision                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `connection_auth` (critical) | Shopify/NetSuite rejected credentials                                  | sync paused safely; cursor held                                                                            | Customer must re-authorize (they see the action). Follow up if stale > 1 day. Resolves itself after a successful sync. |
| `sync_failure` recoverable   | 2+ consecutive transient/rate-limit failures                           | retries continue; resolves after a caught-up run + reconciliation                                          | Usually none. If it persists for hours, check provider status.                                                         |
| `sync_failure` investigating | non-retryable/unknown failure                                          | maintenance task created                                                                                   | Review candidate when validated.                                                                                       |
| `schema_drift` (high)        | provider response no longer matches implementation                     | affected orders identified; maintenance agent investigates in isolation; candidate validated independently | **Review diff + validation, then Approve or Reject** on the candidate page.                                            |
| `freshness_breach`           | data older than contract allows                                        | resolves when sync catches up                                                                              | Investigate only if no other incident explains it.                                                                     |
| `records_rejected`           | orders failed validation (e.g. unmapped SKU, NetSuite mandatory field) | customer told exactly what to fix; adding a SKU mapping re-delivers automatically                          | Help the customer if the reason is NetSuite configuration.                                                             |
| `reconciliation_discrepancy` | missing (auto re-delivered) / duplicate / inconsistent / unexpected    | missing → redelivery; others never auto-repaired (no deletes)                                              | Inspect in NetSuite; resolve manually with the customer.                                                               |

## Reviewing a repair candidate

1. Read the hypothesis and the diff (only `src/implementation/**` and `test/regression/**` can change).
2. Check validation: _protected suite unchanged_ = passed; every suite passed; `isolated=true`.
3. Approve → canary (5 orders) → automatic reconciliation of the canary → promotion → catch-up →
   post-release reconciliation → incident resolved. A failed canary rolls back automatically.
4. If something looks wrong after release: Releases → **Roll back** (restores previous version).

## No candidate produced

The maintenance run page shows every tool call. Options: fix manually on a branch, register the version
(`buildVersionFromCommit`), and release it through the same approval path; or set `ANTHROPIC_API_KEY` +
`MAINTENANCE_PLANNER=auto` so the Claude planner attempts failures the playbook does not recognise.

## Routine tasks

- Refresh `docs/provider-docs` from official docs quarterly; plan the Shopify API version bump before
  the pinned version's support ends (2026-10 → supported until 2027-10-16).
- Weekly: check backups exist (`docker compose ... exec backup ls /backups`); quarterly: restore drill
  (procedure in `docs/evidence/runs/backup-restore-docker.log`).
- Log human intervention time per customer (not yet captured automatically) in your own sheet.

## Restore

```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml exec -T postgres pg_restore -U mi -d managed_integrations --clean --if-exists /path/to/mi-<ts>.dump
```

Restore `CREDENTIAL_ENCRYPTION_KEYS` from your separate secret backup before starting the workers.
