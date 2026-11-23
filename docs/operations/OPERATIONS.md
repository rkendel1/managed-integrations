# Operations

## Deployment target

One small Linux VPS with Docker Compose (`make prod-up` = `docker-compose.yml` + `deploy/docker-compose.prod.yml`).

| Service     | Image target       | Notes                                                                                                                                                 |
| ----------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| postgres    | postgres:16-alpine | volume `pgdata`; the only authoritative state store                                                                                                   |
| migrate     | runtime            | one-shot: migrations + reference data + baseline version + seed; other services wait for it                                                           |
| api         | runtime            | port 3000 behind Caddy; `/healthz` (liveness), `/readyz` (DB) ; Docker healthcheck                                                                    |
| worker      | runtime            | `WORKER_ROLE=runtime`; holds `CREDENTIAL_ENCRYPTION_KEYS`                                                                                             |
| maintenance | maintenance        | `WORKER_ROLE=maintenance`; **no** encryption keys; mounts the product source checkout at the same absolute path and the Docker socket (for sandboxes) |
| caddy       | caddy:2            | HTTPS with automatic certificates for `MI_DOMAIN`, HSTS                                                                                               |
| backup      | postgres:16-alpine | nightly `pg_dump -Fc`, archive verified with `pg_restore -l`, retention `BACKUP_RETENTION_DAYS`                                                       |

All services use `restart: unless-stopped`. API and worker are separate processes.

## Required production environment

`CREDENTIAL_ENCRYPTION_KEYS` (keyId:base64-32-bytes, first is primary), `POSTGRES_PASSWORD`,
`SESSION_SECRET` (≥32 chars), `SHOPIFY_CLIENT_ID`/`SHOPIFY_CLIENT_SECRET`, `PUBLIC_BASE_URL`, `MI_DOMAIN`,
`SEED_CUSTOMER_PASSWORD`/`SEED_OPERATOR_PASSWORD` (≥12), `DEMO_FIXTURES=false`, empty provider overrides.
Startup **fails closed** if keys are missing, overrides are set, or the session secret is weak.

## Images and versions

`SOURCE_COMMIT` (set by the Makefile) tags images and is baked into the baseline implementation artifact,
so the running implementation is traceable to a commit. Runtime images currently run TypeScript through
`tsx` with the full dependency set installed (simplicity over image size; see KNOWN-LIMITATIONS).

## Health and failure response

- Liveness/readiness: `/healthz`, `/readyz`; `make ps` shows container health.
- Integration health is derived every minute by the reliability tick and shown in both UIs.
- Failures become incidents automatically (see RUNBOOK for each kind). The operator inbox lists only
  exceptions.

## Backups and restore

Verified on 2026-11-23 against the Docker stack (`docs/evidence/runs/backup-restore-docker.log`): dump,
archive check, restore into a fresh database, identical per-table row counts. **The encryption keyring is
not in the dump** — back it up separately (password manager / offline). Without it, restored connections
must be re-authorized.
