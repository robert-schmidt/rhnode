#!/bin/sh
# Release on the server: ops/deploy.sh [--infra] [ref]   (ref defaults to origin/main)
#  1. The commit must have passed CI (GitHub check runs), unless DEPLOY_SKIP_CI=1.
#  2. Rebuilds the app image and recreates only the app services (ingest, projector, api, l1proxy). ClickHouse, Redis
#     and Nitro are never touched: their changed definitions are listed and applied only with --infra. Nitro needs
#     minutes to stop cleanly and to come back, so an API or WebSocket change never restarts it.
#  3. Waits for /health (index and stream fresh); if it doesn't come back, rolls back to the previous commit.
# Migrations run when ingest starts; they're additive, so a rollback leaves them in place.
set -eu
cd "$(dirname "$0")/.."
exec 9>/tmp/rhnode-ops.lock; flock 9 # heal.sh waits for us
INFRA=0; [ "${1:-}" = "--infra" ] && { INFRA=1; shift; }
REF=${1:-origin/main}
PORT=$(grep -s '^API_PORT=' .env | cut -d= -f2); PORT=${PORT:-8080}
log() { echo "$(date -u +%T) $*"; }

git fetch -q origin
PREV=$(git rev-parse HEAD); NEXT=$(git rev-parse "$REF")
if [ "${DEPLOY_SKIP_CI:-0}" != 1 ]; then
  repo=$(git remote get-url origin | sed -E 's#.*github.com[:/](.*)\.git$#\1#; s#.*github.com[:/](.*)$#\1#')
  ci=$(curl -fsS "https://api.github.com/repos/$repo/commits/$NEXT/check-runs" | python3 -c 'import json,sys;r=json.load(sys.stdin)["check_runs"];print("ok" if r and all(c["conclusion"]=="success" for c in r) else "|".join(f"{c[\"name\"]}={c[\"conclusion\"] or c[\"status\"]}" for c in r) or "none")')
  [ "$ci" = ok ] || { log "CI not green for ${NEXT%"${NEXT#???????}"}: $ci (DEPLOY_SKIP_CI=1 to override)"; exit 1; }
fi

APP=$(docker compose config --services | grep -vxE 'clickhouse|redis|nitro' | tr '\n' ' ')
deploy() {
  git checkout -q --detach "$1"
  docker compose build -q $APP
  docker compose up -d --no-deps $APP
  for s in $(docker compose config --services | grep -xE 'clickhouse|redis|nitro'); do
    id=$(docker compose ps -q "$s"); want=$(docker compose config --hash "$s" | cut -d' ' -f2)
    have=$([ -n "$id" ] && docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$id" || echo none)
    [ "$want" = "$have" ] && continue
    if [ $INFRA = 1 ]; then log "applying the changed definition of $s"; docker compose up -d --no-deps "$s"
    else log "NOTE: $s's definition changed; not restarted (re-run with --infra to apply)"; fi
  done
}
healthy() { # index and stream fresh: the upstream flag alone isn't this release's fault
  i=0; while [ $i -lt 36 ]; do
    curl -s -m 5 "http://127.0.0.1:$PORT/health" | grep -q '"index":true,"stream":true' && return 0
    i=$((i + 1)); sleep 5
  done; return 1
}

log "deploying ${NEXT%"${NEXT#???????}"} over ${PREV%"${PREV#???????}"} ($APP)"
deploy "$NEXT"
if healthy; then log "healthy"; exit 0; fi
log "not healthy after 3 min: rolling back to ${PREV%"${PREV#???????}"}"
deploy "$PREV"
healthy && log "rolled back, healthy" || log "rolled back, STILL NOT HEALTHY: look at docker compose logs"
exit 1
