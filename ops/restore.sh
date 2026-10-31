#!/bin/sh
# Restore tables from an ops/backup.sh dump into ClickHouse.
#   sudo sh ops/restore.sh <dump-dir> [table ...]          into rhnode; only into tables that are missing or empty
#   sudo sh ops/restore.sh --replace <dump-dir> [table ...] TRUNCATE each table first (agg_* states would double otherwise)
#   sudo sh ops/restore.sh --db rhnode_check <dump-dir>     into a scratch database (created; drop it after)
# A dump comes from the backup box's mirror or BACKUP_DIR. It checks SHA256SUMS before touching anything, creates a missing
# table from the dump's CREATE, and compares each table's rows with the dump's MANIFEST. Tables not in the dump come back by re-running the history pass.
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
  zstd -dc "$D/$t.native.zst" | q -q "INSERT INTO $DB.$t FORMAT Native"
  want=$(awk -v t="$t" '$1 == t { print $2 }' "$D/MANIFEST"); got=$(q -q "SELECT count() FROM $DB.$t")
  echo "$t: $got rows (dump: ${want:-?})"
done
exit $bad
