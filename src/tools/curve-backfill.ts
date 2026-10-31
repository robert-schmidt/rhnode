// One-off (2026-10-31): curve trades from go-live up to when ingest started decoding them (migration 021), from the
// curve logs raw_logs still holds (RAW_TTL_DAYS). Each chunk: the logs → ev_swaps (decodeSwap, as ingest does), then
// curve-only prices and trades (the range's other swaps are priced and traded already); candles follow from ev_prices.
// Idempotent per chunk (dedup tokens). `node src/tools/curve-backfill.ts [from] [to]`; exits when done.
import { insert, inSpan, rows, span } from "../ch.ts";
import { decodeSwap, PONS_CURVE_BUY, PONS_CURVE_SELL } from "../chain/swaplog.ts";
import { derivePrices } from "../projector/prices.ts";
import { deriveTrades } from "../projector/trades.ts";

const CHUNK = 20_000; // ~35 min of chain
const [lo] = await rows<{ b: string }>("SELECT min(number) AS b FROM raw_blocks");
const [hi] = await rows<{ b: string }>("SELECT min(block) AS b FROM ev_swaps WHERE venue = 'curve'");
const from = Number(process.argv[2] ?? lo.b), to = Number(process.argv[3] ?? Number(hi.b) - 1);
console.log(`curve backfill ${from}..${to}`);
let swaps = 0, prices = 0, trades = 0;
const t0 = Date.now();
for (let b = from; b <= to; b += CHUNK) {
  const e = Math.min(to, b + CHUNK - 1), r = { from: b - 1, to: e, ...await span(b - 1, e), buy: PONS_CURVE_BUY, sell: PONS_CURVE_SELL };
  const logs = await rows<{ block: string; tx_index: number; log_index: number; tx_hash: string; time: string; address: string; topic0: string;
    topic1: string; topic2: string; data: string; keep: number; tx_from: string }>(
    `SELECT l.block, l.tx_index, l.log_index, l.tx_hash, l.time, l.address, l.topic0, l.topic1, l.topic2, l.data, l.keep, t.from AS tx_from
     FROM (SELECT * FROM raw_logs WHERE address IN (SELECT pool FROM pools FINAL WHERE venue = 'curve') AND topic0 IN ({buy:String}, {sell:String})
       AND block > {from:UInt64} AND block <= {to:UInt64} AND ${inSpan()} AND sign = 1) AS l
     INNER JOIN (SELECT block, tx_index, \`from\` FROM raw_txs WHERE block > {from:UInt64} AND block <= {to:UInt64} AND ${inSpan()} AND sign = 1) AS t
       ON t.block = l.block AND t.tx_index = l.tx_index`, r);
  const out = logs.flatMap((l) => {
    const s = decodeSwap({ address: l.address, topics: [l.topic0, l.topic1, l.topic2], data: l.data });
    return s ? [{ block: l.block, tx_index: l.tx_index, log_index: l.log_index, tx_hash: l.tx_hash, time: l.time, keep: l.keep, sign: 1,
      venue: s.venue, pool: s.pool, emitter: l.address, sender: s.sender, recipient: s.recipient ?? "", tx_from: l.tx_from,
      amount0: s.amount0.toString(), amount1: s.amount1.toString(), sqrt_price_x96: "0", liquidity: "0", tick: 0, fee: 0 }] : [];
  });
  await insert("ev_swaps", out, `curve-backfill:${b}-${e}`);
  swaps += out.length;
  prices += await derivePrices(b - 1, e, true);
  trades += await deriveTrades(b - 1, e, true);
  console.log(JSON.stringify({ to: e, swaps, prices, trades, s: Math.round((Date.now() - t0) / 1000) }));
}
process.exit(0);
