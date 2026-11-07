// Relay fills read off the chain. `fillOf` is ported from an earlier bot's relay reader, with two changes,
// both from real txs (fixtures/relay32.json, 2026-10-29):
// 1. The router is a parameter: fills moved to the v3.2 router, which hands off the same way as V3.
// 2. The v3.2 router also routes smart-wallet SELLS (token in from the user, sold into a pool, stable back).
//    The old rule read the token leaving for the pool as a buy by the pool. A token sent to an address
//    that paid USDG/WETH back to the router in the same tx is a sale into that pool, not a delivery.
//    A v4 pool paying native ETH logs no Transfer back (18.5K fills named the PoolManager as the buyer,
//    2026-11-07), so an address that emitted a swap log in the tx is a pool too, never a buyer.
import { RELAY_CONTRACTS, USDG, WETH } from "./constants.ts";
import { PONS_CURVE_BUY, PONS_CURVE_SELL, SWAP_METRIC, SWAP_PANCAKE_V3, SWAP_V2, SWAP_V3, SWAP_V4 } from "./swaplog.ts";

export const RELAY_ROUTER = "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f"; // RelayRouterV3 — it hands the bought token to the buyer
/** v3.2 router: found in our ingested txs 2026-10-29 (189 router txs in ~3 min vs 1 on V3); a 7,185-byte contract. */
export const RELAY_ROUTER_V32 = "0x0729e2a4716d9f7dd17858d5d504426d228697f7";
export const RELAY_ROUTERS = [RELAY_ROUTER_V32, RELAY_ROUTER];
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const addr = (topic: string) => `0x${topic.slice(-40).toLowerCase()}`;
/** A Transfer's value — some tokens log an empty `0x` (seen 2026-10-01; it stalled the cursor). */
const amount = (data: string): bigint => (data && data !== "0x" ? BigInt(data) : 0n);
const usdg = USDG.toLowerCase(), weth = WETH.toLowerCase();

const SWAPS = new Set([SWAP_V2, SWAP_V3, SWAP_V4, SWAP_PANCAKE_V3, SWAP_METRIC, PONS_CURVE_BUY, PONS_CURVE_SELL].map((t) => t.toLowerCase()));
const BURNS = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"]);
/** Addresses that emitted a swap log: pools (the v4 PoolManager for every v4 pool). */
const swappers = (logs: Log[]) => new Set(logs.filter((l) => SWAPS.has(l.topics?.[0]?.toLowerCase())).map((l) => l.address.toLowerCase()));

type Log = { address: string; topics: string[]; data: string; transactionHash?: string; blockNumber?: string };
export type ChainFill = { hash: string; recipient: string; token: string; raw: bigint; usdgIn: bigint; wethIn: bigint; block: number | null };

/** PURE. One fill transaction's logs → the buy it delivered, or null. The bought
 *  token is the last non-stable Transfer FROM the router to a non-Relay address;
 *  the money is the USDG / WETH Transfers INTO it. */
export function fillOf(hash: string, logs: Log[], router: string = RELAY_ROUTER): ChainFill | null {
  let out: Log | null = null, usdgIn = 0n, wethIn = 0n;
  const transfers = logs.filter((l) => l.topics?.[0]?.toLowerCase() === TRANSFER && l.topics.length >= 3);
  const paidBack = new Set(transfers.filter((l) => addr(l.topics[2]) === router && [usdg, weth].includes(l.address.toLowerCase())).map((l) => addr(l.topics[1])));
  for (const p of swappers(logs)) paidBack.add(p);
  for (const [i, l] of transfers.entries()) {
    const token = l.address.toLowerCase(), from = addr(l.topics[1]), to = addr(l.topics[2]);
    if (to === router && from !== router && !RELAY_CONTRACTS.has(from)) {
      if (token === usdg) usdgIn += amount(l.data);
      else if (token === weth) wethIn += amount(l.data);
    }
    // not a buyer: the token contract itself (a tax token's fee leg), a burn, or a hop that sends the token on later
    if (from === router && token !== usdg && token !== weth && to !== token && !BURNS.has(to) && !RELAY_CONTRACTS.has(to) && !paidBack.has(to)
      && amount(l.data) > 0n && !transfers.some((m, j) => j > i && m.address.toLowerCase() === token && addr(m.topics[1]) === to)) out = l;
  }
  if (!out) return null;
  return { hash: hash.toLowerCase(), recipient: addr(out.topics[2]), token: out.address.toLowerCase(), raw: amount(out.data), usdgIn, wethIn,
    block: out.blockNumber ? parseInt(out.blockNumber, 16) : null };
}

/** The proxy path (found 2026-11-03: 75,113 fills since go-live that fillOf missed, vs 86.7K on the v3.2 router): a solver
 *  calls RELAY_PROXY, and the executor 0x0005ea38… wraps the ETH, swaps, and delivers. In 349 of a 400-tx sample the
 *  executor hands the token to the buyer; in ~12% the last pool sends it to the buyer directly. */
export const RELAY_PROXY = "0xa834e70303322d86e5dae95ee47e9c6a073d9812";
export const RELAY_EXECUTOR = "0x0005ea38eb0a69d1253508ebdbdb9ea8cb26b5ef";

/** PURE. A proxy fill's logs → the buy, or null. A delivery is a non-stable Transfer from the executor, or from an address
 *  the executor paid (a pool), to an address that sends nothing in the tx (a pool or hop forwards; a buyer doesn't); of
 *  the last delivered token, the biggest such Transfer (a fee split sends a small one too). The money is what came into
 *  the executor from addresses it didn't pay: the solver's ETH, wrapped (WETH minted to it), or USDG/WETH sent in. */
export function proxyFillOf(hash: string, logs: Log[]): ChainFill | null {
  const x = RELAY_EXECUTOR, transfers = logs.filter((l) => l.topics?.[0]?.toLowerCase() === TRANSFER && l.topics.length >= 3);
  // not the zero address: WETH minted to the executor and burned again to pay an ETH pool is still the solver's money
  const paid = new Set(transfers.filter((l) => addr(l.topics[1]) === x && !/^0x0{40}$/.test(addr(l.topics[2]))).map((l) => addr(l.topics[2])));
  const senders = new Set([...transfers.map((l) => addr(l.topics[1])), ...swappers(logs)]);
  let usdgIn = 0n, wethIn = 0n;
  const outs: Log[] = [];
  for (const l of transfers) {
    const token = l.address.toLowerCase(), from = addr(l.topics[1]), to = addr(l.topics[2]);
    if (to === x && !paid.has(from)) { // the proxy's own USDG/WETH counts: it is what the solver put in
      if (token === usdg) usdgIn += amount(l.data);
      else if (token === weth) wethIn += amount(l.data);
    }
    if ((from === x || paid.has(from)) && token !== usdg && token !== weth && to !== token && !BURNS.has(to) && !RELAY_CONTRACTS.has(to) && !senders.has(to) && amount(l.data) > 0n) outs.push(l);
  }
  if (!outs.length) return null;
  const tok = outs[outs.length - 1].address.toLowerCase();
  const out = outs.filter((l) => l.address.toLowerCase() === tok).reduce((a, b) => (amount(b.data) > amount(a.data) ? b : a));
  return { hash: hash.toLowerCase(), recipient: addr(out.topics[2]), token: tok, raw: amount(out.data), usdgIn, wethIn,
    block: out.blockNumber ? parseInt(out.blockNumber, 16) : null };
}
