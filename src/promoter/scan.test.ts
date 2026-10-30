import { test } from "node:test";
import assert from "node:assert/strict";
import { pointers } from "./scan.ts";

test("pointers: sender, recipient and created contract once each; ArbOS's tx left out; an edge for each tx with value", () => {
  const A = "0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0", B = "0x00000000000000000000000000000000000000bb";
  const got = pointers({ number: "0x10", timestamp: "0x6900", transactions: [
    { hash: "0x01", from: "0x00000000000000000000000000000000000a4b05", to: "0x00000000000000000000000000000000000a4b05", nonce: "0x0", transactionIndex: "0x0", type: "0x6a", value: "0x5" },
    { hash: "0x02", from: A.toUpperCase().replace("0X", "0x"), to: B, nonce: "0x5", transactionIndex: "0x1", type: "0x2", value: "0xde0b6b3a7640000" },
    { hash: "0x03", from: A, to: A, nonce: "0x6", transactionIndex: "0x2", type: "0x2", value: "0x0" },
    { hash: "0x04", from: A, to: null, nonce: "0x0", transactionIndex: "0x3", type: "0x2", value: "0x1" },
  ] });
  const C = "0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d";
  assert.deepEqual(got.edges, [
    { dst: B, src: A, value: "1000000000000000000", block: 16, tx_index: 1, path: "", type: 2, time: 26880, hash: "0x02" },
    { dst: C, src: A, value: "1", block: 16, tx_index: 3, path: "", type: 2, time: 26880, hash: "0x04" },
  ]);
  assert.deepEqual(got.rows, [
    { wallet: A, block: 16, tx_index: 1 }, { wallet: B, block: 16, tx_index: 1 },
    { wallet: A, block: 16, tx_index: 2 },
    { wallet: A, block: 16, tx_index: 3 }, { wallet: C, block: 16, tx_index: 3 },
  ]);
});
