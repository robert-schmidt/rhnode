// One-off (2026-11-03): the Relay fills on the proxy path (chain/relay.ts proxyFillOf) from the proxy's first tx up to
// ingest's deploy of proxyFillOf (core 3cb6400), which decodes them from then on. The txs come from idx_wallet_txs (every
// tx that named the proxy: the history pass below go-live, the live view above), their receipts from our node.
// - from go-live: ev_relay (→ kept_relay when keep != 0, as ingest writes it) and the fill's buy in ev_trades, as the
//   projector derives it (recipient, amount, usd = USDG + WETH × ETH/USD); keep is the tx's, from raw_txs;
// - before go-live: hist_relay (→ kept_relay forever, as the history pass writes it), and the buy in hist_trades for
//   the blocks hist_trades covers (the week before go-live).
// ETH/USD: per chunk, the last 1-minute close of WETH/ETH against USDG in agg_candles_1m before its last fill.
// Idempotent per chunk (dedup tokens by block range). `node src/tools/relay-proxy-backfill.ts <goLive> <to> [from]`; exits when done. `to` must be the
// last block before ingest decoded the proxy path: an overlap would count those buys twice in agg_wallet_token.
import { cfg } from "../config.ts";
import { insert, rows, workload } from "../ch.ts";
import { NATIVE_ETH, USDG, WETH } from "../chain/constants.ts";
import { upstream } from "../chain/upstream.ts";
import { proxyFillOf, RELAY_PROXY } from "../chain/relay.ts";
import { KEEP } from "../ingest/keep.ts";

type Receipt = { transactionHash: string; status: string; logs: { address: string; topics: string[]; data: string }[] };
type Tx = { block: number; tx_index: number; hash: string; time: number; keep: number };
const up = upstream(cfg.upstreamHttp, { attempts: 4, timeoutMs: 120_000, ordered: true });
const [goLive, to] = [Number(process.argv[2]), Number(process.argv[3])];
if (!(goLive > 0 && to > goLive)) throw new Error("usage: relay-proxy-backfill.ts <goLive> <to>");
const CHUNK = 100_000, PAR = 16;
const hex = (n: number) => "0x" + n.toString(16);

async function pool<T, R>(xs: T[], f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0;
  await Promise.all(Array.from({ length: PAR }, async () => { while (i < xs.length) { const k = i++; out[k] = await f(xs[k]); } }));
  return out;
}

