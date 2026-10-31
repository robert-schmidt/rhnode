#!/bin/sh
# Restore tables from an ops/backup.sh dump into ClickHouse.
#   sudo sh ops/restore.sh <dump-dir> [table ...]          into rhnode; only into tables that are missing or empty
#   sudo sh ops/restore.sh --replace <dump-dir> [table ...] TRUNCATE each table first (agg_* states would double otherwise)
#   sudo sh ops/restore.sh --db rhnode_check <dump-dir>     into a scratch database (created; drop it after)
# A dump comes from the backup box's mirror or BACKUP_DIR. It checks SHA256SUMS before touching anything, creates a missing
# table from the dump's CREATE, and checks that each table got every row of its file (MANIFEST). Tables not in the dump come back by re-running the history pass.
# A fresh box: migrate first (views and the other tables come from migrations), restore, then start the rest:
#   docker compose up -d clickhouse && docker compose run --rm ingest node src/migrate.ts
#   sudo sh ops/restore.sh <dump-dir> && docker compose up -d
set -eu
cd "$(dirname "$0")/.."
DB=rhnode; REPLACE=0
while [ $# -gt 0 ]; do case "$1" in --db) DB=$2; shift 2;; --replace) REPLACE=1; shift;; *) break;; esac; done
D=${1:?usage: restore.sh [--db name] [--replace] <dump-dir> [table ...]}; shift
q() { docker compose exec -T clickhouse sh -c 'clickhouse-client -u "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" "$@"' sh "$@"; }
echo "$DB" | grep -qE '^[a-z_][a-z0-9_]*$' || { echo "bad database name"; exit 1; }
(cd "$D" && sha256sum -c --quiet SHA256SUMS) || { echo "checksums don't match: not restoring"; exit 1; }
TABLES=${*:-$(cut -f1 "$D/MANIFEST" | grep -vx ctl_migrations)} # migrations own that one
q -q "CREATE DATABASE IF NOT EXISTS $DB"
bad=0
for t in $TABLES; do
  [ -f "$D/$t.native.zst" ] || { echo "$t: not in this dump"; bad=1; continue; }
  if [ "$(q -q "EXISTS TABLE $DB.$t")" = 0 ]; then sed "s/^CREATE TABLE rhnode\./CREATE TABLE $DB./" "$D/$t.sql" | q --multiquery
  elif [ "$REPLACE" = 1 ]; then q -q "TRUNCATE TABLE $DB.$t"
  elif [ "$(q -q "SELECT count() FROM $DB.$t")" != 0 ]; then echo "$t: has rows, skipped (--replace to overwrite)"; bad=1; continue; fi
  # rows written vs rows in the file (count() wouldn't do: Replacing/Aggregating tables collapse duplicates as they merge)
  id=restore_${t}_$$
  zstd -dc "$D/$t.native.zst" | q --query_id "$id" --optimize_on_insert 0 -q "INSERT INTO $DB.$t FORMAT Native"
  q -q "SYSTEM FLUSH LOGS"
  got=$(q -q "SELECT written_rows FROM system.query_log WHERE query_id = '$id' AND type = 'QueryFinish' LIMIT 1")
  want=$(awk -v t="$t" '$1 == t { print $2 }' "$D/MANIFEST")
  if [ "$got" = "$want" ]; then echo "$t: $got rows"; else echo "$t: wrote ${got:-?} rows, the dump has ${want:-?}"; bad=1; fi
done
exit $bad
