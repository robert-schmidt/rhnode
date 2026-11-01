#!/bin/sh
# Every 2 minutes (ops/rhnode-heal.timer): bring the stack back after a reboot or a failure, with no one at the box.
# The NVMe on USB can enumerate after the boot-time mount gave up, and Docker won't start without it (RequiresMountsFor).
# `up -d --no-recreate` starts what isn't running and never touches a running container, even one whose definition
# changed (that's ops/deploy.sh's job), except Nitro below. Skips while a deploy holds the lock.
# To stop the stack on purpose: `systemctl stop rhnode-heal.timer` first.
set -u
cd "$(dirname "$0")/.."
exec 9>/tmp/rhnode-ops.lock; flock -n 9 || exit 0
DATA=$(grep -s '^DATA_MOUNT=' .env | cut -d= -f2)
if [ -n "$DATA" ] && ! mountpoint -q "$DATA"; then mount "$DATA" || { echo "$DATA not mountable yet"; exit 0; }; fi
systemctl is-active -q docker || systemctl start docker
running=$(docker compose ps --status running --services 2>/dev/null)
missing=$(docker compose config --services | grep -vxF "$running")
if [ -n "$missing" ]; then echo "not running: $(echo $missing); starting"; docker compose up -d --no-recreate; fi

# Nitro (2026-11-01, after the kernel OOM-killed it at 12:24 UTC and it replayed ~49K unsaved blocks): Docker restarts a
# crashed Nitro, but not a stuck one, and a kill loses the state it hadn't persisted. So a clean restart (SIGINT, it
# persists first; stop_grace_period 5m) when its head hasn't moved for 10 min (the chain moves ~10 blocks a second), or
# before the kernel would kill it: ≥95% of its memory cap, or under 1 GB available on the box. At most one restart per
# 30 min and 3 per 6 h; after that it's left alone, and /health shows it. Log: journalctl -u rhnode-heal.
echo "$running" | grep -qx nitro || exit 0
S=/run/rhnode-nitro; mkdir -p $S; now=$(date +%s)
ip=$(grep -s '^NODE_BIND=' .env | cut -d= -f2); case "${ip:-0.0.0.0}" in 0.0.0.0) ip=127.0.0.1;; esac
head=$(curl -s -m 10 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "http://$ip:8547" | grep -oE '0x[0-9a-f]+')
head=$((${head:-0}))
# any change counts as moving: after a kill it resumes below the head it had, then climbs
[ "$head" != "$(cat $S/head 2>/dev/null)" ] && { echo $head > $S/head; echo $now > $S/moved; }
[ -f $S/moved ] || echo $now > $S/moved
mem=$(docker stats --no-stream --format '{{.MemPerc}}' rhnode-nitro-1 | tr -d '%' | cut -d. -f1)
avail=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
why=""
[ $((now - $(cat $S/moved))) -ge 600 ] && why="head stuck at $head for $(( (now - $(cat $S/moved)) / 60 )) min"
[ "${mem:-0}" -ge 95 ] && why="memory at ${mem}% of its cap"
[ "$avail" -lt 1000 ] && why="${avail} MB available on the box (nitro at ${mem}%)"
[ -z "$why" ] && exit 0
recent=$(awk -v t=$((now - 21600)) '$1 > t' $S/restarts 2>/dev/null | wc -l)
last=$(tail -1 $S/restarts 2>/dev/null | cut -d' ' -f1)
if [ $((now - ${last:-0})) -lt 1800 ] || [ "$recent" -ge 3 ]; then echo "nitro: $why; not restarting ($recent restarts in 6 h, last $(( (now - ${last:-0}) / 60 )) min ago)"; exit 0; fi
echo "nitro: $why; clean restart"
echo "$now $why" >> $S/restarts
docker compose restart nitro
echo $now > $S/moved
