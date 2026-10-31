import { test } from "node:test";
import assert from "node:assert/strict";
import { deduceMarkets, foldWindow, perMinute, since, type Tf } from "./early.ts";

const A = (c: string) => "0x" + c.repeat(40), CURVE = A("c"), W1 = A("1"), W2 = A("2"), W3 = A("3"), SIDE = A("5");
let k = 0;
const t = (block: number, from: string, to: string, amount: bigint, tx = `0x${++k}`, ts = 1000 + block): Tf =>
  ({ block, tx_index: 0, log_index: k, tx_hash: tx, from, to, amount, ts });

test("foldWindow: net-positive recipients in order of first receipt; a flip in-window nets out; the curve is skipped", () => {
  const tape = [t(1, CURVE, W2, 50n), t(1, CURVE, W1, 100n), t(2, W1, CURVE, 100n), t(3, CURVE, W3, 30n), t(3, W2, SIDE, 20n)];
  const f = foldWindow(tape, new Set([CURVE]));
  assert.deepEqual(f.map((x) => [x.wallet, x.bought, x.net]), [[W2, 50n, 30n], [W3, 30n, 30n], [SIDE, 20n, 20n]]);
  assert.equal(f[0].from, CURVE);
});

test("deduceMarkets: the address on one side of most txs, unless the known ones explain half the tape", () => {
  const tape = [1, 2, 3, 4, 5].map((i) => t(i, CURVE, A(String(i)), 1n));
  assert.deepEqual([...deduceMarkets(tape, new Set())], [CURVE]);
  assert.equal(deduceMarkets(tape, new Set([CURVE])).size, 0);
  assert.equal(deduceMarkets(tape.slice(0, 3), new Set()).size, 0); // too little tape
});

test("since: max held, first outflow (any) and first outflow to a market", () => {
  const s = since([t(1, CURVE, W1, 100n), t(5, W1, SIDE, 40n), t(9, W1, CURVE, 50n), t(12, CURVE, W1, 5n)], new Set([W1]), new Set([CURVE])).get(W1)!;
  assert.deepEqual([s.max, s.bal, s.out, s.sell], [100n, 15n, 5, 9]);
});

test("perMinute: new buyers and net inflow per minute after launch; wallet-to-wallet moves net out", () => {
  const m = perMinute([t(1, CURVE, W1, 10n, "a", 1000), t(2, CURVE, W2, 5n, "b", 1030), t(3, W1, W2, 4n, "c", 1065), t(4, W2, CURVE, 2n, "d", 1070)],
    new Set([CURVE]), 1000, 2);
  assert.deepEqual(m, [{ minute: 0, new_buyers: 2, net_inflow: "15", txs: 2 }, { minute: 1, new_buyers: 0, net_inflow: "-2", txs: 2 }]);
});
