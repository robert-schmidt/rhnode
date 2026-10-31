import { test } from "node:test";
import assert from "node:assert/strict";
import { band, poolState } from "./cards.ts";

const near = (a: number | null | undefined, b: number, tol = 1e-9) => assert.ok(a != null && Math.abs(a - b) <= Math.abs(b) * tol, `${a} ≠ ${b}`);
const X96 = 2n ** 96n;

test("poolState: price and liquidity from v2 reserves and v3/v4 band amounts, either token order", () => {
  // 1M TOKEN against 100 WETH: 1e-4 WETH per token, $2,000 ETH → $400,000 (both sides)
  const v2 = poolState("v2", true, 18, 18, 2000, { r0: 10n ** 24n, r1: 10n ** 20n })!;
  near(v2.price, 1e-4); near(v2.liquidityUsd, 400_000); near(v2.quoteUsd, 200_000); assert.equal(v2.kind, "reserves");
  // v3, token is token0 at P = 1e-4 (√P = 0.01): the band holds 1M TOKEN + 100 WETH; the pool's balances twice that
  const a = poolState("v3", true, 18, 18, 2000, { sqrt: X96 / 100n, L: 10n ** 22n, b0: 2n * 10n ** 24n, b1: 2n * 10n ** 20n, band: [1e24, 1e20] })!;
  near(a.price, 1e-4); near(a.liquidityUsd, 400_000); assert.equal(a.kind, "active"); near(a.balancesUsd, 800_000);
  // v4, token is token1: P = 1e4 token per WETH; the band holds 100 WETH (token0) + 1M TOKEN (token1)
  const b = poolState("v4", false, 18, 18, 2000, { sqrt: X96 * 100n, L: 10n ** 22n, band: [1e20, 1e24] })!;
  near(b.price, 1e-4); near(b.liquidityUsd, 400_000); near(b.quoteUsd, 200_000); assert.equal(b.balancesUsd, null);
  // one-sided (all token, no WETH in the band): the total is the token side, a sell meets nothing
  const o = poolState("v3", true, 18, 18, 2000, { sqrt: X96 / 100n, L: 1n, band: [1e24, 0] })!;
  near(o.liquidityUsd, 200_000); assert.equal(o.quoteUsd, 0);
  // no band (a failed tick read): liquidity unknown, never the virtual reserves
  assert.equal(poolState("v4", false, 18, 18, 2000, { sqrt: X96 * 100n, L: 10n ** 22n })!.liquidityUsd, null);
  // unknown token decimals: no price; v2 depth is still known (it only needs the quote side)
  const c = poolState("v2", true, null, 6, 1, { r0: 10n ** 24n, r1: 5n * 10n ** 9n })!;
  assert.equal(c.price, null); near(c.liquidityUsd, 10_000);
  assert.equal(poolState("v3", true, 18, 18, 2000, {}), null);
});

test("band: a full-range position gives its reserves, a one-tick position its real size", () => {
  // tick 0 (P = 1), L = 1e20: full range (spacing 60) holds L/√P token0 and L·√P token1
  const L = 10n ** 20n, full = new Map([[-887220, L], [887220, -L]]);
  const [f0, f1] = band(X96, 0, L, full, -887272, 887272);
  near(f0, 1e20, 1e-6); near(f1, 1e20, 1e-6);
  // the same L between ticks -3 and 3 holds L·(1 - 1.0001^-1.5) of each, about 1.5e16, not 1e20
  const [n0, n1] = band(X96, 0, L, new Map([[-3, L], [3, -L]]), -92103, 92103);
  near(n0, 1e20 * (1 - 1.0001 ** -1.5)); near(n1, 1e20 * (1 - 1.0001 ** -1.5));
  // a second position above the price adds only token0 (it is out of range below it)
  const [u0, u1] = band(X96, 0, L, new Map([[-3, L], [3, -L], [600, L], [660, -L]]), -92103, 92103);
  near(u0, n0 + 1e20 * (1.0001 ** -300 - 1.0001 ** -330)); near(u1, n1);
});
