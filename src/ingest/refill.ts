// Refill an ingest gap that a replay can't: after a power loss ClickHouse kept the dedup log and lost the rows (2026-11-12,
// 2026-11-14), so ingest's re-run of those batches, under the same tokens, was dropped. Per aligned batch: decode from the
// node as ingest does, and insert a table only where it holds no row of that batch (under a new token). A batch stored
// exactly twice (its dedup missed, the copies merged into one part) is deleted and inserted once only when `fixDoubles`;
// any other partial count is reported and left. Then the projector's prices (only where the range has none), trades (the
// range's old ones cancelled first) and the touched tokens' cards at the tip.
import { cfg } from "../config.ts";
import { ch, insert, inSpan, rows, span } from "../ch.ts";
import type { Client } from "../chain/upstream.ts";
import { decodeBlock, emptyRows, type Rows } from "./decode.ts";
import { learn, loadCtx } from "./keep.ts";
import { fetchRange } from "./main.ts";
import { derivePrices } from "../projector/prices.ts";
import { deriveTrades } from "../projector/trades.ts";
import { projectTokens } from "../projector/main.ts";

export type RefillOpts = { dry: boolean; fixDoubles: boolean; log?: (s: string) => void };

/** Returns the number of tables it left alone because they held a partial count (needs a person). */
export async function refill(up: Client, from: number, to: number, o: RefillOpts): Promise<number> {
  const log = o.log ?? console.log, B = cfg.batchBlocks, tag = `refill-${Date.now()}`; // a new token every run: a refill lost to the next power cut must not be dropped too
  const ctx = await loadCtx(cfg.launchWindowHours * 3600);
  let left = 0;
  for (let a = from - (from % B); a <= to; a += B) {
    const all = emptyRows();
    let hash = "";
    for (const [b, r] of await fetchRange(up, a, a + B - 1)) {
      const out = decodeBlock(b, r, ctx);
      learn(ctx, out);
      for (const k of Object.keys(all) as (keyof Rows)[]) for (const row of out[k]) (all[k] as object[]).push(row);
      hash = b.hash.toLowerCase();
    }
    const line: string[] = [];
    for (const [table, rs] of Object.entries(all) as [keyof Rows, object[]][]) {
      const col = table === "raw_blocks" ? "number" : "block";
      const [{ n }] = await rows<{ n: string }>(`SELECT count() AS n FROM ${table} WHERE ${col} BETWEEN {a:UInt64} AND {b:UInt64}`, { a, b: a + B - 1 });
      const have = Number(n);
      if (have === rs.length) { line.push(`${table} ok ${have}`); continue; }
      if (have && !(o.fixDoubles && have === 2 * rs.length)) { line.push(`${table} PARTIAL ${have}/${rs.length}`); left++; continue; }
      line.push(have ? `${table} ×2→${rs.length}` : `${table} +${rs.length}`);
      if (have && !o.dry) await ch.command({ query: `DELETE FROM ${table} WHERE ${col} BETWEEN {a:UInt64} AND {b:UInt64}`, query_params: { a, b: a + B - 1 } });
      if (!o.dry) await insert(table, rs, `${a}-${a + B - 1}:${hash}:${tag}`);
    }
    log(`${a}-${a + B - 1} ${o.dry ? "(dry) " : ""}${line.join(", ")}`);
  }
  const r = { a: from, b: to, ...await span(from - 2, to + 1) }; // the blocks either side of the gap bound its time
  const [{ np }] = await rows<{ np: string }>(`SELECT count() AS np FROM ev_prices WHERE block BETWEEN {a:UInt64} AND {b:UInt64} AND ${inSpan()}`, r);
  const pricedTo = Number(np) ? Number((await rows<{ m: string }>(`SELECT min(block) AS m FROM ev_prices WHERE block BETWEEN {a:UInt64} AND {b:UInt64} AND ${inSpan()}`, r))[0].m) - 1 : to;
  const old = await rows<Record<string, unknown>>(`SELECT * REPLACE (toString(amount) AS amount) FROM ev_trades WHERE block BETWEEN {a:UInt64} AND {b:UInt64} AND sign = 1 AND ${inSpan()}`, r);
  const dirty = (await rows<{ token: string }>(`SELECT DISTINCT token FROM ev_transfers WHERE block BETWEEN {a:UInt64} AND {b:UInt64} AND standard = 'erc20' AND ${inSpan()}`, r)).map((x) => x.token);
  log(`prices ${from}..${pricedTo} (${np} already from ${pricedTo + 1}); cancel ${old.length} trades; ${dirty.length} tokens to re-project`);
  if (o.dry) return left;
  await insert("ev_trades", old.map((t) => ({ ...t, sign: -1, keep: 0 })), `${tag}-cancel:${from}-${to}`);
  const unpriced: Parameters<typeof deriveTrades>[3] = [];
  const p = pricedTo >= from ? await derivePrices(from - 1, pricedTo, undefined, unpriced) : 0;
  const t = await deriveTrades(from - 1, to, undefined, unpriced);
  const [{ tip }] = await rows<{ tip: string }>("SELECT max(block) AS tip FROM ctl_cursors FINAL WHERE name = 'tip'");
  for (let i = 0; i < dirty.length; i += 500) await projectTokens(up, dirty.slice(i, i + 500), Number(tip), `${tag}:${tip}:${i}`);
  log(`prices +${p}, trades +${t}, cards ${dirty.length} at ${tip}`);
  return left;
}

