// The swap decoder feeds stored trades and the live price. Synthetic logs with
// the exact ABI layout of each venue, including negative amounts and ticks —
// the sign-extension is the part that is easy to get silently wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeSwap, SWAP_V2, SWAP_V3, SWAP_V4, PONS_CURVE_BUY, PONS_CURVE_SELL } from "./swaplog.ts";

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

test("Pons v2 curve: the buy and sell of 0x08f1387c… / 0xae3a30b4… as curve-side in − out (token0 the token, token1 ETH)", () => {
  const w = (h: string) => h.replace(/^0x/, "").padStart(64, "0"), t = (a: string) => "0x" + a.padStart(64, "0");
  const buy = decodeSwap({ address: "0x0547AA29", topics: [PONS_CURVE_BUY, t("e33e9e47"), t("ff48814b")],
    data: "0x" + w("b1a2bc2ec50000") + w("1735ba04a1e116f64acb0d") + w("1c6bf526340000") + w("38d7ea4c68000") })!;
  assert.equal(buy.venue, "curve");
  assert.equal(buy.pool, "0x0547aa29");
  assert.equal(buy.amount1, 50_000_000_000_000_000n, "0.05 ETH into the curve");
  assert.equal(buy.amount0, -0x1735ba04a1e116f64acb0dn, "tokens out of the curve");
  const sell = decodeSwap({ address: "0x0547aa29", topics: [PONS_CURVE_SELL, t("811e8c8f"), t("8f84cd1b")],
    data: "0x" + w("315220e8c3f12403f770c") + w("1fb4d9f5cb59fb") + w("53adcb1c7cf8") + w("a75b9638f9f0") })!;
  assert.deepEqual([sell.amount0 > 0n, sell.amount1], [true, -0x1fb4d9f5cb59fbn]);
  assert.equal(decodeSwap({ address: "0x1", topics: [PONS_CURVE_BUY, t("1")], data: "0x" + w("1") + w("2") }), null, "a malformed one");
});
