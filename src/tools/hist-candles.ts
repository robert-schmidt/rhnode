// 1-minute candles before go-live (2026-11-02), from the swaps the history pass keeps (kept_swaps): each swap priced by
// the live projector's own priceSwap, written to hist_prices, whose view (migration 032) adds it to agg_candles_1m with
// the live view's expression. kept_swaps is sorted by (pool, block, log_index), so it's read in 256 slices by the pool's
// first two hex digits, each in key order: one read of the range in all (~22 GiB for Sep–Oct, measured), and the same
// batches on a re-run, so a slice redone after a crash is dropped by the dedup tokens instead of counted twice.
// ETH/USD: per ETH_BUCKET blocks, the median of ≥ $100 ETH/USDG swaps in verified pools, carried forward (the live
// projector takes it per tick range). Runs in the "bulk" workload. Token/token pools and pools resolved after that run
// got no candles in it: `--missing` adds them, the pools with swaps before go-live and no candle before it, a
// pool batch at a time, token/token pools priced through bridges (hist-trades.ts loadBridges), ETH/USD from the candles.
// `node src/tools/hist-candles.ts [--missing|--fix] [from-date]` (default 2026-09-01) up to go-live; the full run resumes at
// ctl_cursors 'hist_candles', --missing by leaving out the pools that have candles by then. `--fix` re-prices only the
// (pool, minute)s listed in table hist_fix into hist_fix_prices (both made by hand, rows like hist_prices), to be checked
// and then swapped in: the runs before the tick-limit rule (prices.ts LIMIT_TICK) left 8,699 minutes at 1e41..1e50 USD.
import { createClient } from "@clickhouse/client";
import { cfg } from "../config.ts";
import { ch, insert, rows, workload } from "../ch.ts";
import { NATIVE_ETH, USDG, WETH } from "../chain/constants.ts";
import { priceSwap, QUOTE_DECIMALS, sides, type Swap } from "../projector/prices.ts";
import { atOrBefore, loadBridges } from "./hist-trades.ts";

const ETH_BUCKET = 1_000, FLUSH = 50_000;
type Row = Swap & { block: string; tx_index: number; log_index: number; tx_hash: string; time: string; pool: string; tx_from: string; verified: number };
// No JOIN to pools in the swap reads: with one, ClickHouse sorts the whole result instead of reading in key order
// (3.4 GiB and killed at 13.5M rows of one pool; without, the pool's 34M rows take 954 MiB, 2026-11-02). Pools are
// fetched apart and attached here.
const SWAP_COLS = `s.block, s.tx_index, s.log_index, s.tx_hash, s.time, s.venue, s.pool, toString(s.amount0) AS a0, toString(s.amount1) AS a1,
  toString(s.sqrt_price_x96) AS sqrt, s.tx_from`;
type PoolRow = { pool: string; token0: string; token1: string; verified: number };

/** PURE. ETH/USD at a block: the last bucket at or before it that has a median (the first one before any). */
export function ethUsdAt(keys: number[], med: Map<number, number>, block: number): number | null {
  const b = Math.floor(block / ETH_BUCKET);
  let lo = 0, hi = keys.length - 1, at = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (keys[m] <= b) { at = m; lo = m + 1; } else hi = m - 1; }
  return keys.length ? med.get(keys[Math.max(0, at)])! : null;
}