/** Block gaps in raw_blocks over the last day, below the tip minus a margin (ingest's in-flight batches aren't gaps). */
export async function findGaps(margin = 1_000): Promise<{ from: number; to: number }[]> {
  const [{ tip }] = await rows<{ tip: string }>("SELECT max(block) AS tip FROM ctl_cursors FINAL WHERE name = 'tip'");
  return (await rows<{ f: string; t: string }>(
    `SELECT n AS f, nxt - 1 AS t FROM (SELECT number + 1 AS n, leadInFrame(number) OVER (ORDER BY number ROWS BETWEEN CURRENT ROW AND 1 FOLLOWING) AS nxt
       FROM raw_blocks WHERE time > now() - INTERVAL 1 DAY AND number <= {top:UInt64}) WHERE nxt > n ORDER BY n`,
    { top: Number(tip) - margin })).map((g) => ({ from: Number(g.f), to: Number(g.t) }));
}

const MAX_AUTO = 20_000; // ~35 min of chain: anything bigger is an outage to look at, not to refill unattended

/** Every 10 min: refill raw_blocks gaps of the last day (empty tables only, never deletes), then bump data_rev so the
 *  API's callers re-read the range. A partial or oversized gap is logged and left. */
export async function gapWorker(up: Client): Promise<never> {
  const done = new Set<string>(); // ponytail: a gap left for a person is logged once per process, not every round
  for (;;) {
    try {
      for (const g of await findGaps()) {
        const key = `${g.from}-${g.to}`, n = g.to - g.from + 1;
        if (done.has(key)) continue;
        if (n > MAX_AUTO) { console.warn(`[gaps] ${key} (${n} blocks) too big to refill unattended: tools/gap-refill.ts`); done.add(key); continue; }
        console.log(`[gaps] refilling ${key} (${n} blocks)`);
        const left = await refill(up, g.from, g.to, { dry: false, fixDoubles: false, log: (s) => console.log(`[gaps] ${s}`) });
        const [{ rev }] = await rows<{ rev: string }>("SELECT max(block) AS rev FROM ctl_cursors FINAL WHERE name = 'data_rev'");
        await ch.insert({ table: "ctl_cursors", format: "JSONEachRow",
          values: [{ name: "data_rev", block: Number(rev) + 1, hash: `auto refill ${key} ${new Date().toISOString().slice(0, 10)}`, version: Date.now() }] });
        if (left) { console.warn(`[gaps] ${key}: ${left} table(s) held a partial count, left for tools/gap-refill.ts`); done.add(key); }
      }
    } catch (e) { console.warn(`[gaps] ${(e as Error).message}`); }
    await new Promise((r) => setTimeout(r, 600_000));
  }
}
