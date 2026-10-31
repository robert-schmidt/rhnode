import { test } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL } from "./protocol.ts";
import { INFRA_WALLETS, RELAY_CONTRACTS } from "./constants.ts";

test("PROTOCOL: every infra wallet and Relay contract is listed once, lower-case, with a kind", () => {
  for (const a of [...INFRA_WALLETS, ...RELAY_CONTRACTS]) assert.ok(PROTOCOL.has(a), a);
  assert.equal(PROTOCOL.get("0x0000000000000000000000000000000000000000")?.kind, "burn");
  for (const [a, e] of PROTOCOL) assert.ok(/^0x[0-9a-f]{40}$/.test(a) && e.address === a && e.kind && e.label, a);
});
