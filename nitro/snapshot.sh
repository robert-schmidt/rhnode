#!/bin/sh
# Download the latest official Robinhood Chain full-path snapshot (Offchain Labs) and unpack it into a Nitro chain dir.
# Usage: nitro/snapshot.sh CHAIN_DIR WORK_DIR   e.g. the `nitro` volume's robinhood/ dir and a scratch dir on the same disk.
# Resumable: re-run after any failure. Disk: parts (~1.1 TB) + unpacked (~1.1 TB) at the peak. One download stream
# (~50 MB/s measured 2026-10-29) so it doesn't saturate a shared uplink. Needs curl, python3, xxhsum (apt: xxhash).
set -eu
CHAIN=${1:?chain dir}; WORK=${2:?work dir}
BASE="https://robinhood-snapshots.offchainlabs.com/robinhood%20chain"
ID=$(curl -fsS "$BASE/latest-full-path.txt" | tr -d '\n' | sed 's|/$||; s|.*/||')
[ -e "$CHAIN/.snapshot-$ID" ] && { echo "already unpacked: $ID"; exit 0; }
mkdir -p "$WORK/$ID" && cd "$WORK/$ID"
curl -fsS -o metadata.json "$BASE/$ID/metadata.json"
parts=$(python3 -c 'import json;[print(p["filename"],p["size_bytes"],p["xxhash"]) for p in json.load(open("metadata.json"))["parts"]]')
echo "$parts" | while read -r f size xx; do
  [ -e "$f.ok" ] && continue
  echo "$(date -u +%T) downloading $f ($size bytes)"
  until [ "$(stat -c %s "$f" 2>/dev/null || echo 0)" = "$size" ]; do
    # No curl --retry: it re-sends the offset it started with, so a dropped stream restarted a 537 GB part from 0
    # (seen 2026-10-29). This loop resumes from the file's real size instead. HTTP/1.1: the CDN's HTTP/2 streams reset.
    curl -fsS --http1.1 --speed-limit 1048576 --speed-time 120 -C - -o "$f" "$BASE/$ID/$f" || sleep 10
  done
  echo "$(date -u +%T) verifying $f"
  [ "$(xxhsum -H1 "$f" | cut -d' ' -f1)" = "$xx" ] || { echo "xxhash mismatch: $f (deleted, re-run)"; rm -f "$f"; exit 1; }
  touch "$f.ok"
done
echo "$(date -u +%T) unpacking into $CHAIN/nitro"
mkdir -p "$CHAIN/nitro"
cat $(echo "$parts" | cut -d' ' -f1) | tar -x -C "$CHAIN/nitro"
chown -R 1000:1000 "$CHAIN"; chown 1000:1000 "$(dirname "$CHAIN")"   # the image runs as uid 1000 and writes jwtsecret to the volume root
touch "$CHAIN/.snapshot-$ID"
rm -f full-path.tar.part*
echo "$(date -u +%T) done: $ID"
