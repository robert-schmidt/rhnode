// Token cards: the facts about a token that apps and the explorer show, from ClickHouse and the main pool's state at
// the tip. Read by the API (GET /v1/tokens/{t}, POST /v1/tokens) and the explorer's token pages. Definitions (2026-10-31):
// - main pool: against a quote asset, verified first, then most net USD volume in 24 h, then most ever (1-minute candles);
// - net volume: a tx's swaps in one pool count as what is left after buys and sells cancel (a same-tx round trip, wash,
//   counts ~0); the *_raw_usd fields keep the gross, so wash shows as the gap;
// - liquidity_usd from the pool's state at the tip: a bonding curve's real quote balance (price: its last trade); v2 reserves; v3 and v4 active liquidity (the tokens the positions
//   hold within ×/÷10,000 of the price, by a walk over the initialized ticks: a full-range pool gives its reserves, a
//   one-tick position its real size, not its virtual reserves); liquidity_quote_usd the quote side alone (what a sell
//   meets: a one-sided pool has a large liquidity_usd and almost none of it); v3 also liquidity_balances_usd (all it holds);
// - top10 and circulating leave out protocol addresses (chain/protocol.ts), the token's own pools and hooks, its launchpad curve and
//   the token contract; lockers are locked_supply, 0xdead burned_supply; pools count as circulating;
// - h24/h6/h1 buys/sells/buyers/sellers by the trader (ev_trades), volume (net and raw) from priced swaps; price_change_pct
//   the main pool's price now against its last 1-minute close 1/6/24 h ago (null with no trade before); top_wallet is the
//   trader with the most 24 h trade USD and its share (wash across many txs by one wallet shows as a share near 1);
// - anything not known is null, never 0 (a token whose history isn't complete has null holder fields).
import { parseAbi } from "viem";
import { rows } from "./ch.ts";
import { PROTOCOL } from "./chain/protocol.ts";
import { MULTICALL3, NATIVE_ETH, USDG, V4_STATE_VIEW, WETH } from "./chain/constants.ts";
import { QUOTE_DECIMALS, sides } from "./projector/prices.ts";
import { multicall, type Call } from "./projector/pools.ts";
import type { Client } from "./chain/upstream.ts";

export type Up = Pick<Client, "call">;
export type Card = Record<string, unknown>;

export const ADDR = /^0x[0-9a-f]{40}$/;
const DEAD = "0x000000000000000000000000000000000000dead";
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const MC3 = parseAbi(["function getEthBalance(address) view returns (uint256)"]);
const V2 = parseAbi(["function getReserves() view returns (uint112, uint112, uint32)"]);
// only the first two words: v3 forks disagree on the rest of slot0
const V3 = parseAbi(["function slot0() view returns (uint160, int24)", "function liquidity() view returns (uint128)",
  "function tickBitmap(int16) view returns (uint256)", "function ticks(int24) view returns (uint128, int128)"]);
const SV = parseAbi(["function getSlot0(bytes32) view returns (uint160, int24)", "function getLiquidity(bytes32) view returns (uint128)",
  "function getTickBitmap(bytes32, int16) view returns (uint256)", "function getTickLiquidity(bytes32, int24) view returns (uint128, int128)"]);
// per token and pool, 24 h of priced swaps: net (each tx's buys and sells in the pool cancel) and raw USD
export const NET24 = `SELECT token, pool, any(qt) AS q, sum(abs(nt)) AS nv, sum(gr) AS rv,
    sumIf(abs(nt), tm >= now() - INTERVAL 6 HOUR) AS nv6, sumIf(gr, tm >= now() - INTERVAL 6 HOUR) AS rv6,
    sumIf(abs(nt), tm >= now() - INTERVAL 1 HOUR) AS nv1, sumIf(gr, tm >= now() - INTERVAL 1 HOUR) AS rv1
  FROM (SELECT token, pool, tx_hash, any(quote) AS qt, min(time) AS tm,
    sum(if(quote_delta > 0, usd, -usd) * sign) AS nt, sum(usd * sign) AS gr FROM ev_prices
    WHERE token IN {t:Array(String)} AND time >= now() - INTERVAL 1 DAY GROUP BY token, pool, tx_hash) GROUP BY token, pool`;
const BAND = 92_103, MAX_TICK = 887_272; // ln(10,000) / ln(1.0001) ticks each side
const LAUNCHPADS = [...PROTOCOL.values()].filter((e) => e.kind === "launchpad").map((e) => e.address);
const LOCKERS = [...PROTOCOL.values()].filter((e) => e.kind === "locker").map((e) => e.address);