await workload.run("bulk", async () => {
  const [h] = await rows<{ b: string }>("SELECT toString(min(block)) AS b FROM hist_trades");
  const histFrom = Number(h?.b || goLive);
  const [f0] = await rows<{ b: string }>("SELECT toString(min(block)) AS b FROM idx_wallet_txs WHERE wallet = {p:String}", { p: RELAY_PROXY });
  const sum = { txs: 0, fills: 0, trades: 0 }, t0 = Date.now();
  for (let a = Number(process.argv[4] ?? f0.b); a <= to; a += CHUNK) {
    const b = Math.min(to, a + CHUNK - 1);
    const ix = await rows<{ bk: string; tx_index: number }>(
      "SELECT toString(block) AS bk, tx_index FROM idx_wallet_txs WHERE wallet = {p:String} AND block BETWEEN {a:UInt64} AND {b:UInt64} ORDER BY block, tx_index",
      { p: RELAY_PROXY, a, b });
    if (!ix.length) continue;
    // hash, time, keep: raw_txs from go-live (14 days), else the node
    const live = new Map((a >= goLive || b >= goLive ? await rows<{ bk: string; tx_index: number; h: string; ts: number; keep: number }>(
      `SELECT toString(block) AS bk, tx_index, toString(hash) AS h, toUnixTimestamp(time) AS ts, keep FROM raw_txs
       WHERE to = {p:String} AND block BETWEEN {a:UInt64} AND {b:UInt64} AND sign = 1`, { p: RELAY_PROXY, a, b }) : []).map((r) => [`${r.bk}.${r.tx_index}`, r]));
    const times = new Map<number, number>();
    const txs: Tx[] = await pool(ix, async (r) => {
      const n = Number(r.bk), l = live.get(`${r.bk}.${r.tx_index}`);
      if (l) return { block: n, tx_index: r.tx_index, hash: l.h, time: l.ts, keep: l.keep };
      const t = await up.call<{ hash: string }>("eth_getTransactionByBlockNumberAndIndex", [hex(n), hex(r.tx_index)]);
      if (!times.has(n)) times.set(n, parseInt((await up.call<{ timestamp: string }>("eth_getBlockByNumber", [hex(n), false])).timestamp, 16));
      return { block: n, tx_index: r.tx_index, hash: t.hash.toLowerCase(), time: times.get(n)!, keep: KEEP.RELAY };
    });
    const rcs = await pool(txs, (t) => up.call<Receipt>("eth_getTransactionReceipt", [t.hash]));
    const relay: Record<string, unknown>[] = [], fillsAt: (Tx & { f: NonNullable<ReturnType<typeof proxyFillOf>> })[] = [];
    txs.forEach((t, i) => {
      const f = rcs[i]?.status === "0x1" ? proxyFillOf(t.hash, rcs[i].logs) : null;
      if (!f) return;
      fillsAt.push({ ...t, f });
      relay.push({ block: t.block, tx_index: t.tx_index, tx_hash: t.hash, time: t.time, recipient: f.recipient, token: f.token,
        amount: f.raw.toString(), usdg_in: f.usdgIn.toString(), weth_in: f.wethIn.toString(), keep: t.keep, sign: 1 });
    });
    const [e] = fillsAt.length ? await rows<{ p: number }>(
      `SELECT argMaxMerge(close_usd) AS p FROM agg_candles_1m WHERE token IN ({w:String}, {n:String}) AND quote = {u:String}
       AND minute <= toDateTime({t:UInt32}) AND minute >= toDateTime({t:UInt32}) - INTERVAL 1 DAY`, { w: WETH, n: NATIVE_ETH, u: USDG, t: fillsAt[fillsAt.length - 1].time }) : [];
    const ethUsd = Number(e?.p ?? 0);
    const trade = (x: (typeof fillsAt)[0]) => { const eth = Number(x.f.wethIn) / 1e18;
      return { block: x.block, tx_index: x.tx_index, tx_hash: x.hash, time: x.time, wallet: x.f.recipient, token: x.f.token, side: "buy",
        amount: x.f.raw.toString(), usd: Number(x.f.usdgIn) / 1e6 + eth * ethUsd, eth, priced: ethUsd > 0 || x.f.usdgIn > 0n ? 1 : 0, via: "relay", keep: x.keep, sign: 1 }; };
    const above = (x: { block: number }) => x.block >= goLive;
    const [rA, rB] = [relay.filter((r) => (r.block as number) >= goLive), relay.filter((r) => (r.block as number) < goLive)];
    const [tA, tB] = [fillsAt.filter(above).map(trade), fillsAt.filter((x) => !above(x) && x.block >= histFrom).map(trade)];
    const tag = `relayproxy:${a}-${b}`;
    await insert("ev_relay", rA, `${tag}:relay`); await insert("hist_relay", rB, `${tag}:hrelay`);
    await insert("ev_trades", tA, `${tag}:trades`); await insert("hist_trades", tB, `${tag}:htrades`);
    sum.txs += txs.length; sum.fills += relay.length; sum.trades += tA.length + tB.length;
    console.log(JSON.stringify({ at: new Date().toISOString(), from: a, to: b, txs: txs.length, fills: relay.length, live: rA.length, hist: rB.length, trades: tA.length + tB.length, ethUsd, s: Math.round((Date.now() - t0) / 1000) }));
  }
  console.log(JSON.stringify({ done: true, ...sum, histFrom, s: Math.round((Date.now() - t0) / 1000) }));
});
process.exit(0);
