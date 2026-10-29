import { test } from "node:test";
import assert from "node:assert/strict";
import { tradesOfTx } from "./trades.ts";
import { USDG, WETH } from "../chain/constants.ts";

const A = "0x00000000000000000000000000000000000000a1", B = "0x00000000000000000000000000000000000000b2";
const ROUTER = "0x00000000000000000000000000000000000000ee", POOL = "0x00000000000000000000000000000000000000ff";
const TOKEN = "0x1111111111111111111111111111111111111111";
const tr = (log_index: number, token: string, from: string, to: string, amount: bigint) => ({ log_index, token, from, to, amount: amount.toString() });
const px = (log_index: number, token_delta: bigint, usd: number, quote = WETH, quote_amount = 0.01) => ({ log_index, token: TOKEN, quote, token_delta: token_delta.toString(), usd, quote_amount });

test("a router buy is the signer's buy, valued by the swap", () => {
  const t = tradesOfTx(A, [tr(1, WETH, A, ROUTER, 10n), tr(2, WETH, ROUTER, POOL, 10n), tr(3, TOKEN, POOL, ROUTER, 500n), tr(5, TOKEN, ROUTER, A, 500n)], [px(4, 500n, 23)], []);
  assert.deepEqual(t, [{ wallet: A, token: TOKEN, amount: 500n, usd: 23, eth: 0.01, via: "swap" }]);
});

test("a sell: the wallet's balance went down; a USDG-quoted swap has no ETH part", () => {
  const t = tradesOfTx(A, [tr(1, TOKEN, A, POOL, 300n), tr(2, USDG, POOL, A, 7n)], [px(3, -300n, 7, USDG, 7)], []);
  assert.deepEqual(t, [{ wallet: A, token: TOKEN, amount: -300n, usd: 7, eth: 0, via: "swap" }]);
});

test("a solver moving tokens for someone else is not the solver's trade", () => {
  assert.deepEqual(tradesOfTx(A, [tr(1, TOKEN, POOL, ROUTER, 500n), tr(3, TOKEN, ROUTER, B, 500n)], [px(2, 500n, 23)], []), []);
});

test("an ERC-4337 bundle: each userOp's sender owns the logs before its UserOperationEvent", () => {
  const bundler = "0x00000000000000000000000000000000000000cc";
  const t = tradesOfTx(bundler,
    [tr(1, TOKEN, POOL, A, 100n), tr(4, TOKEN, B, POOL, 40n)],
    [px(2, 100n, 5), px(5, -40n, 2)],
    [{ log_index: 3, sender: A }, { log_index: 6, sender: B }]);
  assert.deepEqual(t, [
    { wallet: A, token: TOKEN, amount: 100n, usd: 5, eth: 0.01, via: "userop" },
    { wallet: B, token: TOKEN, amount: -40n, usd: 2, eth: 0.01, via: "userop" },
  ]);
});