let ethUsd: { v: number | null; at: number } = { v: null, at: 0 };
async function eth(): Promise<number | null> {
  if (Date.now() - ethUsd.at < 10_000) return ethUsd.v;
  const [r] = await rows<{ p: number }>(`SELECT price AS p FROM ev_prices WHERE time > now() - INTERVAL 1 HOUR AND token IN ({w:String}, {n:String})
    AND quote = {u:String} AND verified = 1 ORDER BY block DESC, log_index DESC LIMIT 1`, { w: WETH, n: NATIVE_ETH, u: USDG });
  ethUsd = { v: r ? Number(r.p) : ethUsd.v, at: Date.now() };
  return ethUsd.v;
}

const pct = (a: bigint, of: bigint) => (of > 0n ? Number((a * 1_000_000n) / of) / 10_000 : null);
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

type Pool = { token: string; pool: string; venue: string; quote: string; v24: number; raw24: number; v: number; verified: number; token0: string; token1: string; created_block: string; spacing: number };
type Mid = { price: number | null; liquidityUsd: number | null; quoteUsd: number | null; kind: "reserves" | "active" | "curve"; balancesUsd: number | null };

/** PURE. Price (quote per token, human units) and liquidity from a pool's state at the tip. */
export function poolState(venue: string, tokenIs0: boolean, dt: number | null, dq: number, quoteUsd: number | null,
  s: { r0?: bigint; r1?: bigint; sqrt?: bigint; L?: bigint; b0?: bigint; b1?: bigint; band?: [number, number]; q?: bigint; last?: number | null }): Mid | null {
  const usd = (quoteRaw: number) => (quoteUsd == null ? null : (2 * quoteRaw / 10 ** dq) * quoteUsd);
  // A bonding curve's price is its last trade (its virtual reserves aren't real money); its liquidity is the quote it
  // really holds, which is all a seller can be paid from.
  if (venue === "curve") {
    if (s.q == null) return null;
    const q = quoteUsd == null ? null : (Number(s.q) / 10 ** dq) * quoteUsd;
    return { price: s.last ?? null, liquidityUsd: q, quoteUsd: q, kind: "curve", balancesUsd: null };
  }
  if (venue === "v2") {
    if (!s.r0 || !s.r1) return null;
    const [rt, rq] = tokenIs0 ? [s.r0, s.r1] : [s.r1, s.r0];
    const q = usd(Number(rq));
    return { price: dt == null ? null : (Number(rq) / Number(rt)) * 10 ** (dt - dq), liquidityUsd: q, quoteUsd: q == null ? null : q / 2, kind: "reserves", balancesUsd: null };
  }
  if (!s.sqrt || s.L == null) return null;
  const sp = Number(s.sqrt) / 2 ** 96, P = sp * sp; // token1 per token0, raw
  const price = dt == null ? null : (tokenIs0 ? P : 1 / P) * 10 ** (dt - dq);
  const value = (a0: number, a1: number) => {
    if (price == null || quoteUsd == null || dt == null) return null;
    const [at, aq] = tokenIs0 ? [a0, a1] : [a1, a0];
    return ((at / 10 ** dt) * price + aq / 10 ** dq) * quoteUsd;
  };
  const aq = s.band && (tokenIs0 ? s.band[1] : s.band[0]);
  return { price, liquidityUsd: s.band ? value(...s.band) : null, quoteUsd: aq != null && quoteUsd != null ? (aq / 10 ** dq) * quoteUsd : null, kind: "active",
    balancesUsd: venue === "v3" && s.b0 != null && s.b1 != null ? value(Number(s.b0), Number(s.b1)) : null };
}

/** PURE. Raw token0/token1 amounts the liquidity of a v3/v4 pool holds between ticks lo and hi: from the current price,
 *  up across the initialized ticks above (liquidityNet added) in token0, down across those at or below (subtracted) in token1. */
export function band(sqrtX96: bigint, tick: number, L: bigint, net: Map<number, bigint>, lo: number, hi: number): [number, number] {
  const sq = (t: number) => 1.0001 ** (t / 2), sp = Number(sqrtX96) / 2 ** 96, ts = [...net.keys()].sort((a, b) => a - b);
  let a0 = 0, a1 = 0, l = L, p = sp;
  for (const t of [...ts.filter((t) => t > tick && t < hi), hi]) { const q = sq(t); if (q > p) a0 += Number(l) * (1 / p - 1 / q); p = q; l += net.get(t) ?? 0n; }
  l = L; p = sp;
  for (const t of [...ts.filter((t) => t <= tick && t > lo).reverse(), lo]) { const q = sq(t); if (q < p) a1 += Number(l) * (p - q); p = q; l -= net.get(t) ?? 0n; }
  return [a0, a1];
}

