#!/bin/sh
# Every 2 minutes (ops/rhnode-heal.timer): bring the stack back after a reboot or a failure, with no one at the box.
# The NVMe on USB can enumerate after the boot-time mount gave up, and Docker won't start without it (RequiresMountsFor).
# `up -d --no-recreate` starts what isn't running and never touches a running container, even one whose definition
# changed (that's ops/deploy.sh's job). Skips while a deploy holds the lock.
# To stop the stack on purpose: `systemctl stop rhnode-heal.timer` first.
set -u
cd "$(dirname "$0")/.."
exec 9>/tmp/rhnode-ops.lock; flock -n 9 || exit 0
DATA=$(grep -s '^DATA_MOUNT=' .env | cut -d= -f2)
if [ -n "$DATA" ] && ! mountpoint -q "$DATA"; then mount "$DATA" || { echo "$DATA not mountable yet"; exit 0; }; fi
systemctl is-active -q docker || systemctl start docker
running=$(docker compose ps --status running --services 2>/dev/null)
missing=$(docker compose config --services | grep -vxF "$running")
[ -z "$missing" ] && exit 0
echo "not running: $(echo $missing); starting"
docker compose up -d --no-recreate
