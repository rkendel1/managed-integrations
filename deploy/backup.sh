#!/bin/sh
# Nightly logical backup of the authoritative state store. Restore: see docs/operations/RUNBOOK.md.
set -eu
ts=$(date -u +%Y%m%dT%H%M%SZ)
pg_dump -h postgres -U mi -d managed_integrations -Fc -f "/backups/mi-$ts.dump"
pg_restore -l "/backups/mi-$ts.dump" > /dev/null   # verify the archive is readable
find /backups -name 'mi-*.dump' -mtime +"${BACKUP_RETENTION_DAYS:-14}" -delete
echo "backup ok: mi-$ts.dump"
