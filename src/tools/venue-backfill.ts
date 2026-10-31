// One-off (2026-10-31): a venue's trades from go-live up to when ingest started decoding it (curves: migration 021; Metric
// OMM: 023), from the logs raw_logs still holds (RAW_TTL_DAYS). Each chunk: the logs → ev_swaps (decodeSwap, as ingest
// does), the pools the projector hasn't resolved (OMM's come from the pools themselves; curves' from their launch), then
// that venue's prices and trades (the range's other swaps are priced and traded already); candles follow from ev_prices.
// Idempotent per chunk (dedup tokens). `node src/tools/venue-backfill.ts <curve|omm> [from] [to]`; exits when done.
import { cfg } from "../config.ts";
import { insert, inSpan, rows, span } from "../ch.ts";
import { upstream } from "../chain/upstream.ts";
import { decodeSwap, PONS_CURVE_BUY, PONS_CURVE_SELL, SWAP_METRIC } from "../chain/swaplog.ts";
import { resolvePools } from "../projector/pools.ts";
import { derivePrices } from "../projector/prices.ts";
import { deriveTrades } from "../projector/trades.ts";

const VENUES = {
  curve: { topics: [PONS_CURVE_BUY, PONS_CURVE_SELL], emitters: "AND address IN (SELECT pool FROM pools FINAL WHERE venue = 'curve')" },
  omm: { topics: [SWAP_METRIC], emitters: "" },
} as const;
const venue = process.argv[2] as keyof typeof VENUES, v = VENUES[venue];
if (!v) throw new Error("usage: venue-backfill.ts <curve|omm> [from] [to]");
const up = upstream(cfg.upstreamHttp, { attempts: 4, timeoutMs: 60_000 });
const CHUNK = 20_000; // ~35 min of chain
const [lo] = await rows<{ b: string }>("SELECT min(number) AS b FROM raw_blocks");
const [hi] = await rows<{ b: string }>("SELECT min(block) AS b FROM ev_swaps WHERE venue = {v:String}", { v: venue });
const from = Number(process.argv[3] ?? lo.b), to = Number(process.argv[4] ?? Number(hi.b) - 1);
console.log(`${venue} backfill ${from}..${to}`);
let swaps = 0, prices = 0, trades = 0;
const t0 = Date.now();
for (let b = from; b <= to; b += CHUNK) {
  const e = Math.min(to, b + CHUNK - 1), r = { from: b - 1, to: e, ...await span(b - 1, e), topics: v.topics };
  const logs = await rows<{ block: string; tx_index: number; log_index: number; tx_hash: string; time: string; address: string; topic0: string;
    topic1: string; topic2: string; data: string; keep: number; tx_from: string }>(
    `SELECT l.block, l.tx_index, l.log_index, l.tx_hash, l.time, l.address, l.topic0, l.topic1, l.topic2, l.data, l.keep, t.from AS tx_from
     FROM (SELECT * FROM raw_logs WHERE topic0 IN {topics:Array(String)} ${v.emitters}
       AND block > {from:UInt64} AND block <= {to:UInt64} AND ${inSpan()} AND sign = 1) AS l
     INNER JOIN (SELECT block, tx_index, \`from\` FROM raw_txs WHERE block > {from:UInt64} AND block <= {to:UInt64} AND ${inSpan()} AND sign = 1) AS t
       ON t.block = l.block AND t.tx_index = l.tx_index`, r);
  const out = logs.flatMap((l) => {
    const s = decodeSwap({ address: l.address, topics: [l.topic0, l.topic1, l.topic2], data: l.data });
    return s ? [{ block: l.block, tx_index: l.tx_index, log_index: l.log_index, tx_hash: l.tx_hash, time: l.time, keep: l.keep, sign: 1,
      venue: s.venue, pool: s.pool, emitter: l.address, sender: s.sender, recipient: s.recipient ?? "", tx_from: l.tx_from,
      amount0: s.amount0.toString(), amount1: s.amount1.toString(), sqrt_price_x96: "0", liquidity: "0", tick: 0, fee: 0 }] : [];
  });
  await insert("ev_swaps", out, `${venue}-backfill:${b}-${e}`);
  if (venue === "omm") await resolvePools(up, up, b - 1, e);
  swaps += out.length;
  prices += await derivePrices(b - 1, e, venue);
  trades += await deriveTrades(b - 1, e, venue);
  console.log(JSON.stringify({ to: e, swaps, prices, trades, s: Math.round((Date.now() - t0) / 1000) }));
}
process.exit(0);
