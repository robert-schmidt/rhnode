import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "./labels.ts";

const T = (tagType: string, name: string, ordinal = 0) => ({ slug: name.toLowerCase().replace(/\W+/g, "-"), name, tagType, ordinal });

test("classify: exchange before bridge before flagged; the highest-ordinal name tag names it", () => {
  assert.deepEqual(classify([T("name", "Gate Deposit"), T("name", "Gate.io: Hot Wallet", 10), T("generic", "HOT WALLET")]), { kind: "cex", name: "Gate.io: Hot Wallet" });
  assert.deepEqual(classify([T("name", "Relay: Solver 0xada...7cb"), T("protocol", "Relay")]), { kind: "bridge", name: "Relay: Solver 0xada...7cb" });
  assert.equal(classify([T("name", "NEAR Intents: Treasury"), T("generic", "Phish / Hack")])!.kind, "bridge"); // a decoy phish tag loses
  assert.equal(classify([T("generic", "Phish / Hack"), T("name", "Fake_Phishing1")])!.kind, "flagged");
  assert.deepEqual(classify([T("name", "PoolManager")]), { kind: "entity", name: "PoolManager" });
  assert.equal(classify([]), null);
});