async function main(fromDate: string) {
  const from = Math.floor(Date.parse(`${fromDate}T00:00:00Z`) / 1000);
  const [g] = await rows<{ block: string }>("SELECT block FROM ctl_cursors FINAL WHERE name = 'golive'");
  const golive = Number(g.block), r = { from, g: golive };
  // A long read streams for minutes: its own client, so the shared one's 60 s timeout doesn't cut it.
  const long = createClient({ ...cfg.clickhouse, request_timeout: 3_600_000, clickhouse_settings: { workload: "bulk" } });

  // ETH/USD per bucket, from the verified ETH/USDG pools (814 on 2026-11-01). One pool at a time, in key order: all of
  // them in one FINAL read took 4.7 GiB and hit the server's cap; the busiest alone is 530 MiB, 7.7 s (2026-11-01).
  const ethPools = await rows<PoolRow>(
    `SELECT pool, token0, token1, verified FROM pools FINAL WHERE verified = 1 AND ok = 1 AND ((token0 IN {e:Array(String)} AND token1 = {u:String}) OR (token1 IN {e:Array(String)} AND token0 = {u:String}))`,
    { e: [WETH, NATIVE_ETH], u: USDG });
  const byBucket = new Map<number, number[]>();
  for (const pool of ethPools) {
    const rs = await long.query({
      query: `SELECT ${SWAP_COLS} FROM kept_swaps AS s FINAL
        WHERE s.pool = {p:String} AND s.time >= toDateTime({from:UInt32}) - INTERVAL 1 DAY AND s.block < {g:UInt64} AND s.sign = 1 ORDER BY s.block, s.log_index`,
      query_params: { ...r, p: pool.pool }, format: "JSONEachRow",
    });
    for await (const chunk of rs.stream()) for (const row of chunk) {
      const s = { ...row.json<Row>(), ...pool }, p = priceSwap(s, 18, 1);
      if (!p || p.quote !== USDG || p.quoteAmount < 100) continue;
      const b = Math.floor(Number(s.block) / ETH_BUCKET);
      (byBucket.get(b) ?? byBucket.set(b, []).get(b)!).push(p.price);
    }
  }
  const med = new Map([...byBucket].map(([b, ps]) => [b, ps.sort((x, y) => x - y)[Math.floor(ps.length / 2)]]));
  const keys = [...med.keys()].sort((a, b) => a - b);
  console.log(`[hist-candles] ${fromDate} (${from}) .. go-live ${golive}; ETH/USD in ${keys.length} buckets from ${ethPools.length} pools`);

  const decimals = new Map<string, number>(Object.entries(QUOTE_DECIMALS));
  const [c] = await rows<{ block: string; hash: string }>("SELECT block, hash FROM ctl_cursors FINAL WHERE name = 'hist_candles'");
  const start = c?.hash === fromDate ? Number(c.block) : 0;
  let swaps = 0, priced = 0;
  const t0 = Date.now();
  for (let i = start; i < 256; i++) {
    const pre = `0x${i.toString(16).padStart(2, "0")}`;
    let buf: Row[] = [], n = 0;
    const flush = async () => {
      const toks = [...new Set(buf.flatMap((s) => [s.token0, s.token1]))].filter((t) => !decimals.has(t));
      if (toks.length) for (const d of await rows<{ token: string; decimals: number }>(
        "SELECT token, decimals FROM serve_tokens FINAL WHERE token IN {t:Array(String)}", { t: toks })) decimals.set(d.token, d.decimals);
      const out = [];
      for (const s of buf) {
        const eth = ethUsdAt(keys, med, Number(s.block));
        const p = priceSwap(s, decimals.get(sides(s.token0, s.token1)?.token ?? ""), eth);
        if (!p) continue;
        out.push({
          block: s.block, tx_index: s.tx_index, log_index: s.log_index, tx_hash: s.tx_hash, time: s.time, pool: s.pool, venue: s.venue,
          token: p.token, quote: p.quote, token_delta: p.tokenDelta.toString(), quote_delta: p.quoteDelta.toString(),
          quote_amount: p.quoteAmount, usd: p.usd, price: p.price, price_usd: p.priceUsd, eth_usd: eth ?? 0,
          tx_from: s.tx_from, verified: s.verified, sign: 1,
        });
      }
      await insert("hist_prices", out, `hist-candles:${fromDate}:${pre}:${n++}`);
      swaps += buf.length; priced += out.length; buf = [];
    };
    const pools = new Map((await rows<PoolRow>(
      "SELECT pool, token0, token1, verified FROM pools FINAL WHERE pool LIKE {like:String} AND ok = 1", { like: `${pre}%` })).map((p) => [p.pool, p]));
    const rs = await long.query({
      query: `SELECT ${SWAP_COLS} FROM kept_swaps AS s FINAL
        WHERE s.pool LIKE {like:String} AND s.time >= toDateTime({from:UInt32}) AND s.block < {g:UInt64} AND s.sign = 1
        ORDER BY s.pool, s.block, s.log_index`,
      query_params: { ...r, like: `${pre}%` }, format: "JSONEachRow",
    });
    for await (const chunk of rs.stream()) {
      for (const row of chunk) { const s = row.json<Row>(), p = pools.get(s.pool); if (p) buf.push({ ...s, ...p }); }
      if (buf.length >= FLUSH) await flush();
    }
    if (buf.length) await flush();
    await ch.insert({ table: "ctl_cursors", values: [{ name: "hist_candles", block: i + 1, hash: fromDate, version: Date.now() }], format: "JSONEachRow" });
    console.log(JSON.stringify({ at: new Date().toISOString(), slice: pre, swaps, priced, s: Math.round((Date.now() - t0) / 1000) }));
  }
  console.log(`[hist-candles] done: ${swaps} swaps, ${priced} priced, ${Math.round((Date.now() - t0) / 1000)} s`);
}

