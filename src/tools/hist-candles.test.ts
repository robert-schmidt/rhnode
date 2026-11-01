import { test } from "node:test";
import assert from "node:assert/strict";
import { ethUsdAt } from "./hist-candles.ts";

test("ethUsdAt: the bucket's own median, else the last one before it, else the first", () => {
  const med = new Map([[10, 2000], [12, 2100]]), keys = [10, 12]; // buckets of 1,000 blocks
  assert.equal(ethUsdAt(keys, med, 10_500), 2000);
  assert.equal(ethUsdAt(keys, med, 11_999), 2000); // bucket 11 has none: carried forward
  assert.equal(ethUsdAt(keys, med, 12_000), 2100);
  assert.equal(ethUsdAt(keys, med, 99_000), 2100);
  assert.equal(ethUsdAt(keys, med, 5_000), 2000); // before any: the first
  assert.equal(ethUsdAt([], new Map(), 5_000), null);
});
