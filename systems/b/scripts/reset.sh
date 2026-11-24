#!/usr/bin/env bash
# System B's equivalent of System A's `make reset`: DESTROYS B's development state, restarts B's own
# provider simulators (ports 50xx; in-memory state) and starts `feltkit dev` on port 3100.
# Secrets come from $MI_B_SECRETS (an env file with FELTKIT_CREDENTIAL_MI_KEYRING and
# FELTKIT_CREDENTIAL_SHOPIFY_CLIENT_SECRET); never from the repository.
set -euo pipefail
cd "$(dirname "$0")/.."
B_DIR=$PWD
REPO=$(cd ../.. && pwd)
LOGS=${MI_B_LOGS:-/tmp/mi-system-b}
mkdir -p "$LOGS"

pkill -f "feltkit dev --port 3100" 2>/dev/null || true
pkill -f "FIXTURE_SET=system-b" 2>/dev/null || true
pkill -f "packages/test-fixtures/src/cli.ts" 2>/dev/null || true
sleep 1
rm -rf "$B_DIR/.feltkit/development"

(cd "$REPO" && FIXTURE_SET=system-b FIXTURE_SHOPIFY_PORT=5010 FIXTURE_SHOPIFY2_PORT=5011 FIXTURE_SHOPIFY3_PORT=5012 \
  FIXTURE_NETSUITE_PORT=5020 FIXTURE_STRIPE_PORT=5030 FIXTURE_QBO_PORT=5040 \
  nohup pnpm exec tsx packages/test-fixtures/src/cli.ts > "$LOGS/fixtures.log" 2>&1 &)

set -a
# shellcheck disable=SC1090
. "${MI_B_SECRETS:?set MI_B_SECRETS to an env file with the FELTKIT_CREDENTIAL_* values}"
set +a
(MI_PUBLIC_URL=http://127.0.0.1:3100 nohup npx feltkit dev --port 3100 > "$LOGS/dev.log" 2>&1 &)

for _ in $(seq 1 120); do
  if curl -sf http://127.0.0.1:3100/_feltkit/health >/dev/null && curl -sf http://127.0.0.1:5011/__fixture/state >/dev/null; then
    echo "System B ready (state reset; simulators on 50xx)"
    exit 0
  fi
  sleep 0.5
done
echo "System B did not become ready; see $LOGS" >&2
exit 1
