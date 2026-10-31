import { test } from "node:test";
import assert from "node:assert/strict";
import { flatten } from "./traces.ts";

test("flatten: call order with depth, values in decimal, selector, reverted frames kept", () => {
  const A = "0x" + "AA".repeat(20), R = "0x" + "bb".repeat(20), T = "0x" + "cc".repeat(20);
  const rows = flatten(7, 100, 2, "0xh", {
    type: "CALL", from: A, to: R, value: "0x0", input: "0x12345678ff",
    calls: [
      { type: "CALL", from: R, to: T, value: "0xde0b6b3a7640000", input: "0x", calls: [{ type: "STATICCALL", from: T, to: R, input: "0xabcdef01" }] },
      { type: "CALL", from: R, to: A, value: "0x5", error: "execution reverted" },
    ],
  });
  assert.deepEqual(rows.map((r) => [r.idx, r.depth, r.from, r.to, r.value, r.selector, r.error]), [
    [0, 0, A.toLowerCase(), R, "0", "0x12345678", ""],
    [1, 1, R, T, "1000000000000000000", "", ""],
    [2, 2, T, R, "0", "0xabcdef01", ""],
    [3, 1, R, A.toLowerCase(), "5", "", "execution reverted"],
  ]);
  assert.ok(rows.every((r) => r.block === 7 && r.tx_index === 2 && r.tx_hash === "0xh" && r.time === 100));
});
