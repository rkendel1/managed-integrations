#!/usr/bin/env bash
# Worker crash/restart verification against the running demo stack (make reset first).
# SIGKILLs the runtime worker mid-sync, restarts it, and checks: interrupted run recorded,
# resume from the durable cursor, every order delivered exactly once in NetSuite.
set -euo pipefail
cd "$(dirname "$0")/.."
export MI_REPO_DIR="$PWD" SOURCE_COMMIT="$(git rev-parse HEAD)"
C="docker compose --env-file .env --profile demo"
psql() { $C exec -T postgres psql -U mi -d managed_integrations -tAc "$1"; }
post() { curl -sf -X POST -H 'content-type: application/json' -d "$2" "http://127.0.0.1:$1"; }

post 4010/__fixture/seed "{\"count\":60,\"start\":\"$(date -u -d '-5 min' +%Y-%m-%dT%H:%M:%SZ)\",\"stepMs\":1000}" >/dev/null
post 4020/__fixture/latency '{"ms":400}' >/dev/null
echo "seeded 60 orders; NetSuite latency 400ms/request"

# wait until a run is in progress and has delivered something, then kill -9 the worker
for i in $(seq 1 120); do
  n=$(psql "select coalesce(sum(delivered_count),0) from sync_runs where status='running'")
  [ "${n:-0}" -gt 0 ] && break; sleep 1
done
run=$(psql "select id from sync_runs where status='running' order by created_at desc limit 1")
echo "killing worker during run $run (delivered so far: $(psql "select delivered_count from sync_runs where id='$run'"))"
$C kill -s SIGKILL worker >/dev/null
echo "status after kill: $(psql "select status from sync_runs where id='$run'") (no worker alive to finish it)"
post 4020/__fixture/latency '{"ms":0}' >/dev/null
$C start worker >/dev/null
echo "worker restarted; waiting for interruption detection (lease expiry) and resume..."
for i in $(seq 1 400); do
  st=$(psql "select status from sync_runs where id='$run'")
  ok=$(psql "select count(*) from sync_runs where created_at > (select created_at from sync_runs where id='$run') and status='succeeded'")
  [ "$st" = "interrupted" ] && [ "${ok:-0}" -gt 0 ] && break; sleep 2
done
echo "killed run final status: $(psql "select status||' / '||coalesce(error_message,'') from sync_runs where id='$run'")"
echo "resumed run: $(psql "select mode||' '||status||' delivered='||delivered_count||' already='||already_delivered_count||' cursor_before='||cursor_before from sync_runs where created_at > (select created_at from sync_runs where id='$run') and status='succeeded' order by created_at limit 1")"
curl -sf http://127.0.0.1:4020/__fixture/state | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s).salesOrders;const ids=o.map(x=>x.externalId);console.log(`NetSuite fixture: ${o.length} sales orders, ${new Set(ids).size} unique externalIds, duplicates=${o.length-new Set(ids).size}`)})'
echo "deliveries by outcome: $(psql "select string_agg(outcome||'='||c, ', ') from (select outcome, count(*) c from deliveries group by 1) x")"
