// 1-minute candles before go-live (2026-11-02), from the swaps the history pass keeps (kept_swaps): each swap priced by
// the live projector's own priceSwap, written to hist_prices, whose view (migration 032) adds it to agg_candles_1m with
// the live view's expression. kept_swaps is sorted by (pool, block, log_index), so it's read in 256 slices by the pool's
// first two hex digits, each in key order: one read of the range in all (~22 GiB for Sep–Oct, measured), and the same
// batches on a re-run, so a slice redone after a crash is dropped by the dedup tokens instead of counted twice.
// ETH/USD: per ETH_BUCKET blocks, the median of ≥ $100 ETH/USDG swaps in verified pools, carried forward (the live
// projector takes it per tick range). Runs in the "bulk" workload. ponytail: pools the projector never resolved (traded
// only before go-live: ~5% of the swaps, sampled) and token/token pools (bridged prices) get no candles here.
// `node src/tools/hist-candles.ts [from-date]` (default 2026-09-01) up to go-live; resumes at ctl_cursors 'hist_candles'.
import { createClient } from "@clickhouse/client";
import { cfg } from "../config.ts";
import { ch, insert, rows, workload } from "../ch.ts";
import { NATIVE_ETH, USDG, WETH } from "../chain/constants.ts";
import { priceSwap, QUOTE_DECIMALS, sides, type Swap } from "../projector/prices.ts";

const ETH_BUCKET = 1_000, FLUSH = 50_000;
type Row = Swap & { block: string; tx_index: number; log_index: number; tx_hash: string; time: string; pool: string; tx_from: string; verified: number };
const SWAP_COLS = `s.block, s.tx_index, s.log_index, s.tx_hash, s.time, s.venue, s.pool, toString(s.amount0) AS a0, toString(s.amount1) AS a1,
  toString(s.sqrt_price_x96) AS sqrt, s.tx_from, p.token0, p.token1, p.verified`;

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

  // ETH/USD per bucket, from the verified ETH/USDG pools (a few pools: key lookups)
  const ethPools = (await rows<{ pool: string }>(
    `SELECT pool FROM pools FINAL WHERE verified = 1 AND ok = 1 AND ((token0 IN {e:Array(String)} AND token1 = {u:String}) OR (token1 IN {e:Array(String)} AND token0 = {u:String}))`,
    { e: [WETH, NATIVE_ETH], u: USDG })).map((p) => p.pool);
  const byBucket = new Map<number, number[]>();
  for (const s of await rows<Row>(
    `SELECT ${SWAP_COLS} FROM kept_swaps AS s FINAL INNER JOIN (SELECT pool, token0, token1, verified FROM pools FINAL WHERE pool IN {p:Array(String)}) AS p USING pool
     WHERE s.pool IN {p:Array(String)} AND s.time >= toDateTime({from:UInt32}) - INTERVAL 1 DAY AND s.block < {g:UInt64} AND s.sign = 1`, { ...r, p: ethPools })) {
    const p = priceSwap(s, 18, 1);
    if (!p || p.quote !== USDG || p.quoteAmount < 100) continue;
    const b = Math.floor(Number(s.block) / ETH_BUCKET);
    (byBucket.get(b) ?? byBucket.set(b, []).get(b)!).push(p.price);
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
    const rs = await long.query({
      query: `SELECT ${SWAP_COLS} FROM kept_swaps AS s FINAL
        INNER JOIN (SELECT pool, token0, token1, verified FROM pools FINAL WHERE pool LIKE {like:String} AND ok = 1) AS p USING pool
        WHERE s.pool LIKE {like:String} AND s.time >= toDateTime({from:UInt32}) AND s.block < {g:UInt64} AND s.sign = 1
        ORDER BY s.pool, s.block, s.log_index`,
      query_params: { ...r, like: `${pre}%` }, format: "JSONEachRow",
    });
    for await (const chunk of rs.stream()) {
      for (const row of chunk) buf.push(row.json<Row>());
      if (buf.length >= FLUSH) await flush();
    }
    if (buf.length) await flush();
    await ch.insert({ table: "ctl_cursors", values: [{ name: "hist_candles", block: i + 1, hash: fromDate, version: Date.now() }], format: "JSONEachRow" });
    console.log(JSON.stringify({ at: new Date().toISOString(), slice: pre, swaps, priced, s: Math.round((Date.now() - t0) / 1000) }));
  }
  console.log(`[hist-candles] done: ${swaps} swaps, ${priced} priced, ${Math.round((Date.now() - t0) / 1000)} s`);
}

if (import.meta.main) {
  await workload.run("bulk", () => main(process.argv[2] ?? "2026-09-01"));
  process.exit(0); // own exit: open sockets would keep a one-off alive
}
