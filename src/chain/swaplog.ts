// Swap logs, decoded once, for everyone who reads them.
//
// A live WebSocket receives every Swap in every pool the
// book holds, and paid for the bytes. It used to take one word — the price —
// and drop the rest. Decoded here in full so the same bytes can be stored
// (pool_swaps, migration 083) and read by whatever needs a trade: the tape,
// the chart, backtests.
//
// Amounts are kept AS EMITTED. The venues disagree on whose side a delta is
// counted from, and normalising it here without checking against a known
// transaction would store a guess as a fact — a consumer normalises where it
// reads, with a test. v2 has no signed amounts, so its in/out pairs are stored
// as in − out per token.
import { toEventSelector } from "viem";

export const SWAP_V2 = toEventSelector("Swap(address,uint256,uint256,uint256,uint256,address)");
export const SWAP_V3 = toEventSelector("Swap(address,address,int256,int256,uint160,uint128,int24)");
export const SWAP_V4 = toEventSelector("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");

export type SwapLog = {
  venue: "v2" | "v3" | "v4";
  /** v2/v3: the pool contract; v4: the poolId (the PoolManager emits for every pool). */
  pool: string;
  sender: string;
  /** v2 `to`, v3 `recipient`; v4 names none. */
  recipient: string | null;
  amount0: bigint;
  amount1: bigint;
  /** null on v2: a pair has no price word. */
  sqrtPriceX96: bigint | null;
  liquidity: bigint | null;
  tick: number | null;
  /** v4 only: the fee the swap actually paid, in hundredths of a bip. */
  fee: number | null;
};

const word = (hex: string, i: number) => hex.slice(64 * i, 64 * (i + 1));
const uint = (w: string) => BigInt("0x" + w);
// ABI sign-extends every intN to 256 bits, so one rule decodes int24, int128 and int256.
const int = (w: string) => { const v = uint(w); return v >= 1n << 255n ? v - (1n << 256n) : v; };
const addr = (topic: string | undefined) => (topic ? "0x" + topic.slice(-40).toLowerCase() : "");

/** PURE. A Swap log in full, or null when it is not one of the three events or is malformed. */
export function decodeSwap(log: { address: string; topics: string[]; data: string }): SwapLog | null {
  const t0 = (log.topics[0] ?? "").toLowerCase();
  const hex = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
  try {
    if (t0 === SWAP_V3) {
      if (hex.length < 64 * 5 || log.topics.length < 3) return null;
      return {
        venue: "v3", pool: log.address.toLowerCase(), sender: addr(log.topics[1]), recipient: addr(log.topics[2]),
        amount0: int(word(hex, 0)), amount1: int(word(hex, 1)), sqrtPriceX96: uint(word(hex, 2)), liquidity: uint(word(hex, 3)),
        tick: Number(int(word(hex, 4))), fee: null,
      };
    }
    if (t0 === SWAP_V4) {
      if (hex.length < 64 * 6 || log.topics.length < 3) return null;
      return {
        venue: "v4", pool: (log.topics[1] ?? "").toLowerCase(), sender: addr(log.topics[2]), recipient: null,
        amount0: int(word(hex, 0)), amount1: int(word(hex, 1)), sqrtPriceX96: uint(word(hex, 2)), liquidity: uint(word(hex, 3)),
        tick: Number(int(word(hex, 4))), fee: Number(uint(word(hex, 5))),
      };
    }
    if (t0 === SWAP_V2) {
      if (hex.length < 64 * 4 || log.topics.length < 3) return null;
      return {
        venue: "v2", pool: log.address.toLowerCase(), sender: addr(log.topics[1]), recipient: addr(log.topics[2]),
        amount0: uint(word(hex, 0)) - uint(word(hex, 2)), amount1: uint(word(hex, 1)) - uint(word(hex, 3)),
        sqrtPriceX96: null, liquidity: null, tick: null, fee: null,
      };
    }
    return null;
  } catch { return null; }
}