/** The pools left out of the full run: 1,000 at a time, each batch's swaps of the whole range read once in key order.
 *  Resumable: a pool done has candles, so a re-run leaves it out. ponytail: a run stopped inside a batch leaves that
 *  batch's later chunks out for good (their pools have candles by then); re-run with a fresh hist_prices pass if it matters. */
async function missing(fromDate: string, fix = false) {
  const from = Math.floor(Date.parse(`${fromDate}T00:00:00Z`) / 1000);
  const [g] = await rows<{ block: string }>("SELECT block FROM ctl_cursors FINAL WHERE name = 'golive'");
  const [gt] = await rows<{ t: number }>("SELECT toUnixTimestamp(min(time)) AS t FROM ev_swaps WHERE block >= {g:UInt64} AND block < {g:UInt64} + 1000", { g: g.block });
  const golive = Number(gt.t), r = { from, g: g.block, gt: golive };
  const traded = await rows<{ pool: string }>(fix ? "SELECT DISTINCT pool FROM hist_fix"
    : "SELECT DISTINCT pool FROM kept_swaps WHERE time >= toDateTime({from:UInt32}) AND block < {g:UInt64} AND venue != 'curve'", r);
  const candled = new Set(fix ? [] : (await rows<{ pool: string }>(
    "SELECT DISTINCT pool FROM agg_candles_1m WHERE minute >= toDateTime({from:UInt32}) AND minute < toDateTime({gt:UInt32})", r)).map((x) => x.pool));
  const only = fix ? "AND (s.pool, toStartOfMinute(s.time)) IN (SELECT pool, minute FROM hist_fix)" : "", into = fix ? "hist_fix_prices" : "hist_prices";
  const tag = fix ? "hist-candles-fix" : "hist-candles-missing";
  const want = traded.map((x) => x.pool).filter((x) => !candled.has(x));
  const pools = new Map<string, PoolRow>();
  for (let i = 0; i < want.length; i += 1_000)
    for (const p of await rows<PoolRow>("SELECT pool, token0, token1, verified FROM pools FINAL WHERE ok = 1 AND pool IN {p:Array(String)}", { p: want.slice(i, i + 1_000) }))
      if (!(p.token0 in QUOTE_DECIMALS && p.token1 in QUOTE_DECIMALS)) pools.set(p.pool, p);
  const decimals = new Map<string, number>(Object.entries(QUOTE_DECIMALS));
  const toks = [...new Set([...pools.values()].flatMap((p) => [p.token0, p.token1]))].filter((t) => !decimals.has(t));
  for (let i = 0; i < toks.length; i += 1_000)
    for (const d of await rows<{ token: string; decimals: number }>("SELECT token, decimals FROM serve_tokens FINAL WHERE decimals >= 0 AND token IN {t:Array(String)}", { t: toks.slice(i, i + 1_000) }))
      decimals.set(d.token, d.decimals);
  const isBridged = (p: PoolRow) => !(p.token0 in QUOTE_DECIMALS) && !(p.token1 in QUOTE_DECIMALS);
  const ids = [...pools.keys()].sort();
  console.log(`[hist-candles --missing] ${traded.length} pools traded before go-live, ${want.length} without candles, ${pools.size} resolved to price`);
  const eth = new Map((await rows<{ m: number; c: number }>(
    `SELECT toUnixTimestamp(minute) AS m, argMax(c, v) AS c FROM (SELECT minute, pool, argMaxMerge(close) AS c, sum(volume_usd) AS v FROM agg_candles_1m
     WHERE token IN ({w:String}, {n:String}) AND quote = {u:String} AND minute >= toDateTime({from:UInt32}) - INTERVAL 1 DAY AND minute < toDateTime({gt:UInt32})
     GROUP BY minute, pool) GROUP BY m`, { ...r, w: WETH, n: NATIVE_ETH, u: USDG })).map((x) => [Number(x.m), Number(x.c)]));
  const ek = [...eth.keys()].sort((a, b) => a - b);
  const long = createClient({ ...cfg.clickhouse, request_timeout: 3_600_000, clickhouse_settings: { workload: "bulk", max_threads: 2 } });
  let swaps = 0, priced = 0;
  const t0 = Date.now();
  for (let i = 0; i < ids.length; i += 1_000) {
    const batch = ids.slice(i, i + 1_000);
    const bt = [...new Set(batch.flatMap((id) => { const p = pools.get(id)!; return isBridged(p) ? [p.token0, p.token1] : []; }))].filter((t) => decimals.has(t));
    const { bridgesAt } = await loadBridges(bt, from, golive, decimals);
    const rs = await long.query({
      query: `SELECT ${SWAP_COLS}, toUnixTimestamp(s.time) AS ts FROM kept_swaps AS s FINAL
        WHERE s.pool IN {p:Array(String)} AND s.time >= toDateTime({from:UInt32}) AND s.block < {g:UInt64} AND s.sign = 1 ${only}
        ORDER BY s.pool, s.block, s.log_index`,
      query_params: { ...r, p: batch }, format: "JSONEachRow",
    });
    let out: object[] = [], n = 0;
    for await (const chunk of rs.stream()) {
      for (const row of chunk) {
        const w = row.json<Row & { ts: number }>(), s = { ...w, ...pools.get(w.pool)! }, ts = Number(w.ts);
        const br = isBridged(s) ? bridgesAt(ts, s) : undefined;
        const e1 = atOrBefore(ek, eth, ts - (ts % 60)), p = priceSwap(s, decimals.get(sides(s.token0, s.token1, br)?.token ?? ""), e1, br);
        swaps++;
        if (!p) continue;
        out.push({
          block: s.block, tx_index: s.tx_index, log_index: s.log_index, tx_hash: s.tx_hash, time: s.time, pool: s.pool, venue: s.venue,
          token: p.token, quote: p.quote, token_delta: p.tokenDelta.toString(), quote_delta: p.quoteDelta.toString(),
          quote_amount: p.quoteAmount, usd: p.usd, price: p.price, price_usd: p.priceUsd, eth_usd: e1 ?? 0,
          tx_from: s.tx_from, verified: s.verified, sign: 1,
        });
      }
      if (out.length >= FLUSH) { await insert(into, out, `${tag}:${fromDate}:${batch[0]}:${n++}`); priced += out.length; out = []; }
    }
    if (out.length) { await insert(into, out, `${tag}:${fromDate}:${batch[0]}:${n++}`); priced += out.length; }
    console.log(JSON.stringify({ at: new Date().toISOString(), pools: Math.min(i + 1_000, ids.length), of: ids.length, bridgeTokens: bt.length, swaps, priced, s: Math.round((Date.now() - t0) / 1000) }));
  }
  console.log(`[hist-candles --missing] done: ${swaps} swaps, ${priced} priced, ${Math.round((Date.now() - t0) / 1000)} s`);
}

if (import.meta.main) {
  const args = process.argv.slice(2), fix = args[0] === "--fix", miss = fix || args[0] === "--missing", date = (miss ? args[1] : args[0]) ?? "2026-09-01";
  await workload.run("bulk", () => (miss ? missing(date, fix) : main(date)));
  process.exit(0); // own exit: open sockets would keep a one-off alive
}
