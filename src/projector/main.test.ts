import { test } from "node:test";
import assert from "node:assert/strict";
import { dueTokens } from "./main.ts";

test("dueTokens: a big token waits 5 min between projections, the rest go every tick", () => {
  const big = new Map([["0xweth", 1_000_000]]);
  assert.deepEqual(dueTokens(["0xweth", "0xmeme"], big, 1_000_000 + 60_000), ["0xmeme"]);
  assert.deepEqual(dueTokens(["0xweth", "0xmeme"], big, 1_000_000 + 300_000), ["0xweth", "0xmeme"]);
});
