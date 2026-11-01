import { test } from "node:test";
import assert from "node:assert/strict";
import { nitro, nitroSynced, step } from "./nitro.ts";

const reset = () => Object.assign(nitro, { head: null, behind: null, since: 0, bad: 0, moved: 0 });
let t = 0, h = 1_000;
const probe = (head: number | null, ref: number | null) => { t += 10_000; step(head, ref, t); return nitroSynced(); };

test("nitro: on at the first good probe, off only after 3 bad ones in a row", () => {
  reset();
  assert.equal(probe(++h, h), true);
  assert.equal(probe(null, h), true); // one missed answer
  assert.equal(probe(++h, h), true); // and the count starts over
  assert.equal(probe(++h, h + 51), true);
  assert.equal(probe(++h, h + 51), true);
  assert.equal(probe(++h, h + 51), false); // 51 behind for 30 s
  assert.equal(probe(++h, h + 3), true);
});

test("nitro: a reference that fails keeps the last distance; a head that stops moving is caught without one", () => {
  reset();
  assert.equal(probe(++h, h), true);
  for (let i = 0; i < 5; i++) assert.equal(probe(++h, null), true); // the official RPC rate-limits us
  assert.equal(nitro.behind, 0);
  const stuck = ++h;
  for (let i = 0; i < 5; i++) assert.equal(probe(stuck, null), true); // its last move, then 10..40 s (bad from 30 s)
  assert.equal(probe(stuck, null), false); // the third bad probe in a row
});