const WINDOWS = [["24", "INTERVAL 1 DAY"], ["6", "INTERVAL 6 HOUR"], ["1", "INTERVAL 1 HOUR"]] as const;

// pool → its initialized ticks' liquidityNet over [lo, hi] as read at `at` around `tick` (see build)
const ticks = new Map<string, { at: number; tick: number; lo: number; hi: number; net: Map<number, bigint> }>();

/** multicall in chunks, so a batch of cards stays under the node's eth_call gas cap */
const mc = (up: Up, cs: Call[]) => Promise.all(Array.from({ length: Math.ceil(cs.length / 500) }, (_, i) => cs.slice(i * 500, i * 500 + 500))
  .map((c) => multicall(up, c).catch(() => c.map(() => null)))).then((r) => r.flat());

async function build(up: Up, tokens: string[]): Promise<Map<string, Card>> {
  const t = tokens;
  const [meta, launches, cands, trades, vols, eu, [tip], tops] = await Promise.all([
    rows<{ token: string; name: string; symbol: string; decimals: number; supply: string; holders: string; complete: number }>(
      "SELECT token, name, symbol, decimals, toString(total_supply) AS supply, toString(holder_count) AS holders, complete FROM serve_tokens FINAL WHERE token IN {t:Array(String)}", { t }),
    rows<{ token: string; deployer: string; source: string; block: string; time: number; detail: string }>(
      `SELECT token, deployer, source, toString(block) AS block, toUnixTimestamp(time) AS time, detail FROM kept_launches FINAL
       WHERE token IN {t:Array(String)} AND kind = 'launch' AND sign = 1 ORDER BY block LIMIT 1 BY token`, { t }),
    rows<Pool>(
      `SELECT c.token AS token, c.pool AS pool, toString(p.venue) AS venue, c.quote AS quote, n.nv AS v24, n.rv AS raw24, c.v AS v, p.verified AS verified,
         p.token0 AS token0, p.token1 AS token1, toString(p.created_block) AS created_block, p.tick_spacing AS spacing
       FROM (SELECT token, pool, any(quote) AS quote, sum(volume_usd) AS v
             FROM agg_candles_1m WHERE token IN {t:Array(String)} GROUP BY token, pool) AS c
       LEFT JOIN (${NET24}) AS n ON n.token = c.token AND n.pool = c.pool
       INNER JOIN (SELECT pool, venue, verified, token0, token1, created_block, tick_spacing FROM pools FINAL WHERE ok = 1) AS p ON p.pool = c.pool
       ORDER BY token, verified DESC, v24 DESC, v DESC LIMIT 1 BY token`, { t }),
    rows<{ token: string } & Record<string, string>>(
      `SELECT token, ${WINDOWS.map(([h, i]) => `sumIf(sign, side = 'buy' AND time >= now() - ${i}) AS buys${h}, sumIf(sign, side = 'sell' AND time >= now() - ${i}) AS sells${h},
         uniqExactIf(wallet, side = 'buy' AND sign = 1 AND time >= now() - ${i}) AS buyers${h}, uniqExactIf(wallet, side = 'sell' AND sign = 1 AND time >= now() - ${i}) AS sellers${h}`).join(", ")}
       FROM ev_trades WHERE token IN {t:Array(String)} AND time >= now() - INTERVAL 1 DAY GROUP BY token`, { t }),
    rows<{ token: string } & Record<string, number>>(`SELECT token, round(sum(nv), 2) AS v24, round(sum(rv), 2) AS raw24, round(sum(nv6), 2) AS v6,
      round(sum(rv6), 2) AS raw6, round(sum(nv1), 2) AS v1, round(sum(rv1), 2) AS raw1 FROM (${NET24}) GROUP BY token`, { t }),
    eth(),
    rows<{ b: string }>("SELECT max(block) AS b FROM ctl_cursors FINAL WHERE name = 'tip'"),
    rows<{ token: string; wallet: string; share: number }>(
      `SELECT token, argMax(wallet, w) AS wallet, max(w) / sum(w) AS share FROM (SELECT token, wallet, sum(usd * sign) AS w FROM ev_trades
       WHERE token IN {t:Array(String)} AND time >= now() - INTERVAL 1 DAY GROUP BY token, wallet) GROUP BY token HAVING sum(w) > 0`, { t }),
  ]);
  const ingested = Number(tip?.b ?? 0);
  const by = <T extends { token: string }>(xs: T[]) => new Map(xs.map((x) => [x.token, x]));
  const M = by(meta), L = by(launches), P = by(cands), T = by(trades), V = by(vols), W = by(tops);
  const curve = (tk: string) => { try { const c = JSON.parse(L.get(tk)?.detail ?? "{}").curve; return typeof c === "string" && ADDR.test(c.toLowerCase()) ? c.toLowerCase() : null; } catch { return null; } };
  const curves = t.map(curve).filter((c): c is string => !!c);

  // Holdings that aren't circulating, and top10 without protocol addresses (only for tokens whose history is complete)
  const full = t.filter((tk) => M.get(tk)?.complete);
  const special = [DEAD, ...LOCKERS, ...LAUNCHPADS, ...curves];
  // the tokens' own pools and hooks are left out in the query: a quote token like WETH has thousands, and query
  // parameters travel in the URL (a cold batch with WETH in it failed "URI too long")
  const exclude = [...PROTOCOL.keys(), ...curves];
  const [held, top] = full.length ? await Promise.all([
    rows<{ token: string; holder: string; amt: string }>(
      `SELECT token, holder, toString(b) AS amt FROM (SELECT token, holder, sum(balance) AS b FROM agg_balances
       WHERE token IN {t:Array(String)} AND holder IN {s:Array(String)} GROUP BY token, holder HAVING b > 0)`, { t: full, s: special }),
    rows<{ token: string; top: string }>(
      `SELECT token, toString(sum(b)) AS top FROM (SELECT token, holder, b FROM (SELECT token, holder, sum(balance) AS b FROM agg_balances
         WHERE token IN {t:Array(String)} GROUP BY token, holder HAVING b > 0) WHERE holder NOT IN {x:Array(String)} AND holder != token
           AND holder NOT IN (SELECT toFixedString(a, 42) FROM pools FINAL ARRAY JOIN [pool, hooks] AS a
             WHERE (token0 IN {t:Array(String)} OR token1 IN {t:Array(String)}) AND length(a) = 42)
         ORDER BY b DESC LIMIT 10 BY token) GROUP BY token`, { t: full, x: exclude }),
  ]) : [[], []];

  // The main pools' state at the tip, one multicall
  const calls: Call[] = [], slots = new Map<string, number>();
  for (const p of P.values()) {
    slots.set(p.token, calls.length);
    if (p.venue === "v2") calls.push({ target: p.pool, abi: V2, fn: "getReserves" });
    else if (p.venue === "curve") { const q = sides(p.token0, p.token1)?.quote;
      calls.push(q === NATIVE_ETH || !q ? { target: MULTICALL3, abi: MC3, fn: "getEthBalance", args: [p.pool] } : { target: q, abi: ERC20, fn: "balanceOf", args: [p.pool] }); }
    else if (p.venue === "v3") calls.push({ target: p.pool, abi: V3, fn: "slot0" }, { target: p.pool, abi: V3, fn: "liquidity" },
      { target: p.token0, abi: ERC20, fn: "balanceOf", args: [p.pool] }, { target: p.token1, abi: ERC20, fn: "balanceOf", args: [p.pool] });
    else calls.push({ target: V4_STATE_VIEW, abi: SV, fn: "getSlot0", args: [p.pool] }, { target: V4_STATE_VIEW, abi: SV, fn: "getLiquidity", args: [p.pool] });
  }
  const [res, ago] = await Promise.all([mc(up, calls), P.size ? rows<{ token: string; pool: string; pn: number; p1: number; p6: number; p24: number }>(
    `SELECT token, pool, argMaxMerge(close_usd) AS pn, argMaxMergeIf(close_usd, minute < now() - INTERVAL 1 HOUR) AS p1, argMaxMergeIf(close_usd, minute < now() - INTERVAL 6 HOUR) AS p6,
       argMaxMergeIf(close_usd, minute < now() - INTERVAL 1 DAY) AS p24 FROM agg_candles_1m
     WHERE token IN {t:Array(String)} AND pool IN {p:Array(String)} AND minute >= now() - INTERVAL 14 DAY GROUP BY token, pool`,
    { t: [...P.keys()], p: [...P.values()].map((p) => p.pool) }) : []]);
  const AGO = new Map(ago.filter((r) => P.get(r.token)?.pool === r.pool).map((r) => [r.token, r]));
  const at = (tk: string, k: number) => (res[slots.get(tk)! + k] ?? undefined) as (readonly bigint[] & bigint) | undefined;

  // v3/v4: the tick bitmap words around the price, then the liquidityNet of every initialized tick found in the band.
  // Positions change far less often than the price, so a pool's ticks are reused for 2 minutes (or until its tick moves
  // a tenth of the band); price, tick and active liquidity are read fresh every time. A cold batch of 120 tokens took
  // 84 eth_calls of ~320K calldata words (a spacing-1 pool needs 721 bitmap words), 4.3 s on a busy node (2026-10-31).
  const now = Date.now(), live = [...P.values()].filter((p) => p.venue !== "v2" && p.spacing > 0 && at(p.token, 0) && at(p.token, 1) != null);
  const fresh = (p: Pool) => { const c = ticks.get(p.pool); return c && now - c.at < 120_000 && Math.abs(Number(at(p.token, 0)![1]) - c.tick) < BAND / 10 ? c : null; };
  const walks = live.filter((p) => !fresh(p)).map((p) => {
    const tick = Number(at(p.token, 0)![1]), lo = Math.max(-MAX_TICK, tick - BAND), hi = Math.min(MAX_TICK, tick + BAND);
    const word = (t: number) => Math.floor(t / p.spacing) >> 8, words: number[] = [];
    for (let w = word(lo); w <= word(hi); w++) words.push(w);
    return { p, tick, lo, hi, words, ticks: [] as number[], net: new Map<number, bigint>(), ok: true };
  });
  const v4 = (p: Pool) => p.venue === "v4";
  const bms = await mc(up, walks.flatMap(({ p, words }) => words.map((w): Call =>
    v4(p) ? { target: V4_STATE_VIEW, abi: SV, fn: "getTickBitmap", args: [p.pool, w] } : { target: p.pool, abi: V3, fn: "tickBitmap", args: [w] })));
  let k = 0;
  for (const wk of walks) for (const w of wk.words) {
    const bm = bms[k++] as bigint | null;
    if (bm == null) { wk.ok = false; continue; }
    for (let b = 0; b < 256; b++) if ((bm >> BigInt(b)) & 1n) {
      const t = (w * 256 + b) * wk.p.spacing;
      if (t > wk.lo && t < wk.hi) wk.ticks.push(t);
    }
  }
  const tls = await mc(up, walks.flatMap(({ p, ticks }) => ticks.map((t): Call =>
    v4(p) ? { target: V4_STATE_VIEW, abi: SV, fn: "getTickLiquidity", args: [p.pool, t] } : { target: p.pool, abi: V3, fn: "ticks", args: [t] })));
  k = 0;
  for (const wk of walks) {
    for (const t of wk.ticks) { const r = tls[k++] as readonly bigint[] | null; if (r == null) wk.ok = false; else wk.net.set(t, r[1]); }
    if (wk.ok) ticks.set(wk.p.pool, { at: now, tick: wk.tick, lo: wk.lo, hi: wk.hi, net: wk.net });
  }
  if (ticks.size > 20_000) ticks.clear();
  const bands = new Map<string, [number, number]>();
  for (const p of live) {
    const c = fresh(p), tick = Number(at(p.token, 0)![1]);
    if (c) bands.set(p.token, band(at(p.token, 0)![0], tick, at(p.token, 1)!, c.net, Math.max(c.lo, tick - BAND), Math.min(c.hi, tick + BAND)));
  }

  const out = new Map<string, Card>();
  for (const tk of t) {
    const m = M.get(tk);
    if (!m) continue;
    const supply = BigInt(m.supply), complete = m.complete === 1, dec = m.decimals >= 0 ? m.decimals : null;
    const h = new Map(held.filter((r) => r.token === tk).map((r) => [r.holder, BigInt(r.amt)]));
    const locked = sum(LOCKERS.map((a) => h.get(a) ?? 0n)), burned = h.get(DEAD) ?? 0n;
    const pad = sum([...LAUNCHPADS, ...(curve(tk) ? [curve(tk)!] : [])].map((a) => h.get(a) ?? 0n));
    const top10 = top.find((r) => r.token === tk);
    let main: Card | null = null;
    const p = P.get(tk), sd = p && sides(p.token0, p.token1);
    if (p && sd && sd.token === tk) {
      // multicall answers: a tuple (getReserves, slot0, getSlot0) or a bigint (liquidity, balanceOf), null on failure
      const w = (k: number) => at(tk, k);
      const qUsd = sd.quote === USDG ? 1 : eu, pn = AGO.get(tk)?.pn;
      const st = p.venue === "v2" ? { r0: w(0)?.[0], r1: w(0)?.[1] } : p.venue === "curve" ? { q: w(0) as bigint | undefined, last: pn && qUsd ? pn / qUsd : null }
        : { sqrt: w(0)?.[0], L: w(1), b0: w(2), b1: w(3), band: bands.get(tk) };
      const ms = poolState(p.venue, sd.tokenIs0, dec, QUOTE_DECIMALS[sd.quote], qUsd, st);
      main = {
        pool: p.pool, venue: p.venue, quote: sd.quote, verified: p.verified === 1, created_block: Number(p.created_block) || null,
        price: ms?.price ?? null, price_usd: ms?.price != null && qUsd != null ? ms.price * qUsd : null,
        liquidity_usd: ms?.liquidityUsd ?? null, liquidity_quote_usd: ms?.quoteUsd ?? null, liquidity_kind: ms?.kind ?? null,
        ...(p.venue === "v3" ? { liquidity_balances_usd: ms?.balancesUsd ?? null } : {}),
        volume_24h_usd: Math.round(p.v24 * 100) / 100, volume_24h_raw_usd: Math.round(p.raw24 * 100) / 100,
      };
    }
    const lc = L.get(tk), tr = T.get(tk);
    out.set(tk, {
      token: tk, name: m.name, symbol: m.symbol, decimals: dec, total_supply: m.supply, complete,
      circulating_supply: complete ? (supply - burned - locked - pad).toString() : null,
      locked_supply: complete ? locked.toString() : null, burned_supply: complete ? burned.toString() : null,
      holder_count: complete ? Number(m.holders) : null,
      top10: complete ? { amount: (top10 ? BigInt(top10.top) : 0n).toString(), pct: pct(top10 ? BigInt(top10.top) : 0n, supply) } : null,
      creator: lc?.deployer || null, launchpad: lc?.source ?? null, launch_block: lc ? Number(lc.block) : null, launch_time: lc?.time ?? null,
      main_pool: main,
      ...Object.fromEntries(WINDOWS.map(([h]) => [`h${h}`, {
        volume_usd: V.get(tk)?.[`v${h}`] ?? 0, volume_raw_usd: V.get(tk)?.[`raw${h}`] ?? 0, buys: Number(tr?.[`buys${h}`] ?? 0), sells: Number(tr?.[`sells${h}`] ?? 0),
        buyers: Number(tr?.[`buyers${h}`] ?? 0), sellers: Number(tr?.[`sellers${h}`] ?? 0),
        ...(h === "24" ? { top_wallet: W.get(tk) ? { wallet: W.get(tk)!.wallet, share: Math.round(W.get(tk)!.share * 10_000) / 10_000 } : null } : {}),
      }])),
      // the main pool's price at the tip against its last 1-minute close before then; null with no trade before then
      price_change_pct: Object.fromEntries((["1", "6", "24"] as const).map((h) => {
        const was = AGO.get(tk)?.[`p${h}`], now = (main?.price_usd as number | null) ?? null;
        return [`h${h}`, was && now != null ? Math.round((now / was - 1) * 1e6) / 1e4 : null];
      })),
      block: ingested,
    });
  }
  return out;
}

// A card for 60 s; concurrent callers of one token share one computation. ponytail: cleared wholesale at 10K keys.
const memo = new Map<string, { at: number; p: Promise<Card | null> }>();
/** Cards of lowercase token addresses; null for a token never seen. */
export async function cards(up: Up, tokens: string[]): Promise<Map<string, Card | null>> {
  const fresh = (k: string) => { const m = memo.get(k); return m && Date.now() - m.at < 60_000; };
  const need = tokens.filter((k) => !fresh(k));
  if (need.length) {
    if (memo.size > 10_000) memo.clear();
    const all = build(up, need);
    for (const k of need) {
      const p = all.then((m) => m.get(k) ?? null);
      memo.set(k, { at: Date.now(), p });
      p.catch(() => memo.delete(k));
    }
  }
  return new Map(await Promise.all(tokens.map(async (k) => [k, await memo.get(k)!.p] as const)));
}
