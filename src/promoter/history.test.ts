import { test } from "node:test";
import assert from "node:assert/strict";
import { balances, paceStep } from "./history.ts";

test("paceStep: grows while ingest and our node keep up, halves when either trails", () => {
  assert.equal(paceStep(4, 2, 1), 5);
  assert.equal(paceStep(32, 0, 0, 32), 32);
  assert.equal(paceStep(8, 12, 1), 8); // in between: hold
  assert.equal(paceStep(8, 30, 0), 4); // ingest trails
  assert.equal(paceStep(8, 0, 40), 4); // our node trails the chain
  assert.equal(paceStep(1, 99, null), 1);
  assert.equal(paceStep(4, 3, null), 5); // node lag unknown: judged by ingest alone
});

test("balances: ERC-20 only, promoted tokens left out, spam amounts wrap like toInt256", () => {
  const T = "0x" + "11".repeat(20), U = "0x" + "22".repeat(20), A = "0x" + "aa".repeat(20), B = "0x" + "bb".repeat(20);
  const got = balances([
    { token: T, from: A, to: B, amount: "5", standard: "erc20" },
    { token: T, from: B, to: A, amount: "2", standard: "erc20" },
    { token: T, from: A, to: B, amount: "1", standard: "erc721" },
    { token: U, from: A, to: B, amount: "9", standard: "erc20" },
    { token: T, from: B, to: B, amount: (1n << 255n).toString(), standard: "erc20" }, // nets to 0 for B
  ], new Set([U]));
  assert.deepEqual(got, [{ token: T, holder: A, balance: "-3" }, { token: T, holder: B, balance: "3" }]);
});
