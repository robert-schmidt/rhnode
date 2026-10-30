// Reorg rollback (ARCHITECTURE §5). Nothing is mutated in place: every ev_* row of the dropped blocks is
// re-inserted with sign = -1 (so agg_* MVs subtract it), then the dropped rows (both signs) are deleted
// from raw/ev/kept, then the cursor moves back. Each step is safe to repeat after a crash:
// - the -1 insert carries a deterministic token, so a second run is dropped by ClickHouse (store.test.ts
//   replays it). It runs server-side: UInt256 doesn't survive a round-trip through JS numbers;
// - the delete is idempotent; the cursor only moves after the rows are gone, so a crash before it re-detects
//   the same fork and re-runs the steps (finding nothing left to negate or delete).
import { ch, rows } from "../ch.ts";

// ev_prices/ev_trades are written by the projector; rolled back the same way, and the projector cursor rewinds with it.
const EV = ["ev_transfers", "ev_native", "ev_swaps", "ev_pools", "ev_launches", "ev_relay", "ev_prices", "ev_trades"];
const RAW = ["raw_txs", "raw_logs"];
const KEPT = ["kept_txs", "kept_logs", "kept_transfers", "kept_transfers_by_wallet", "kept_native", "kept_swaps", "kept_pools", "kept_launches", "kept_relay", "kept_trades", "contracts",
  // views on raw_txs (migrations 015, 016): their rows of dropped blocks would point at, or fund from, txs that never were
  "idx_wallet_txs", "native_edges", "native_edges_by_src"];

/** The highest block where our stored hash equals the chain's, scanning down from `from`. Blocks we never
 *  stored (already deleted by an interrupted rollback) are skipped. null = no match within `depth`.
 *  The default reaches past "finalized" (~11,000 blocks behind the tip, measured 2026-10-30), below which nothing can
 *  change. ponytail: a linear scan, one call a block (seconds on our node); bisect if deep reorgs ever happen. */
export const REORG_DEPTH = 20_000;
export async function findFork(from: number, stored: (n: number) => Promise<string | null>, chain: (n: number) => Promise<string>, depth = REORG_DEPTH): Promise<number | null> {
  for (let n = from; n > from - depth; n--) {
    const ours = await stored(n);
    if (ours !== null && ours === (await chain(n))) return n;
  }
  return null;
}

export async function storedHash(n: number): Promise<string | null> {
  return (await rows<{ hash: string }>("SELECT hash FROM raw_blocks WHERE number = {n:UInt64} AND sign = 1 LIMIT 1", { n }))[0]?.hash ?? null;
}

/** Undo every block ≥ `from`. `tag` makes the -1 insert's token deterministic for this reorg. */
export async function rollback(from: number, tag: string): Promise<void> {
  await negate(from, tag);
  await drop(from);
  // The projector derived rows from the dropped blocks: send it back to re-derive the new branch.
  const p = (await rows<{ block: string }>("SELECT block FROM ctl_cursors FINAL WHERE name = 'projector'"))[0];
  if (p && Number(p.block) >= from) await ch.insert({ table: "ctl_cursors", values: [{ name: "projector", block: from - 1, hash: "", version: Date.now() }], format: "JSONEachRow" });
}

/** Step 1: re-insert every ev_* row ≥ from with sign -1, so the aggregates subtract it. */
export async function negate(from: number, tag: string): Promise<void> {
  for (const t of EV) {
    await ch.command({
      // Filter in the subquery: next to REPLACE, a WHERE's `sign` means the replaced -sign (and matches nothing).
      query: `INSERT INTO ${t} SELECT * REPLACE (-sign AS sign) FROM (SELECT * FROM ${t} WHERE block >= {from:UInt64} AND sign = 1)`,
      query_params: { from },
      clickhouse_settings: { insert_deduplication_token: `${t}:rollback:${from}:${tag}`, deduplicate_blocks_in_dependent_materialized_views: 1 },
    });
  }
}

/** Step 2: delete every row ≥ from (both signs) from raw/ev/kept. */
export async function drop(from: number): Promise<void> {
  for (const t of [...EV, ...RAW, ...KEPT]) await ch.command({ query: `DELETE FROM ${t} WHERE block >= {from:UInt64}`, query_params: { from } });
  for (const t of ["raw_blocks", "kept_blocks"]) await ch.command({ query: `DELETE FROM ${t} WHERE number >= {from:UInt64}`, query_params: { from } });
}
