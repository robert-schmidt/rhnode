import { test } from "node:test";
import assert from "node:assert/strict";
import { priceSwap, sides } from "./prices.ts";
import { NATIVE_ETH, USDG, WETH } from "../chain/constants.ts";

const TOKEN = "0x1111111111111111111111111111111111111111";
const Q96 = 2n ** 96n;
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) / b < 1e-9, `${a} vs ${b}`);

test("sides: the non-quote side is the token; ETH/USDG prices ETH; WETH/ETH and token/token are null", () => {
  assert.deepEqual(sides(TOKEN, WETH), { token: TOKEN, quote: WETH, tokenIs0: true });
  assert.deepEqual(sides(NATIVE_ETH, TOKEN), { token: TOKEN, quote: NATIVE_ETH, tokenIs0: false });
  assert.deepEqual(sides(WETH, USDG), { token: WETH, quote: USDG, tokenIs0: true });
  assert.equal(sides(NATIVE_ETH, WETH), null);
  assert.equal(sides(TOKEN, "0x2222222222222222222222222222222222222222"), null);
});

test("v3, token is token0 (18 dec) vs WETH: a buy is negative amount0 (pool paid out), price from sqrtPrice", () => {
  // sqrtPrice for 1 token = 0.0001 WETH (raw ratio 1e-4): sqrt(1e-4) = 0.01 → 0.01 · 2^96
  const p = priceSwap({ venue: "v3", a0: "-5000", a1: "600", sqrt: (Q96 / 100n).toString(), token0: TOKEN, token1: WETH }, 18, 3000)!;
  assert.equal(p.tokenDelta, 5000n, "trader received 5000 token units");
  assert.equal(p.quoteDelta, -600n, "trader paid 600 wei");
  close(p.price, 1e-4);
  close(p.priceUsd, 0.3);
});

test("v4 amounts are trader-side; token as currency1 inverts the price; USDG has 6 decimals", () => {
  // currency0 = USDG, currency1 = token (6 vs 18 decimals). Pool raw price token1/token0 = 1e12 · 4 → 1 token = 0.25 USDG.
  const r = 2n * 10n ** 6n; // sqrt(4e12)
  const p = priceSwap({ venue: "v4", a0: "-250000", a1: "1000000000000000000", sqrt: (r * Q96).toString(), token0: USDG, token1: TOKEN }, 18, 3000)!;
  assert.equal(p.tokenDelta, 10n ** 18n, "v4 positive amount1 = the trader received 1 token");
  close(p.price, 0.25);
  close(p.priceUsd, 0.25);
  close(p.usd, 0.25);
});

test("v2: execution price from the amounts; unknown decimals or no token moved → null", () => {
  const p = priceSwap({ venue: "v2", a0: "2000000000000000000", a1: "-1000000000000000", sqrt: "0", token0: TOKEN, token1: WETH }, 18, null)!;
  assert.equal(p.tokenDelta, -2n * 10n ** 18n, "a sell: 2 tokens into the pool");
  close(p.price, 0.0005);
  assert.equal(p.usd, 0, "no ETH/USD known yet: usd unknown, not invented");
  assert.equal(priceSwap({ venue: "v2", a0: "1", a1: "-1", sqrt: "0", token0: TOKEN, token1: WETH }, -1, 3000), null);
  assert.equal(priceSwap({ venue: "v3", a0: "0", a1: "5", sqrt: Q96.toString(), token0: TOKEN, token1: WETH }, 18, 3000), null);
});

test("curve: execution price like v2 (0.05 ETH for 2.8059e7 tokens), a buy is +tokens to the trader", () => {
  const p = priceSwap({ venue: "curve", a0: (-28059n * 10n ** 21n).toString(), a1: "50000000000000000", sqrt: "0", token0: TOKEN, token1: NATIVE_ETH }, 18, 3000)!;
  assert.equal(p.tokenDelta, 28059n * 10n ** 21n);
  close(p.price, 0.05 / 28_059_000);
  close(p.usd, 150);
});
