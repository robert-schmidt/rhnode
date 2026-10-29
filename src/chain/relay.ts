// Relay fills read off the chain. `fillOf` is ported from an earlier bot's relay reader, with two changes,
// both from real txs (fixtures/relay32.json, 2026-10-29):
// 1. The router is a parameter: fills moved to the v3.2 router, which hands off the same way as V3.
// 2. The v3.2 router also routes smart-wallet SELLS (token in from the user, sold into a pool, stable back).
//    The old rule read the token leaving for the pool as a buy by the pool. A token sent to an address
//    that paid USDG/WETH back to the router in the same tx is a sale into that pool, not a delivery.
import { RELAY_CONTRACTS, USDG, WETH } from "./constants.ts";

export const RELAY_ROUTER = "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f"; // RelayRouterV3 — it hands the bought token to the buyer
/** v3.2 router: found in our ingested txs 2026-10-29 (189 router txs in ~3 min vs 1 on V3); a 7,185-byte contract. */
export const RELAY_ROUTER_V32 = "0x0729e2a4716d9f7dd17858d5d504426d228697f7";
export const RELAY_ROUTERS = [RELAY_ROUTER_V32, RELAY_ROUTER];
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const addr = (topic: string) => `0x${topic.slice(-40).toLowerCase()}`;
/** A Transfer's value — some tokens log an empty `0x` (seen 2026-10-01; it stalled the cursor). */
const amount = (data: string): bigint => (data && data !== "0x" ? BigInt(data) : 0n);
const usdg = USDG.toLowerCase(), weth = WETH.toLowerCase();

type Log = { address: string; topics: string[]; data: string; transactionHash?: string; blockNumber?: string };
export type ChainFill = { hash: string; recipient: string; token: string; raw: bigint; usdgIn: bigint; wethIn: bigint; block: number | null };

/** PURE. One fill transaction's logs → the buy it delivered, or null. The bought
 *  token is the last non-stable Transfer FROM the router to a non-Relay address;
 *  the money is the USDG / WETH Transfers INTO it. */
export function fillOf(hash: string, logs: Log[], router: string = RELAY_ROUTER): ChainFill | null {
  let out: Log | null = null, usdgIn = 0n, wethIn = 0n;
  const transfers = logs.filter((l) => l.topics?.[0]?.toLowerCase() === TRANSFER && l.topics.length >= 3);
  const paidBack = new Set(transfers.filter((l) => addr(l.topics[2]) === router && [usdg, weth].includes(l.address.toLowerCase())).map((l) => addr(l.topics[1])));
  for (const l of transfers) {
    const token = l.address.toLowerCase(), from = addr(l.topics[1]), to = addr(l.topics[2]);
    if (to === router && from !== router && !RELAY_CONTRACTS.has(from)) {
      if (token === usdg) usdgIn += amount(l.data);
      else if (token === weth) wethIn += amount(l.data);
    }
    if (from === router && token !== usdg && token !== weth && !RELAY_CONTRACTS.has(to) && !paidBack.has(to) && amount(l.data) > 0n) out = l;
  }
  if (!out) return null;
  return { hash: hash.toLowerCase(), recipient: addr(out.topics[2]), token: out.address.toLowerCase(), raw: amount(out.data), usdgIn, wethIn,
    block: out.blockNumber ? parseInt(out.blockNumber, 16) : null };
}
