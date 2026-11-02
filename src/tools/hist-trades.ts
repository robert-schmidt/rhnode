// Trades before go-live (2026-11-02), from the kept history: each tx's swaps priced with the live projector's priceSwap,
// attributed with its tradesOfTx (signer or userOp sender, a priced swap and a net balance change) plus Relay fill
// recipients, as deriveTrades does. Into hist_trades (migration 033), which /v1/trades reads with ev_trades.
// Swaps and ERC-20 transfers are each read ONCE for the window, sorted by (block, tx_index, log_index) with the sort
// spilled to disk, and joined per tx here: neither table's key starts with time, so per-window reads would rescan the
// month's partition every time (a 6-hour window: 8.4 GiB, 40 s, 2026-11-02). Each table is read with its 14-day twin
// (kept_ holds rows past go-live only for watched wallets) and a not-yet-merged duplicate is dropped in order.
// ETH/USD per minute: the close of the busiest WETH/ETH-USDG pool in agg_candles_1m, carried forward. A token/token
// pool is priced through a bridge as the projector does (prices.ts): the quote side's USD close per minute from its
// busiest verified quote pool in agg_candles_1m (≥ $100 that minute), carried forward up to a day. Swaps still without
// a price give trades with priced = 0. v2/v3 pools never resolved are resolved first (eth_call on the node, checked
// against their factory); v4 and curve pools created before the history pass's floor come with the pass.
// `node src/tools/hist-trades.ts <from> <to>` (unix seconds; inserts only below go-live). DRY=1: print the trades'
// keys instead (block.tx_index.wallet.token.side.via), for a parity check against ev_trades on a window after go-live.
import { createClient } from "@clickhouse/client";
import { cfg } from "../config.ts";
import { insert, rows, workload } from "../ch.ts";
import { NATIVE_ETH, USDG, WETH } from "../chain/constants.ts";
import { upstream } from "../chain/upstream.ts";
import { resolveV23 } from "../projector/pools.ts";
import { priceSwap, QUOTE_DECIMALS, sides, unpricedLegs, type Bridge, type Leg } from "../projector/prices.ts";
import { tradesOfTx, USER_OP_EVENT } from "../projector/trades.ts";

const FLUSH = 50_000, DRY = process.env.DRY === "1";
// Server cap 6 GB, peaks ~4.4 GB with the projector's big tokens spaced out (2026-11-02), and two of these open at once:
// each spills its sort to disk past 100 MB in 16K-row blocks and may use 1.2 GB (600 MB failed while reading the
// transfers' amounts), and is cancelled when the tool goes away (a stopped run must not leave its reads going).
// ClickHouse 26.3's default max_bytes_ratio_before_external_sort (0.5) wins over the byte threshold: it never spilled
// (0 parts, a day failed at 1.2 GB) until the ratio was 0 (2026-11-02, an hour's transfers: 9 parts).
const SORTED = { workload: "bulk", max_threads: 2, max_memory_usage: "1200000000", max_bytes_before_external_sort: "100000000",
  max_bytes_ratio_before_external_sort: 0, max_block_size: 16384,
  cancel_http_readonly_queries_on_client_close: 1 };
type Swap = { block: string; tx_index: number; log_index: number; tx_hash: string; ts: number; venue: "v2" | "v3" | "v4"; pool: string; a0: string; a1: string; sqrt: string; tx_from: string };
type Transfer = { block: string; tx_index: number; log_index: number; batch_index: number; token: string; from: string; to: string; amount: string };
type Pool = { token0: string; token1: string; verified: number };

/** PURE. The value at or before `x` in sorted keys (the first one before any); null when there are none. */
export function atOrBefore(keys: number[], vals: Map<number, number>, x: number): number | null {
  let lo = 0, hi = keys.length - 1, at = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (keys[m] <= x) { at = m; lo = m + 1; } else hi = m - 1; }
  return keys.length ? vals.get(keys[at])! : null;
}

