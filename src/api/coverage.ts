// What ClickHouse holds right now: every block in [rawFrom, ingested] is complete in raw_* / ev_*.
// Older blocks live only in kept_* (watched entities) or on the node. Cached for 5 s.
import { rows } from "../ch.ts";

let at = 0;
let cur = { rawFrom: Infinity, ingested: 0 };

/** `maxAgeMs`: how stale an answer may be (a caller waiting for ingest asks for a fresh one). */
export async function coverage(maxAgeMs = 5_000): Promise<{ rawFrom: number; ingested: number }> {
  if (Date.now() - at < maxAgeMs) return cur;
  const [r] = await rows<{ raw_from: string; ingested: string }>(
    "SELECT (SELECT min(number) FROM raw_blocks) AS raw_from, (SELECT max(block) FROM ctl_cursors FINAL WHERE name = 'tip') AS ingested");
  // An empty raw_blocks gives min = 0: nothing is covered then.
  cur = { rawFrom: Number(r.ingested) ? Number(r.raw_from) : Infinity, ingested: Number(r.ingested) };
  at = Date.now();
  return cur;
}
