// One-off (2026-10-31): a venue's trades for the blocks the history pass walked before ingest's decoder knew it (curves:
// migration 021; Metric OMM: 023; PancakeSwap v3's event: the same deploy): go-live down to where the pass was at that deploy. Per 100K blocks one topic-filtered eth_getLogs on
// our node (~15 s, measured 2026-10-31), the signer of each tx (the decoder's tx_from), then hist_swaps → kept_swaps
// forever, as the pass writes them. kept_swaps replaces by (pool, block, log_index), so overlapping the pass is harmless.
// `node src/tools/venue-repass.ts <curve|omm|pancake>[,…] <from> <to>`; exits when done.
import { cfg } from "../config.ts";
import { insert } from "../ch.ts";
import { upstream } from "../chain/upstream.ts";
import { decodeSwap, PONS_CURVE_BUY, PONS_CURVE_SELL, SWAP_METRIC, SWAP_PANCAKE_V3 } from "../chain/swaplog.ts";

type Log = { address: string; topics: string[]; data: string; blockNumber: string; transactionIndex: string; logIndex: string; transactionHash: string; blockTimestamp: string };
const up = upstream(cfg.upstreamHttp, { attempts: 4, timeoutMs: 300_000, ordered: true });
const hex = (n: number) => "0x" + n.toString(16);
const TOPICS = { curve: [PONS_CURVE_BUY, PONS_CURVE_SELL], omm: [SWAP_METRIC], pancake: [SWAP_PANCAKE_V3] } as const;
// several at once (omm,pancake): one scan of the node
const venue = process.argv[2] ?? "", keys = venue.split(",") as (keyof typeof TOPICS)[], topics = keys.flatMap((v) => TOPICS[v] ?? []);
const [from, to] = [Number(process.argv[3]), Number(process.argv[4])];
if (!keys.every((k) => TOPICS[k]) || !(from > 0 && to >= from)) throw new Error("usage: venue-repass.ts <curve|omm|pancake> <from> <to>");
const CHUNK = 100_000, PAR = 32;
let swaps = 0;
const t0 = Date.now();
for (let e = to; e >= from; e -= CHUNK) { // newest first, like the pass
  const b = Math.max(from, e - CHUNK + 1);
  const logs = await up.call<Log[]>("eth_getLogs", [{ fromBlock: hex(b), toBlock: hex(e), topics: [[...topics]] }]);
  const txs = [...new Set(logs.map((l) => l.transactionHash.toLowerCase()))], signer = new Map<string, string>();
  for (let i = 0; i < txs.length; i += PAR) {
    await Promise.all(txs.slice(i, i + PAR).map(async (h) => {
      const t = await up.call<{ from: string }>("eth_getTransactionByHash", [h]);
      signer.set(h, t.from.toLowerCase());
    }));
  }
  const out = logs.flatMap((l) => {
    const s = decodeSwap({ address: l.address, topics: l.topics, data: l.data }), h = l.transactionHash.toLowerCase();
    return s ? [{ block: Number(l.blockNumber), tx_index: Number(l.transactionIndex), log_index: Number(l.logIndex), tx_hash: h,
      time: Number(l.blockTimestamp), keep: 0, sign: 1, venue: s.venue, pool: s.pool, emitter: l.address.toLowerCase(), sender: s.sender,
      recipient: s.recipient ?? "", tx_from: signer.get(h)!, amount0: s.amount0.toString(), amount1: s.amount1.toString(),
      sqrt_price_x96: "0", liquidity: "0", tick: 0, fee: 0 }] : [];
  });
  await insert("hist_swaps", out, `${venue.replace(",", "+")}-repass:${b}-${e}`);
  swaps += out.length;
  console.log(JSON.stringify({ at: new Date().toISOString(), from: b, swaps, s: Math.round((Date.now() - t0) / 1000) }));
}
process.exit(0);
