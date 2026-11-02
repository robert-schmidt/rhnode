import { test } from "node:test";
import assert from "node:assert/strict";
import { atOrBefore } from "./hist-trades.ts";

test("atOrBefore: the minute's own close, else the last one before it, else the first", () => {
  const v = new Map([[60, 2000], [180, 2100]]), keys = [60, 180];
  assert.equal(atOrBefore(keys, v, 60), 2000);
  assert.equal(atOrBefore(keys, v, 120), 2000); // no close that minute: carried forward
  assert.equal(atOrBefore(keys, v, 180), 2100);
  assert.equal(atOrBefore(keys, v, 0), 2000); // before any: the first
  assert.equal(atOrBefore([], new Map(), 60), null);
});
