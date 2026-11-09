#!/bin/sh
# Nightly (ops/rhnode-backup.timer): dump what the node can't give back, as zstd-compressed Native plus each table's
# CREATE, into BACKUP_DIR, upload it to BACKUP_SSH (user@host; port BACKUP_SSH_PORT, key BACKUP_SSH_KEY) with rsync, and
# only then keep the newest BACKUP_KEEP dumps here (a failed upload keeps them all). The backup box keeps its own newest
# 7: its forced command, ops/backup-recv.sh, lets the key only add files and rotates after each upload.
# Partial on purpose (2026-10-31: a full dump was ~56 GB a night and growing ~3x with the history pass): the node is the
# archive of every block and receipt, so kept_transfers/swaps/logs/txs/relay/blocks, idx_wallet_txs, native_edges and the
# agg_* sums come back by re-running the history pass (~2-3 days). Dumped: what comes from tip traces (creations,
# curve_payouts, kept_native's internal transfers), our own state (ctl_*), and small tables that are slow to recompute.
# BACKUP_TABLES=a,b,c replaces the list; BACKUP_TABLES=all dumps every kept_/agg_/ctl_ table as before.
# Each dump has MANIFEST (table, rows in its file) and SHA256SUMS. Restore: ops/restore.sh (checks both first).
# Dumps are named by UTC time, so rotation is "all but the last N by name".
# Tables are dumped one after another, not at one instant; ReplacingMergeTree rows may repeat until merged (FINAL reads).
set -eu
cd "$(dirname "$0")/.."
conf() { grep -s "^$1=" .env | cut -d= -f2-; }
DIR=$(conf BACKUP_DIR); DIR=${DIR:-/srv/rhnode-backups}
KEEP=$(conf BACKUP_KEEP); KEEP=${KEEP:-1}
TABLES=$(conf BACKUP_TABLES); TABLES=${TABLES:-creations,curve_payouts,kept_native,token_origin,token_markets,labels,contracts,pools,serve_tokens,agg_candles_1m,agg_wallet_token,kept_trades,kept_launches,kept_pools}
SSH=$(conf BACKUP_SSH); PORT=$(conf BACKUP_SSH_PORT); PORT=${PORT:-22}
KEY=$(conf BACKUP_SSH_KEY); KEY=${KEY:-/root/.ssh/rhnode-backup}
# bulk workload (migration 031), 2 threads: on 2026-11-02 the dump ran in default and SELECT * FROM agg_candles_1m
# (15.5M rows, 3.7 GiB raw) took the server to 7.2 GiB RSS over its 5.6 GiB cap at 03:32: ingest inserts failed (3 restarts).
q() { docker compose exec -T clickhouse sh -c 'clickhouse-client -u "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" -d rhnode --workload bulk --max_threads 2 "$@"' sh "$@"; }
log() { echo "$(date -u +%T) $*"; }

mkdir -p "$DIR"; rm -rf "$DIR"/*.tmp
OUT="$DIR/$(date -u +%Y-%m-%dT%H%M)"; mkdir "$OUT.tmp"
if [ "$TABLES" = all ]; then W="match(name, '^(kept|agg|ctl)_') OR name IN ('contracts', 'pools', 'serve_tokens')"
else W="startsWith(name, 'ctl_') OR has(splitByChar(',', '$TABLES'), name)"; fi
for t in $(q -q "SELECT name FROM system.tables WHERE database = 'rhnode' AND engine LIKE '%MergeTree'
    AND ($W) AND name != 'kept_transfers_by_wallet' ORDER BY name"); do
  q -q "SHOW CREATE TABLE $t" --format TSVRaw > "$OUT.tmp/$t.sql"
  q -q "SELECT * FROM $t FORMAT Native" --log_comment "backup $OUT $t" > "$OUT.tmp/$t.native" # to a file first: sh has no pipefail
  # the rows it wrote, from the server's log of that query: counting the file with clickhouse local from stdin held all
  # of it in memory (9.4 GB, uncapped, for one table on 2026-11-03 03:42) and the kernel killed Nitro
  q -q "SYSTEM FLUSH LOGS"
  n=$(q -q "SELECT result_rows FROM system.query_log WHERE log_comment = 'backup $OUT $t' AND type = 'QueryFinish' ORDER BY event_time DESC LIMIT 1")
  [ -n "$n" ] || { log "$t: no row count in query_log"; exit 1; }
  printf "%s\t%s\n" "$t" "$n" >> "$OUT.tmp/MANIFEST"
  zstd -q --rm -T2 -6 "$OUT.tmp/$t.native"
done
(cd "$OUT.tmp" && sha256sum -- *.zst *.sql MANIFEST > SHA256SUMS)
mv "$OUT.tmp" "$OUT"
log "dumped $(ls "$OUT" | grep -c native) tables, $(du -sh "$OUT" | cut -f1)"
if [ -n "$SSH" ]; then # every local dump (one a failed night missed goes up now); -rt, not -a: no owner/mode onto that side
  rsync -rt -e "ssh -p $PORT -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new" "$DIR/" "$SSH:"
  log "uploaded to ${SSH#*@}"
fi
ls -1d "$DIR"/20* | head -n -"$KEEP" | xargs -r rm -rf
log "kept $(ls -1d "$DIR"/20* | wc -l) dumps here, $(du -sh "$DIR" | cut -f1)"
