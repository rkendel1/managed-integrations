#!/usr/bin/env bash
# Every shared scenario (docs/experiment/SCENARIOS.md), in sequence, after one reset of System B and its
# simulators. Each scenario writes its evidence (every step, with its time and data) to $MI_EVIDENCE_DIR.
#
# Order matters only because the simulators are one shared world per reset: NetSuite is one account, and
# Stripe and QuickBooks are one account each that every ledgerly company subscribes to. Scenarios that change
# that world (OneWorld, an inactive account) restore it when they end, and inactive-account runs before the
# other Stripe scenarios (S6, S7) so no other company receives its Stripe events.
#
# Usage: MI_B_SECRETS=<env file> scripts/scenarios.sh [scenario ...] > run.log
# (redirect to a file, not a pipe: the reset leaves the app and simulators running, holding the pipe open)
set -euo pipefail
cd "$(dirname "$0")/.."
ALL=(failure adopted reconcile maintenance onboarding target combined inactive-account stripe applications)
SELECTED=("${@:-${ALL[@]}}")
for v in $(env | grep -o '^[A-Z_]*FELTDB[A-Z_]*' || true); do unset "$v"; done # F12: never ambient FeltDB settings
./scripts/reset.sh
export MI_EVIDENCE_DIR=${MI_EVIDENCE_DIR:-../../docs/evidence/runs/system-b}
started=$(date +%s)
passed=0
for s in "${SELECTED[@]}"; do
  echo "=== $s"
  if timeout 300 node "scenarios/$s.ts"; then passed=$((passed + 1)); else
    echo "FAILED: $s (logs: ${MI_B_LOGS:-/tmp/mi-system-b})" >&2
    exit 1
  fi
done
echo "ALL PASSED: $passed/${#SELECTED[@]} scenarios in $(($(date +%s) - started))s after one reset"
