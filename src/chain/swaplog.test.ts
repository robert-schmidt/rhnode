// The swap decoder feeds stored trades and the live price. Synthetic logs with
// the exact ABI layout of each venue, including negative amounts and ticks —
// the sign-extension is the part that is easy to get silently wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeSwap, SWAP_V2, SWAP_V3, SWAP_V4 } from "./swaplog.ts";

const w = (n: bigint) => (n < 0n ? (1n << 256n) + n : n).toString(16).padStart(64, "0");
const topicAddr = (a: string) => "0x" + a.slice(2).padStart(64, "0");
const POOL = "0x00000000000000000000000000000000000000aa";
const ROUTER = "0x00000000000000000000000000000000000000bb";
const TRADER = "0x00000000000000000000000000000000000000cc";
const SQRT = 79228162514264337593543950336n;

test("decodeSwap v3: signed amounts, price, liquidity and a negative tick", () => {
  const d = decodeSwap({ address: POOL.toUpperCase().replace("0X", "0x"), topics: [SWAP_V3, topicAddr(ROUTER), topicAddr(TRADER)], data: "0x" + w(-1500n) + w(2000n) + w(SQRT) + w(123456n) + w(-887n) });
  assert.deepEqual(d, { venue: "v3", pool: POOL, sender: ROUTER, recipient: TRADER, amount0: -1500n, amount1: 2000n, sqrtPriceX96: SQRT, liquidity: 123456n, tick: -887, fee: null });
});

test("decodeSwap v4: the poolId from topic 1, the sender from topic 2, the fee word", () => {
  const id = "0x" + "ab".repeat(32);
  const d = decodeSwap({ address: "0x000000000004444c5dc75cb358380d2e3de08a90", topics: [SWAP_V4, id, topicAddr(ROUTER)], data: "0x" + w(7n) + w(-9n) + w(SQRT) + w(1n) + w(42n) + w(3000n) });
  assert.deepEqual(d, { venue: "v4", pool: id, sender: ROUTER, recipient: null, amount0: 7n, amount1: -9n, sqrtPriceX96: SQRT, liquidity: 1n, tick: 42, fee: 3000 });
});

test("decodeSwap v2: no price, in − out per token", () => {
  const d = decodeSwap({ address: POOL, topics: [SWAP_V2, topicAddr(ROUTER), topicAddr(TRADER)], data: "0x" + w(0n) + w(500n) + w(80n) + w(0n) });
  assert.deepEqual(d, { venue: "v2", pool: POOL, sender: ROUTER, recipient: TRADER, amount0: -80n, amount1: 500n, sqrtPriceX96: null, liquidity: null, tick: null, fee: null });
});

test("decodeSwap refuses what it cannot read", () => {
  assert.equal(decodeSwap({ address: POOL, topics: ["0xdeadbeef"], data: "0x" + w(1n) }), null, "not a swap");
  assert.equal(decodeSwap({ address: POOL, topics: [SWAP_V3, topicAddr(ROUTER), topicAddr(TRADER)], data: "0x" + w(1n) + w(2n) }), null, "short data");
  assert.equal(decodeSwap({ address: POOL, topics: [SWAP_V4], data: "0x" + w(1n).repeat(6) }), null, "missing topics");
});