/** PURE. The last key at or before `x` in sorted keys; null when none is. */
export function lastAtOrBefore(keys: number[], x: number): number | null {
  let lo = 0, hi = keys.length - 1, at = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (keys[m] <= x) { at = m; lo = m + 1; } else hi = m - 1; }
  return at < 0 ? null : keys[at];
}

/** Bridges for token/token pools before go-live (also src/tools/hist-candles.ts): each token's USD close per minute from
 *  its busiest verified quote pool in agg_candles_1m (≥ $100 that minute), from a day before `from`; bridgesAt(t, pool)
 *  gives each side's last close at or before t, up to a day old. */
export async function loadBridges(tokens: string[], from: number, to: number, decimals: Map<string, number>) {
  const bUsd = new Map<string, { keys: number[]; at: Map<number, number>; vol: number }>();
  for (let i = 0; i < tokens.length; i += 1_000) {
    const cs = await rows<{ token: string; pool: string; m: number; c: number; v: number }>(
      `SELECT token, pool, toUnixTimestamp(minute) AS m, argMaxMerge(close_usd) AS c, sum(volume_usd) AS v FROM agg_candles_1m
       WHERE token IN {t:Array(String)} AND quote IN ({w:String}, {n:String}, {u:String}) AND minute >= toDateTime({from:UInt32}) - INTERVAL 1 DAY AND minute < toDateTime({to:UInt32})
       GROUP BY token, pool, m HAVING v >= 100`, { from, to, t: tokens.slice(i, i + 1_000), w: WETH, n: NATIVE_ETH, u: USDG });
    const ver = new Set<string>(), cp = [...new Set(cs.map((c) => c.pool))];
    for (let j = 0; j < cp.length; j += 1_000)
      for (const r of await rows<{ pool: string }>("SELECT pool FROM pools FINAL WHERE verified = 1 AND pool IN {p:Array(String)}", { p: cp.slice(j, j + 1_000) })) ver.add(r.pool);
    const best = new Map<string, { c: number; v: number }>();
    for (const c of cs) {
      if (!ver.has(c.pool) || !(Number(c.c) > 0)) continue;
      const k = `${c.token}.${c.m}`, b = best.get(k);
      if (!b || Number(c.v) > b.v) best.set(k, { c: Number(c.c), v: Number(c.v) });
      const t = bUsd.get(c.token) ?? bUsd.set(c.token, { keys: [], at: new Map(), vol: 0 }).get(c.token)!;
      t.vol += Number(c.v);
    }
    for (const [k, b] of best) { const [t, m] = k.split("."); bUsd.get(t)!.at.set(Number(m), b.c); }
  }
  for (const b of bUsd.values()) {
    // a minute closed by a swap that drained a v3/v4 range holds its tick limit (candles from before priceSwap's guard,
    // 2026-11-02: up to 1.6e51 USD a trade): a minute 1000× off the token's median is left out
    const vs = [...b.at.values()].sort((x, y) => x - y), med = vs[Math.floor(vs.length / 2)];
    for (const [m, c] of b.at) if (c / med > 1000 || med / c > 1000) b.at.delete(m);
    b.keys = [...b.at.keys()].sort((x, y) => x - y);
  }
  const bridgesAt = (t: number, pl: { token0: string; token1: string }) => {
    const out = new Map<string, Bridge>();
    for (const tok of [pl.token0, pl.token1]) {
      const b = bUsd.get(tok);
      const k = b && lastAtOrBefore(b.keys, t - (t % 60));
      if (k != null && t - k <= 86_400) out.set(tok, { dec: decimals.get(tok)!, usd: b!.at.get(k)!, vol: b!.vol });
    }
    return out;
  };
  return { bridgesAt, priced: bUsd.size };
}

