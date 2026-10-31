// Swap → price (migrations/004_prices.sql). v3/v4 price is the pool's price AFTER the swap (sqrtPriceX96);
// v2, curves and Metric OMM pools have no price word, so it is the swap's execution price (v2: fee included; a curve: fees excluded).
// A pool of two non-quote tokens (a launch paired with a tokenised stock) is priced through a bridge, never more than two
// hops: the side with its own price against WETH/ETH/USDG in the range is the quote (both: the one with more such volume),
// at the median of its ≥ $100 swaps in verified quote pools in the range, else its last such price in the BRIDGE_BLOCKS
// before. Under BRIDGE_MIN_USD of that volume: no price, never a guess (rule shared with the app's onchain-market pricing).
import { insert, inSpan, rows, span } from "../ch.ts";
import { NATIVE_ETH, USDG, WETH } from "../chain/constants.ts";

export const QUOTE_DECIMALS: Record<string, number> = { [USDG]: 6, [WETH]: 18, [NATIVE_ETH]: 18 };
const isEth = (a: string) => a === WETH || a === NATIVE_ETH;

/** A bridge quote for a range: its decimals, USD price and USD volume against a quote asset. */
export type Bridge = { dec: number; usd: number; vol: number };
const BRIDGE_BLOCKS = 20_000, BRIDGE_MIN_USD = 1_000; // ~35 min of chain

/** The pool's token and quote side. An ETH/USDG pool prices ETH in USDG; WETH/ETH pools: null; token/token pools: the
 *  bridge side is the quote (both bridges: the one with more volume), null without one. */
export function sides(t0: string, t1: string, bridges?: Map<string, Bridge>): { token: string; quote: string; tokenIs0: boolean } | null {
  const q0 = t0 in QUOTE_DECIMALS, q1 = t1 in QUOTE_DECIMALS;
  if (q0 && q1) {
    if (t1 === USDG && isEth(t0)) return { token: t0, quote: t1, tokenIs0: true };
    if (t0 === USDG && isEth(t1)) return { token: t1, quote: t0, tokenIs0: false };
    return null;
  }
  if (q1) return { token: t0, quote: t1, tokenIs0: true };
  if (q0) return { token: t1, quote: t0, tokenIs0: false };
  const b0 = bridges?.get(t0), b1 = bridges?.get(t1);
  if (b0 && (!b1 || b0.vol >= b1.vol)) return { token: t1, quote: t0, tokenIs0: false };
  if (b1) return { token: t0, quote: t1, tokenIs0: true };
  return null;
}

export type Swap = { venue: "v2" | "v3" | "v4" | "curve" | "omm"; a0: string; a1: string; sqrt: string; token0: string; token1: string };

/** PURE. Trader-side deltas (+ = received), price in quote per token (human units), quote amount. null when
 *  the pool isn't against a quote asset, the token's decimals are unknown, or the swap moved no token. */
export function priceSwap(s: Swap, tokenDecimals: number | undefined, ethUsd: number | null, bridges?: Map<string, Bridge>) {
  const side = sides(s.token0, s.token1, bridges);
  if (!side || tokenDecimals === undefined || tokenDecimals < 0) return null;
  // Emitted amounts are pool-side on v2/v3 and trader-side on v4 (measured, see the migration).
  const flip = (a: string) => (s.venue === "v4" ? BigInt(a) : -BigInt(a));
  const d0 = flip(s.a0), d1 = flip(s.a1);
  const tokenDelta = side.tokenIs0 ? d0 : d1, quoteDelta = side.tokenIs0 ? d1 : d0;
  if (tokenDelta === 0n) return null;
  const b = bridges?.get(side.quote), dq = QUOTE_DECIMALS[side.quote] ?? b!.dec;
  let raw: number;
  const sqrt = Number(BigInt(s.sqrt));
  if (s.venue !== "v2" && sqrt > 0) {
    const r = sqrt / 2 ** 96;
    raw = side.tokenIs0 ? r * r : 1 / (r * r);
  } else raw = Math.abs(Number(quoteDelta) / Number(tokenDelta));
  const price = raw * 10 ** (tokenDecimals - dq);
  const quoteAmount = Math.abs(Number(quoteDelta)) / 10 ** dq;
  const toUsd = side.quote === USDG ? 1 : b ? b.usd : ethUsd ?? 0;
  return { ...side, tokenDelta, quoteDelta, price, quoteAmount, priceUsd: price * toUsd, usd: quoteAmount * toUsd };
}

