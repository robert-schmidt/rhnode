// Swap → price (migrations/004_prices.sql). v3/v4 price is the pool's price AFTER the swap (sqrtPriceX96);
// v2 has no price word, so it is the swap's execution price (fee included).
import { insert, rows } from "../ch.ts";
import { NATIVE_ETH, USDG, WETH } from "../chain/constants.ts";

export const QUOTE_DECIMALS: Record<string, number> = { [USDG]: 6, [WETH]: 18, [NATIVE_ETH]: 18 };
const isEth = (a: string) => a === WETH || a === NATIVE_ETH;

/** The pool's token and quote side. An ETH/USDG pool prices ETH in USDG; WETH/ETH and token/token pools: null. */
export function sides(t0: string, t1: string): { token: string; quote: string; tokenIs0: boolean } | null {
  const q0 = t0 in QUOTE_DECIMALS, q1 = t1 in QUOTE_DECIMALS;
  if (q0 && q1) {
    if (t1 === USDG && isEth(t0)) return { token: t0, quote: t1, tokenIs0: true };
    if (t0 === USDG && isEth(t1)) return { token: t1, quote: t0, tokenIs0: false };
    return null;
  }
  if (q1) return { token: t0, quote: t1, tokenIs0: true };
  if (q0) return { token: t1, quote: t0, tokenIs0: false };
  return null;
}

export type Swap = { venue: "v2" | "v3" | "v4"; a0: string; a1: string; sqrt: string; token0: string; token1: string };

/** PURE. Trader-side deltas (+ = received), price in quote per token (human units), quote amount. null when
 *  the pool isn't against a quote asset, the token's decimals are unknown, or the swap moved no token. */
export function priceSwap(s: Swap, tokenDecimals: number | undefined, ethUsd: number | null) {
  const side = sides(s.token0, s.token1);
  if (!side || tokenDecimals === undefined || tokenDecimals < 0) return null;
  // Emitted amounts are pool-side on v2/v3 and trader-side on v4 (measured, see the migration).
  const flip = (a: string) => (s.venue === "v4" ? BigInt(a) : -BigInt(a));
  const d0 = flip(s.a0), d1 = flip(s.a1);
  const tokenDelta = side.tokenIs0 ? d0 : d1, quoteDelta = side.tokenIs0 ? d1 : d0;
  if (tokenDelta === 0n) return null;
  const dq = QUOTE_DECIMALS[side.quote];
  let raw: number;
  const sqrt = Number(BigInt(s.sqrt));
  if (s.venue !== "v2" && sqrt > 0) {
    const r = sqrt / 2 ** 96;
    raw = side.tokenIs0 ? r * r : 1 / (r * r);
  } else raw = Math.abs(Number(quoteDelta) / Number(tokenDelta));
  const price = raw * 10 ** (tokenDecimals - dq);
  const quoteAmount = Math.abs(Number(quoteDelta)) / 10 ** dq;
  const toUsd = side.quote === USDG ? 1 : ethUsd ?? 0;
  return { ...side, tokenDelta, quoteDelta, price, quoteAmount, priceUsd: price * toUsd, usd: quoteAmount * toUsd };
}

let ethUsd: number | null = null;

/** Price every swap in (from, to] whose pool is resolved; returns rows written. */
export async function derivePrices(from: number, to: number): Promise<number> {
  if (ethUsd === null) {
    ethUsd = Number((await rows<{ p: number }>(
      `SELECT price AS p FROM ev_prices WHERE token IN ({w:String}, {n:String}) AND quote = {u:String} AND verified = 1 ORDER BY block DESC, log_index DESC LIMIT 1`,
      { w: WETH, n: NATIVE_ETH, u: USDG },
    ))[0]?.p ?? 0) || null;
  }
  const swaps = await rows<Swap & { block: string; tx_index: number; log_index: number; tx_hash: string; time: string; pool: string; tx_from: string; verified: number }>(
    `SELECT s.block, s.tx_index, s.log_index, s.tx_hash, s.time, s.venue, s.pool, toString(s.amount0) AS a0, toString(s.amount1) AS a1,
       toString(s.sqrt_price_x96) AS sqrt, s.tx_from, p.token0, p.token1, p.verified
     FROM ev_swaps AS s INNER JOIN (SELECT pool, token0, token1, verified FROM pools FINAL WHERE ok = 1
       AND pool IN (SELECT pool FROM ev_swaps WHERE block > {from:UInt64} AND block <= {to:UInt64})) AS p USING pool
     WHERE s.block > {from:UInt64} AND s.block <= {to:UInt64} AND s.sign = 1 ORDER BY s.block, s.log_index`,
    { from, to },
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
  if (ethPrices.length) ethUsd = ethPrices[Math.floor(ethPrices.length / 2)];

  const out = [];
  for (const s of swaps) {
    const p = priceSwap(s, decimals.get(sides(s.token0, s.token1)?.token ?? ""), ethUsd);
    if (!p) continue;
    out.push({
      block: s.block, tx_index: s.tx_index, log_index: s.log_index, tx_hash: s.tx_hash, time: s.time, pool: s.pool, venue: s.venue,
      token: p.token, quote: p.quote, token_delta: p.tokenDelta.toString(), quote_delta: p.quoteDelta.toString(),
      quote_amount: p.quoteAmount, usd: p.usd, price: p.price, price_usd: p.priceUsd, eth_usd: ethUsd ?? 0,
      tx_from: s.tx_from, verified: s.verified, sign: 1,
    });
  }
  await insert("ev_prices", out, `prices:${from}-${to}`);
  return out.length;
}