async function main(from: number, to: number) {
  const [g] = await rows<{ block: string }>("SELECT block FROM ctl_cursors FINAL WHERE name = 'golive'");
  const p = { from, to, g: g.block };
  const win = `time >= toDateTime({from:UInt32}) AND time < toDateTime({to:UInt32})${DRY ? "" : " AND block < {g:UInt64}"}`;
  const long = createClient({ ...cfg.clickhouse, request_timeout: 3_600_000 });
  // resolves once the server answers, i.e. its sort is done. Both reads are started together and walked only when both
  // have answered: a stream left unread over 30 s (the server's send timeout; a query setting doesn't move it) is
  // dropped, as the transfers were while the swaps, started after them, still sorted (2026-11-02, a day: 49 s).
  async function sorted<T>(query: string): Promise<AsyncGenerator<T>> {
    const rs = await long.query({ query, query_params: p, format: "JSONEachRow", clickhouse_settings: SORTED as never });
    return (async function* () { for await (const chunk of rs.stream()) for (const row of chunk) yield row.json<T>(); })();
  }
  const both = (cols: string, a: string, b: string, where: string) => `SELECT ${cols} FROM ${a} WHERE ${where} UNION ALL SELECT ${cols} FROM ${b} WHERE ${where}`;

  // pools that swapped in the window, their token decimals, ETH/USD per minute, userOps and Relay fills per tx
  const pools = new Map<string, Pool>();
  // batches of 1,000: a query parameter is an HTTP form field, capped at 128 KB (10,000 v4 ids were refused)
  const pv = await rows<{ pool: string; venue: string }>(`SELECT pool, any(venue) AS venue FROM (${both("pool, venue", "kept_swaps", "ev_swaps", win)}) GROUP BY pool`, p);
  const ps = pv.map((r) => r.pool);
  const known = new Set<string>();
  for (let i = 0; i < ps.length; i += 1_000)
    for (const r of await rows<{ pool: string }>("SELECT DISTINCT pool FROM pools WHERE pool IN {p:Array(String)}", { p: ps.slice(i, i + 1_000) })) known.add(r.pool);
  const v23 = pv.filter((r) => !known.has(r.pool) && (r.venue === "v2" || r.venue === "v3"));
  if (v23.length && !DRY) await insert("pools", await resolveV23(upstream(cfg.upstreamHttp), v23), `hist-trades-pools:${from}-${to}`);
  for (let i = 0; i < ps.length; i += 1_000)
    for (const r of await rows<Pool & { pool: string }>("SELECT pool, token0, token1, verified FROM pools FINAL WHERE ok = 1 AND pool IN {p:Array(String)}", { p: ps.slice(i, i + 1_000) }))
      pools.set(r.pool, { token0: r.token0, token1: r.token1, verified: Number(r.verified) });
  const decimals = new Map<string, number>(Object.entries(QUOTE_DECIMALS));
  const ts = [...new Set([...pools.values()].flatMap((x) => [x.token0, x.token1]))].filter((t) => !decimals.has(t));
  for (let i = 0; i < ts.length; i += 1_000)
    for (const r of await rows<{ token: string; decimals: number }>("SELECT token, decimals FROM serve_tokens FINAL WHERE decimals >= 0 AND token IN {t:Array(String)}", { t: ts.slice(i, i + 1_000) }))
      decimals.set(r.token, r.decimals);
  const eth = new Map((await rows<{ m: number; c: number }>(
    `SELECT toUnixTimestamp(minute) AS m, argMax(c, v) AS c FROM (SELECT minute, pool, argMaxMerge(close) AS c, sum(volume_usd) AS v FROM agg_candles_1m
     WHERE token IN ({w:String}, {n:String}) AND quote = {u:String} AND minute >= toDateTime({from:UInt32}) - INTERVAL 1 DAY AND minute < toDateTime({to:UInt32})
     GROUP BY minute, pool) GROUP BY m`, { ...p, w: WETH, n: NATIVE_ETH, u: USDG })).map((r) => [Number(r.m), Number(r.c)]));
  const ethKeys = [...eth.keys()].sort((a, b) => a - b);
  const ethAt = (t: number) => atOrBefore(ethKeys, eth, t - (t % 60));
  const bridged = [...new Set([...pools.values()].filter((x) => !(x.token0 in QUOTE_DECIMALS) && !(x.token1 in QUOTE_DECIMALS))
    .flatMap((x) => [x.token0, x.token1]))].filter((t) => decimals.has(t));
  const { bridgesAt, priced: bPriced } = await loadBridges(bridged, from, to, decimals);
  const byTx = <T extends { block: string; tx_index: number }>(xs: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of xs) { const k = `${x.block}.${x.tx_index}`; (m.get(k) ?? m.set(k, []).get(k)!).push(x); }
    return m;
  };
  const ops = byTx(await rows<{ block: string; tx_index: number; log_index: number; sender: string }>(
    `SELECT DISTINCT block, tx_index, log_index, concat('0x', substring(topic2, 27)) AS sender FROM (${both("block, tx_index, log_index, topic2", "kept_logs", "raw_logs", `topic0 = {uoe:String} AND ${win}`)})
     ORDER BY block, log_index`, { ...p, uoe: USER_OP_EVENT }));
  const relays = byTx(await rows<{ block: string; tx_index: number; tx_hash: string; ts: number; recipient: string; token: string; amount: string; usdg_in: string; weth_in: string }>(
    `SELECT DISTINCT block, tx_index, tx_hash, ts, recipient, token, amount, usdg_in, weth_in FROM (${both("block, tx_index, tx_hash, toUnixTimestamp(time) AS ts, recipient, token, toString(amount) AS amount, toString(usdg_in) AS usdg_in, toString(weth_in) AS weth_in",
      "kept_relay", "ev_relay", `sign = 1 AND ${win}`)})`, p));
  console.error(`[hist-trades] ${from}..${to}: ${ps.length} pools (${pools.size} resolved, ${v23.length} v2/v3 looked up), ETH/USD in ${ethKeys.length} minutes, ${bPriced}/${bridged.length} bridge tokens priced, ${ops.size} userOp txs, ${relays.size} Relay fills`);

  // swaps and transfers, each sorted by tx: walk them together
  const [swaps, transfers] = await Promise.all([sorted<Swap>(`SELECT * FROM (${both("block, tx_index, log_index, tx_hash, toUnixTimestamp(time) AS ts, venue, pool, toString(amount0) AS a0, toString(amount1) AS a1, toString(sqrt_price_x96) AS sqrt, tx_from",
    "kept_swaps", "ev_swaps", `sign = 1 AND ${win}`)}) ORDER BY block, tx_index, log_index`),
    sorted<Transfer>(`SELECT * FROM (${both("block, tx_index, log_index, batch_index, token, `from`, `to`, toString(amount) AS amount",
    "kept_transfers", "ev_transfers", `standard = 'erc20' AND sign = 1 AND ${win}`)}) ORDER BY block, tx_index, log_index, batch_index`)]);
  const cmp = (a: { block: string; tx_index: number }, b: { block: string; tx_index: number }) => Number(a.block) - Number(b.block) || a.tx_index - b.tx_index;
  let tNext = (await transfers.next()).value as Transfer | undefined, lastT = "";
  async function transfersOf(tx: { block: string; tx_index: number }) {
    const out: Transfer[] = [];
    while (tNext && cmp(tNext, tx) <= 0) {
      const k = `${tNext.block}.${tNext.log_index}.${tNext.batch_index}`;
      if (cmp(tNext, tx) === 0 && k !== lastT) out.push(tNext);
      lastT = k; tNext = (await transfers.next()).value;
    }
    return out;
  }

  let buf: object[] = [], n = 0, txs = 0, nSwaps = 0, priced = 0, unpriced = 0, made = 0;
  const flush = async () => {
    if (DRY) { // written out before process.exit, which drops a pipe's pending writes
      const s = (buf as Record<string, unknown>[]).map((r) => [r.block, r.tx_index, r.wallet, r.token, r.side, r.via].join(".") + "\n").join("");
      if (s) await new Promise((r) => process.stdout.write(s, r));
    } else if (buf.length) await insert("hist_trades", buf, `hist-trades:${from}-${to}:${n++}`);
    made += buf.length; buf = [];
  };
  const emit = async (tx: { block: string; tx_index: number; tx_hash: string; ts: number }, legs: Leg[], signer: string, xfers: Transfer[]) => {
    const k = `${tx.block}.${tx.tx_index}`;
    const ts = legs.length ? tradesOfTx(signer, xfers, legs, ops.get(k) ?? []).map((t) => ({ ...t, via: t.via as string })) : [];
    for (const f of relays.get(k) ?? []) { // as deriveTrades: a recipient that bought through a priced swap has its trade already
      if (ts.some((t) => t.wallet === f.recipient && t.token === f.token)) continue;
      const e = Number(f.weth_in) / 1e18;
      ts.push({ wallet: f.recipient, token: f.token, amount: BigInt(f.amount), usd: Number(f.usdg_in) / 1e6 + e * (ethAt(f.ts) ?? 0), eth: e, via: "relay" });
    }
    relays.delete(k);
    for (const t of ts) buf.push({ block: tx.block, tx_index: tx.tx_index, tx_hash: tx.tx_hash, time: tx.ts, wallet: t.wallet, token: t.token,
      side: t.amount > 0n ? "buy" : "sell", amount: t.amount.toString(), usd: t.usd ?? 0, eth: t.eth ?? 0, priced: t.usd === null ? 0 : 1, via: t.via, keep: 0, sign: 1 });
    if (buf.length >= FLUSH) await flush();
  };

  let cur: Swap[] = [], lastS = "";
  const close = async () => {
    if (!cur.length) return;
    const tx = { ...cur[0] }, legs: Leg[] = [];
    for (const s of cur) {
      const pl = pools.get(s.pool);
      if (!pl) continue;
      const br = !(pl.token0 in QUOTE_DECIMALS) && !(pl.token1 in QUOTE_DECIMALS) ? bridgesAt(s.ts, pl) : undefined;
      const q = priceSwap({ ...s, ...pl }, decimals.get(sides(pl.token0, pl.token1, br)?.token ?? ""), ethAt(s.ts), br);
      if (q) { priced++; legs.push({ log_index: s.log_index, token: q.token, quote: q.quote, token_delta: q.tokenDelta.toString(), usd: q.usd, quote_amount: q.quoteAmount }); }
      else { const u = unpricedLegs({ ...s, ...pl }); unpriced += u.length ? 1 : 0; legs.push(...u); }
    }
    await emit(tx, legs, tx.tx_from, await transfersOf(tx));
    txs++; cur = [];
  };
  for await (const s of swaps) {
    const k = `${s.block}.${s.log_index}`;
    if (k === lastS) continue; // a not-yet-merged duplicate
    lastS = k; nSwaps++;
    if (cur.length && cmp(cur[0], s) !== 0) await close();
    cur.push(s);
  }
  await close();
  for (const fs of [...relays.values()]) await emit(fs[0], [], "", []); // Relay fills in txs without a swap
  await flush();
  console.error(`[hist-trades] done: ${nSwaps} swaps (${priced} priced, ${unpriced} not) in ${txs} txs, ${made} trades`);
}

if (import.meta.main) {
  const [from, to] = process.argv.slice(2).map(Number);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from) { console.error("usage: hist-trades.ts <from unix> <to unix>"); process.exit(2); }
  await workload.run("bulk", () => main(from, to));
  process.exit(0); // own exit: open sockets would keep a one-off alive
}
