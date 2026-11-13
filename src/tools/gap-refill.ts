// One-off: refill an ingest gap that `ingest backfill` can't (its batches' dedup tokens were already used: after a power
// loss the dedup log survived and the rows didn't, 2026-11-12). Per aligned batch: decode from the node as ingest does,
// and insert a table only where it holds no row of that batch. A batch stored exactly twice (its dedup missed, the copies
// already merged into one part) is deleted and inserted once; any other partial count is printed and left. Then the
// projector's prices (only where the range has none), trades (the range's old ones cancelled first) and the touched
// tokens' cards at the tip. DRY=1 (default) only prints. `node src/tools/gap-refill.ts FROM TO`
import { cfg } from "../config.ts";
import { ch, insert, inSpan, rows, span } from "../ch.ts";
import { upstream } from "../chain/upstream.ts";
import { decodeBlock, emptyRows, type Rows } from "../ingest/decode.ts";
import { learn, loadCtx } from "../ingest/keep.ts";
import { fetchRange } from "../ingest/main.ts";
import { derivePrices } from "../projector/prices.ts";
import { deriveTrades } from "../projector/trades.ts";
import { projectTokens } from "../projector/main.ts";

const [from, to] = process.argv.slice(2).map(Number), B = cfg.batchBlocks, dry = process.env.DRY !== "0";
const up = upstream(cfg.upstreamHttp), ctx = await loadCtx(cfg.launchWindowHours * 3600);
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
    if (have && have !== 2 * rs.length) { line.push(`${table} PARTIAL ${have}/${rs.length}`); continue; }
    line.push(have ? `${table} ×2→${rs.length}` : `${table} +${rs.length}`);
    if (have && !dry) await ch.command({ query: `DELETE FROM ${table} WHERE ${col} BETWEEN {a:UInt64} AND {b:UInt64}`, query_params: { a, b: a + B - 1 } });
    if (!dry) await insert(table, rs, `${a}-${a + B - 1}:${hash}:refill-20261113`);
  }
  console.log(`${a}-${a + B - 1} ${dry ? "(dry) " : ""}${line.join(", ")}`);
}
const r = { a: from, b: to, ...await span(from - 2, to + 1) }; // the blocks either side of the gap bound its time
const [{ np }] = await rows<{ np: string }>(`SELECT count() AS np FROM ev_prices WHERE block BETWEEN {a:UInt64} AND {b:UInt64} AND ${inSpan()}`, r);
const pricedTo = Number(np) ? Number((await rows<{ m: string }>(`SELECT min(block) AS m FROM ev_prices WHERE block BETWEEN {a:UInt64} AND {b:UInt64} AND ${inSpan()}`, r))[0].m) - 1 : to;
const old = await rows<Record<string, unknown>>(`SELECT * REPLACE (toString(amount) AS amount) FROM ev_trades WHERE block BETWEEN {a:UInt64} AND {b:UInt64} AND sign = 1 AND ${inSpan()}`, r);
const dirty = (await rows<{ token: string }>(`SELECT DISTINCT token FROM ev_transfers WHERE block BETWEEN {a:UInt64} AND {b:UInt64} AND standard = 'erc20' AND ${inSpan()}`, r)).map((x) => x.token);
console.log(`prices ${from}..${pricedTo} (${np} already from ${pricedTo + 1}); cancel ${old.length} trades; ${dirty.length} tokens to re-project`);
if (!dry) {
  await insert("ev_trades", old.map((t) => ({ ...t, sign: -1, keep: 0 })), `refill-cancel:${from}-${to}`);
  const unpriced: Parameters<typeof deriveTrades>[3] = [];
  const p = pricedTo >= from ? await derivePrices(from - 1, pricedTo, undefined, unpriced) : 0;
  const t = await deriveTrades(from - 1, to, undefined, unpriced);
  const [{ tip }] = await rows<{ tip: string }>("SELECT max(block) AS tip FROM ctl_cursors FINAL WHERE name = 'tip'");
  for (let i = 0; i < dirty.length; i += 500) await projectTokens(up, dirty.slice(i, i + 500), Number(tip), `refill:${tip}:${i}`);
  console.log(`prices +${p}, trades +${t}, cards ${dirty.length} at ${tip}`);
}
process.exit(0);
