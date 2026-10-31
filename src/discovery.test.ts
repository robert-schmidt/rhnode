import { test } from "node:test";
import assert from "node:assert/strict";
import { minterOf } from "./discovery.ts";

const T = "0x1111111111111111111111111111111111111111", PAD = (a: string) => "0x" + "0".repeat(24) + a.slice(2);
const LAUNCHPAD = "0x2222222222222222222222222222222222222222", ROUTER = "0x3333333333333333333333333333333333333333", PM = "0x4444444444444444444444444444444444444444";

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
});
