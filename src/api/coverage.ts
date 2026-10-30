// What ClickHouse holds right now: every block in [rawFrom, ingested] is complete in raw_* / ev_*.
// Older blocks live only in kept_* (watched entities) or on the node. Cached for 5 s.
// exactFrom: every ERC-20 transfer from that block on is in kept_transfers (migration 009 from go-live, the backward
// walk below it, src/promoter/walk.ts); null before go-live is known.
import { rows } from "../ch.ts";

let at = 0;
let cur: { rawFrom: number; ingested: number; exactFrom: number | null } = { rawFrom: Infinity, ingested: 0, exactFrom: null };

/** `maxAgeMs`: how stale an answer may be (a caller waiting for ingest asks for a fresh one). */
export async function coverage(maxAgeMs = 5_000): Promise<typeof cur> {
  if (Date.now() - at < maxAgeMs) return cur;
  const [r] = await rows<{ raw_from: string; ingested: string; exact_from: string; have_exact: string }>(
    `SELECT (SELECT min(number) FROM raw_blocks) AS raw_from, (SELECT max(block) FROM ctl_cursors FINAL WHERE name = 'tip') AS ingested,
       (SELECT if(countIf(name = 'walk') > 0, minIf(block, name = 'walk'), minIf(block, name = 'golive')) FROM ctl_cursors FINAL WHERE name IN ('walk', 'golive')) AS exact_from,
       (SELECT count() FROM ctl_cursors FINAL WHERE name IN ('walk', 'golive')) AS have_exact`);
  // An empty raw_blocks gives min = 0: nothing is covered then.
  cur = { rawFrom: Number(r.ingested) ? Number(r.raw_from) : Infinity, ingested: Number(r.ingested), exactFrom: Number(r.have_exact) ? Number(r.exact_from) : null };
  at = Date.now();
  return cur;
}
