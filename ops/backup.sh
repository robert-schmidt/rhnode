#!/bin/sh
# Nightly (ops/rhnode-backup.timer): dump what the node can't give back, as zstd-compressed Native plus each table's
# CREATE, keep the last BACKUP_KEEP dumps in BACKUP_DIR, and mirror them to BACKUP_SSH (user@host; port BACKUP_SSH_PORT,
# key BACKUP_SSH_KEY) with rsync. That side should pin the key to one directory: command="rrsync <dir>",restrict in
# authorized_keys.
# Partial on purpose (2026-10-31: a full dump was ~56 GB a night and growing ~3x with the history pass): the node is the
# archive of every block and receipt, so kept_transfers/swaps/logs/txs/relay/blocks, idx_wallet_txs, native_edges and the
# agg_* sums come back by re-running the history pass (~2-3 days). Dumped: what comes from tip traces (creations,
# curve_payouts, kept_native's internal transfers), our own state (ctl_*), and small tables that are slow to recompute.
# BACKUP_TABLES=a,b,c replaces the list; BACKUP_TABLES=all dumps every kept_/agg_/ctl_ table as before.
# Each dump has MANIFEST (table, rows at dump time) and SHA256SUMS. Restore: ops/restore.sh (checks both first).
# Rotation: dumps are named by UTC time, the newest BACKUP_KEEP stay, and the mirror follows (rsync --delete).
# Tables are dumped one after another, not at one instant; ReplacingMergeTree rows may repeat until merged (FINAL reads).
set -eu
cd "$(dirname "$0")/.."
conf() { grep -s "^$1=" .env | cut -d= -f2-; }
DIR=$(conf BACKUP_DIR); DIR=${DIR:-/srv/rhnode-backups}
KEEP=$(conf BACKUP_KEEP); KEEP=${KEEP:-7}
TABLES=$(conf BACKUP_TABLES); TABLES=${TABLES:-creations,curve_payouts,kept_native,token_origin,token_markets,labels,contracts,pools,serve_tokens,agg_candles_1m,agg_wallet_token,kept_trades,kept_launches,kept_pools}
SSH=$(conf BACKUP_SSH); PORT=$(conf BACKUP_SSH_PORT); PORT=${PORT:-22}
KEY=$(conf BACKUP_SSH_KEY); KEY=${KEY:-/root/.ssh/rhnode-backup}
q() { docker compose exec -T clickhouse sh -c 'clickhouse-client -u "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" -d rhnode "$@"' sh "$@"; }
log() { echo "$(date -u +%T) $*"; }

mkdir -p "$DIR"; rm -rf "$DIR"/*.tmp
OUT="$DIR/$(date -u +%Y-%m-%dT%H%M)"; mkdir "$OUT.tmp"
if [ "$TABLES" = all ]; then W="match(name, '^(kept|agg|ctl)_') OR name IN ('contracts', 'pools', 'serve_tokens')"
else W="startsWith(name, 'ctl_') OR has(splitByChar(',', '$TABLES'), name)"; fi
for t in $(q -q "SELECT name FROM system.tables WHERE database = 'rhnode' AND engine LIKE '%MergeTree'
    AND ($W) AND name != 'kept_transfers_by_wallet' ORDER BY name"); do
  q -q "SHOW CREATE TABLE $t" --format TSVRaw > "$OUT.tmp/$t.sql"
  q -q "SELECT * FROM $t FORMAT Native" > "$OUT.tmp/$t.native" # to a file first: sh has no pipefail
  printf "%s\t%s\n" "$t" "$(q -q "SELECT count() FROM $t")" >> "$OUT.tmp/MANIFEST" # ponytail: counted after the dump; a busy table may drift by a few rows
  zstd -q --rm -T2 -6 "$OUT.tmp/$t.native"
done
(cd "$OUT.tmp" && sha256sum -- *.zst *.sql MANIFEST > SHA256SUMS)
mv "$OUT.tmp" "$OUT"
ls -1d "$DIR"/20* | head -n -"$KEEP" | xargs -r rm -rf
log "dumped $(ls "$OUT" | grep -c native) tables, $(du -sh "$OUT" | cut -f1); kept $(ls -1d "$DIR"/20* | wc -l) dumps, $(du -sh "$DIR" | cut -f1)"
[ -z "$SSH" ] && exit 0
rsync -a --delete -e "ssh -p $PORT -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new" "$DIR/" "$SSH:"
log "mirrored to ${SSH#*@}"
