#!/bin/sh
# Nightly (ops/rhnode-backup.timer): dump what only this box holds forever (kept_*, agg_*, ctl_*, contracts, pools,
# serve_tokens) as zstd-compressed Native plus each table's CREATE, keep the last BACKUP_KEEP dumps in BACKUP_DIR (put it
# on another disk than Docker's data), and mirror them to BACKUP_SSH (user@host; port BACKUP_SSH_PORT, key BACKUP_SSH_KEY)
# with rsync. That side should pin the key to one directory: command="rrsync <dir>",restrict in authorized_keys.
# Left out: raw_*/ev_* (14 days, and the node keeps every block and receipt) and kept_transfers_by_wallet (migration 012
# rebuilds it from kept_transfers).
# Restore a table (after npm run migrate):
#   zstd -dc <dump>/<table>.native.zst | docker compose exec -T clickhouse sh -c \
#     'clickhouse-client -u "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" -q "INSERT INTO rhnode.<table> FORMAT Native"'
# Tables are dumped one after another, not at one instant; ReplacingMergeTree rows may repeat until merged (FINAL reads).
set -eu
cd "$(dirname "$0")/.."
conf() { grep -s "^$1=" .env | cut -d= -f2-; }
DIR=$(conf BACKUP_DIR); DIR=${DIR:-/srv/rhnode-backups}
KEEP=$(conf BACKUP_KEEP); KEEP=${KEEP:-3}
SSH=$(conf BACKUP_SSH); PORT=$(conf BACKUP_SSH_PORT); PORT=${PORT:-22}
KEY=$(conf BACKUP_SSH_KEY); KEY=${KEY:-/root/.ssh/rhnode-backup}
q() { docker compose exec -T clickhouse sh -c 'clickhouse-client -u "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" -d rhnode "$@"' sh "$@"; }
log() { echo "$(date -u +%T) $*"; }

mkdir -p "$DIR"; rm -rf "$DIR"/*.tmp
OUT="$DIR/$(date -u +%Y-%m-%dT%H%M)"; mkdir "$OUT.tmp"
for t in $(q -q "SELECT name FROM system.tables WHERE database = 'rhnode' AND engine LIKE '%MergeTree'
    AND (match(name, '^(kept|agg|ctl)_') OR name IN ('contracts', 'pools', 'serve_tokens')) AND name != 'kept_transfers_by_wallet' ORDER BY name"); do
  q -q "SHOW CREATE TABLE $t" --format TSVRaw > "$OUT.tmp/$t.sql"
  q -q "SELECT * FROM $t FORMAT Native" > "$OUT.tmp/$t.native" # to a file first: sh has no pipefail
  zstd -q --rm -T2 -6 "$OUT.tmp/$t.native"
done
mv "$OUT.tmp" "$OUT"
ls -1d "$DIR"/20* | head -n -"$KEEP" | xargs -r rm -rf
log "dumped $(ls "$OUT" | grep -c native) tables, $(du -sh "$OUT" | cut -f1); kept $(ls -1d "$DIR"/20* | wc -l) dumps, $(du -sh "$DIR" | cut -f1)"
[ -z "$SSH" ] && exit 0
rsync -a --delete -e "ssh -p $PORT -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new" "$DIR/" "$SSH:"
log "mirrored to ${SSH#*@}"