let ethUsd: number | null = null;

/** Price every swap in (from, to] whose pool is resolved; returns rows written. venue (src/tools/venue-backfill.ts): only
 *  that venue's swaps, priced at the ETH/USD the range already holds (its other swaps are priced already). */
export async function derivePrices(from: number, to: number, venue?: "curve" | "omm"): Promise<number> {
  if (venue) {
    const [r] = await rows<{ p: number }>("SELECT eth_usd AS p FROM ev_prices WHERE block <= {to:UInt64} AND block > {from:UInt64} - 20000 AND eth_usd > 0 ORDER BY block DESC LIMIT 1", { from, to });
    return priceRange(from, to, venue, Number(r?.p ?? 0) || null);
  }
  if (ethUsd === null) {
    ethUsd = Number((await rows<{ p: number }>(
      `SELECT price AS p FROM ev_prices WHERE token IN ({w:String}, {n:String}) AND quote = {u:String} AND verified = 1 ORDER BY block DESC, log_index DESC LIMIT 1`,
      { w: WETH, n: NATIVE_ETH, u: USDG },
    ))[0]?.p ?? 0) || null;
  }
  return priceRange(from, to, undefined, null);
}

async function priceRange(from: number, to: number, venue: string | undefined, fixedEthUsd: number | null): Promise<number> {
  const only = venue ? `AND venue = '${venue}'` : "";
  const swaps = await rows<Swap & { block: string; tx_index: number; log_index: number; tx_hash: string; time: string; pool: string; tx_from: string; verified: number }>(
    `SELECT s.block, s.tx_index, s.log_index, s.tx_hash, s.time, s.venue, s.pool, toString(s.amount0) AS a0, toString(s.amount1) AS a1,
       toString(s.sqrt_price_x96) AS sqrt, s.tx_from, p.token0, p.token1, p.verified
     FROM ev_swaps AS s INNER JOIN (SELECT pool, token0, token1, verified FROM pools FINAL WHERE ok = 1
       AND pool IN (SELECT pool FROM ev_swaps WHERE block > {from:UInt64} AND block <= {to:UInt64} AND ${inSpan()} ${only})) AS p USING pool
     WHERE s.block > {from:UInt64} AND s.block <= {to:UInt64} AND ${inSpan("s.time")} AND s.sign = 1 ${only.replace("venue", "s.venue")} ORDER BY s.block, s.log_index`,
    { from, to, ...await span(from, to) },
  );
  const tokens = [...new Set(swaps.flatMap((s) => [s.token0, s.token1]))].filter((t) => !(t in QUOTE_DECIMALS));
  const decimals = new Map((await rows<{ token: string; decimals: number }>(
    "SELECT token, decimals FROM serve_tokens FINAL WHERE token IN {t:Array(String)}", { t: tokens },
  )).map((r) => [r.token, r.decimals]));
  for (const [q, d] of Object.entries(QUOTE_DECIMALS)) decimals.set(q, d);

  // ETH/USD for this range: median of ETH/USDG swaps worth ≥ $100 in verified pools (one decoy can't move it).
  const ethPrices = swaps.filter((s) => s.verified)
    .map((s) => priceSwap(s, decimals.get(sides(s.token0, s.token1)?.token ?? ""), 1))
    .filter((p) => p && isEth(p.token) && p.quote === USDG && p.quoteAmount >= 100).map((p) => p!.price).sort((a, b) => a - b);
  if (fixedEthUsd != null) ethUsd = fixedEthUsd; // ponytail: the backfill sets the module's ETH/USD; the live projector's next range resets it
  else if (ethPrices.length) ethUsd = ethPrices[Math.floor(ethPrices.length / 2)];

  const bridges = await bridgesOf(from, swaps, decimals);
  const out = [];
  for (const s of swaps) {
    const p = priceSwap(s, decimals.get(sides(s.token0, s.token1, bridges)?.token ?? ""), ethUsd, bridges);
    if (!p) continue;
    out.push({
      block: s.block, tx_index: s.tx_index, log_index: s.log_index, tx_hash: s.tx_hash, time: s.time, pool: s.pool, venue: s.venue,
      token: p.token, quote: p.quote, token_delta: p.tokenDelta.toString(), quote_delta: p.quoteDelta.toString(),
      quote_amount: p.quoteAmount, usd: p.usd, price: p.price, price_usd: p.priceUsd, eth_usd: ethUsd ?? 0,
      tx_from: s.tx_from, verified: s.verified, sign: 1,
    });
  }
  await insert("ev_prices", out, `${venue ? venue + "-" : ""}prices:${from}-${to}`);
  return out.length;
}

