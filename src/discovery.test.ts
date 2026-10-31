import { test } from "node:test";
import assert from "node:assert/strict";
import { minterOf } from "./discovery.ts";

const T = "0x1111111111111111111111111111111111111111", PAD = (a: string) => "0x" + "0".repeat(24) + a.slice(2);
const Z0 = "0x0000000000000000000000000000000000000000", LAUNCHPAD = "0x2222222222222222222222222222222222222222", ROUTER = "0x3333333333333333333333333333333333333333", PM = "0x4444444444444444444444444444444444444444";

test("minterOf: the first non-infra emitter whose log names the token, never the token or a router", () => {
  const logs = [
    { address: T, topics: ["0xddf2", PAD("0x0000000000000000000000000000000000000000"), PAD(LAUNCHPAD)], data: "0x01" }, // the mint itself
    { address: ROUTER, topics: ["0xaaaa"], data: "0x" }, // a router that forwards: names nothing
    { address: PM, topics: ["0xdd46", "0x" + "ab".repeat(32), PAD(T)], data: "0x" }, // infra naming the token: skipped
    { address: LAUNCHPAD.toUpperCase().replace("0X", "0x"), topics: ["0x8d4a", PAD(T)], data: "0x" }, // the launch event
  ];
  assert.equal(minterOf(T, logs, new Set([PM])), LAUNCHPAD);
  // the token in the data, not a topic (pools.trade's TokenCreated(address, …))
  assert.equal(minterOf(T, [{ address: LAUNCHPAD, topics: ["0x4ef8"], data: "0x" + "0".repeat(24) + T.slice(2) }], new Set()), LAUNCHPAD);
  assert.equal(minterOf(T, [logs[0], logs[1]], new Set([PM])), null);
  // Flap: a helper built in this tx names the token first; the Portal comes after
  const HELPER = "0x5555555555555555555555555555555555555555", OWNED = "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0";
  assert.equal(minterOf(T, [{ address: HELPER, topics: [OWNED, PAD(Z0), PAD(LAUNCHPAD)], data: "0x" }, { address: HELPER, topics: ["0x1b1e", PAD(T)], data: "0x" },
    logs[3]], new Set()), LAUNCHPAD);
});

import { curveOf, graduationOf, type Tr } from "./discovery.ts";
const Z = "0x0000000000000000000000000000000000000000", PMGR = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const CURVE = "0xadef44bce48d5b80dad5abfd2d98cd970e70a6c5", FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e";
const w = (i: number) => "0x" + i.toString(16).padStart(40, "0");
const tr = (block: number, tx: string, from: string, to: string, amount: bigint, log_index = 0): Tr => ({ block, log_index, tx_hash: tx, from, to, amount });

test("curveOf: the holder of the mint that is the tape's market; none for a launch straight to a pool or a passive holder", () => {
  const mint = tr(1, "0xm", Z, CURVE, 1000n);
  const buys = [2, 3, 4, 5, 6].map((b) => tr(b, `0xb${b}`, CURVE, w(b), 10n));
  assert.equal(curveOf("0xm", [mint, ...buys], new Set()), CURVE);
  assert.equal(curveOf("0xm", [mint, ...buys], new Set([CURVE])), null); // it's a pool
  // the holder never trades: wallets swap among themselves
  assert.equal(curveOf("0xm", [mint, ...[2, 3, 4, 5].map((b) => tr(b, `0xt${b}`, w(b), w(b + 10), 1n))], new Set()), null);
  // under half the mint
  assert.equal(curveOf("0xm", [tr(1, "0xm", Z, CURVE, 400n), tr(1, "0xm", Z, w(99), 600n), ...buys], new Set()), null);
});

test("graduationOf: the tx that empties the curve into a pool (v4: the PoolManager, the pool created in that block)", () => {
  // STREET's shape (0xf9ee3f…, 2026-10-30): the curve sends its rest via the factory and helpers to the PoolManager
  const flows = [tr(1, "0xm", Z, CURVE, 1000n), tr(2, "0xb", CURVE, w(1), 700n), tr(9, "0xg", CURVE, w(2), 7n, 1), tr(9, "0xg", CURVE, FACTORY, 293n, 2)];
  const txs = new Map([["0xg", [flows[2], flows[3], tr(9, "0xg", FACTORY, w(3), 293n, 3), tr(9, "0xg", w(3), PMGR, 290n, 4)]]]);
  const pools = [{ pool: "0xdecoy", venue: "v4", created_block: 5, hooks: "" }, { pool: "0xofficial", venue: "v4", created_block: 9, hooks: "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044" }];
  assert.deepEqual(graduationOf(CURVE, flows, txs, pools), { block: 9, tx: "0xg", pool: "0xofficial", venue: "v4" });
  // emptied to a wallet, no pool in the tx: not a graduation
  assert.equal(graduationOf(CURVE, [flows[0], flows[1], tr(9, "0xd", CURVE, w(7), 300n)], new Map([["0xd", [tr(9, "0xd", CURVE, w(7), 300n)]]]), pools), null);
  // v2: the pair itself
  assert.deepEqual(graduationOf(CURVE, [flows[0], tr(9, "0xg2", CURVE, "0xpair", 1000n)], new Map([["0xg2", [tr(9, "0xg2", CURVE, "0xpair", 1000n)]]]),
    [{ pool: "0xpair", venue: "v2", created_block: 9, hooks: "" }]), { block: 9, tx: "0xg2", pool: "0xpair", venue: "v2" });
  // still trading: none
  assert.equal(graduationOf(CURVE, flows.slice(0, 2), txs, pools), null);
});
