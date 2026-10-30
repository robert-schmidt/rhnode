import assert from "node:assert";
import { test } from "node:test";
import { classify, selectors, stripMetadata } from "./contracts.ts";

const META = "a1000000" + "0004"; // a 4-byte CBOR map + its length, as solc appends
const ERC20 = "0x" + ["a9059cbb", "70a08231", "18160ddd", "23b872dd"].map((s) => `63${s}14`).join("")
  + "7f" + "63deadbeef14".padEnd(64, "0") // a PUSH32 whose data looks like a selector: skipped
  + META;

test("metadata is stripped and only dispatcher selectors count", () => {
  assert.equal(stripMetadata(ERC20).endsWith("0004"), false);
  assert.deepEqual(selectors(ERC20), ["18160ddd", "23b872dd", "70a08231", "a9059cbb"]);
});

test("kinds and fingerprints", () => {
  const a = classify(ERC20), b = classify(ERC20.replace(META, "a1111111" + "0004"));
  assert.equal(a.kind, "erc20");
  assert.equal(a.fingerprint, b.fingerprint); // another build of the same interface is the same kind
  const impl = "11".repeat(20);
  assert.deepEqual(classify(`0x363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3`).fingerprint, `1167:0x${impl}`);
  assert.equal(classify("0x6000", "0xabc").kind, "eip1967");
  assert.equal(classify("0x6000").kind, "contract");
});