/** The bridges for a range's token/token pools: either side priced against a quote asset in the range (verified pools,
 *  swaps ≥ $100), else in the BRIDGE_BLOCKS before it (ev_prices); kept when that volume reaches BRIDGE_MIN_USD. */
async function bridgesOf(from: number, swaps: (Swap & { verified: number })[], decimals: Map<string, number>): Promise<Map<string, Bridge>> {
  const need = [...new Set(swaps.filter((s) => !(s.token0 in QUOTE_DECIMALS) && !(s.token1 in QUOTE_DECIMALS)).flatMap((s) => [s.token0, s.token1]))]
    .filter((t) => (decimals.get(t) ?? -1) >= 0), needs = new Set(need);
  if (!need.length) return new Map();
  const here = new Map<string, number[]>(), vol = new Map<string, number>();
  for (const s of swaps) {
    if (!s.verified) continue;
    const p = priceSwap(s, decimals.get(sides(s.token0, s.token1)?.token ?? ""), ethUsd);
    if (!p || p.usd < 100 || !needs.has(p.token)) continue;
    (here.get(p.token) ?? here.set(p.token, []).get(p.token)!).push(p.priceUsd);
    vol.set(p.token, (vol.get(p.token) ?? 0) + p.usd);
  }
  const before = new Map<string, number>();
  for (let i = 0; i < need.length; i += 300) { // query parameters travel in the URL
    for (const r of await rows<{ token: string; pu: number; vu: number }>(
      `SELECT token, argMax(price_usd, (block, log_index)) AS pu, sum(usd) AS vu FROM ev_prices
       WHERE token IN {t:Array(String)} AND quote IN ({w:String}, {n:String}, {u:String}) AND verified = 1 AND usd >= 100 AND sign = 1
         AND block > {lo:UInt64} AND block <= {from:UInt64} GROUP BY token`,
      { t: need.slice(i, i + 300), w: WETH, n: NATIVE_ETH, u: USDG, lo: Math.max(0, from - BRIDGE_BLOCKS), from })) {
      before.set(r.token, Number(r.pu));
      vol.set(r.token, (vol.get(r.token) ?? 0) + Number(r.vu));
    }
  }
  const out = new Map<string, Bridge>();
  for (const t of need) {
    const ps = here.get(t)?.sort((a, b) => a - b), usd = ps ? ps[Math.floor(ps.length / 2)] : before.get(t);
    if (usd && (vol.get(t) ?? 0) >= BRIDGE_MIN_USD) out.set(t, { dec: decimals.get(t)!, usd, vol: vol.get(t)! });
  }
  return out;
}
