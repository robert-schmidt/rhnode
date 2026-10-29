import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fillOf, RELAY_ROUTER, RELAY_ROUTER_V32 } from "./relay.ts";
import { USDG } from "./constants.ts";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a: string) => "0x" + a.slice(2).padStart(64, "0");
const amt = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
const SOLVER = "0x00000000000000000000000000000000000000aa";
const POOL = "0x00000000000000000000000000000000000000bb";
const BUYER = "0x00000000000000000000000000000000000000cc";
const TOKEN = "0x00000000000000000000000000000000000000dd";

test("fillOf: USDG into the router, the token out of it to the buyer", () => {
  const f = fillOf("0xABC", [
    { address: USDG, topics: [TRANSFER, pad(SOLVER), pad(RELAY_ROUTER)], data: amt(5_000_000n) },
    { address: USDG, topics: [TRANSFER, pad(RELAY_ROUTER), pad(POOL)], data: amt(5_000_000n) },
    { address: TOKEN, topics: [TRANSFER, pad(POOL), pad(RELAY_ROUTER)], data: amt(777n) },
    { address: TOKEN, topics: [TRANSFER, pad(RELAY_ROUTER), pad(BUYER)], data: amt(777n) },
  ]);
  assert.deepEqual(f, { hash: "0xabc", recipient: BUYER, token: TOKEN, raw: 777n, usdgIn: 5_000_000n, wethIn: 0n, block: null });
});

test("fillOf: no token leaving the router is no fill", () => {
  assert.equal(fillOf("0x1", [{ address: TOKEN, topics: [TRANSFER, pad(POOL), pad(BUYER)], data: amt(1n) }]), null);
});

// Real v3.2 router txs from our ingest (2026-10-29): a Relay buy fill and a smart-wallet sell.
const real = JSON.parse(readFileSync(new URL("./fixtures/relay32.json", import.meta.url), "utf8")) as Record<"buy" | "sell", { address: string; topics: string[]; data: string }[]>;

test("fillOf on the v3.2 router: the real buy is a fill to the buyer, paid in USDG", () => {
  const f = fillOf("0x7ed8", real.buy, RELAY_ROUTER_V32)!;
  assert.equal(f.recipient, "0x270b9cdf712509a54347db388b46a2c1b816897f");
  assert.equal(f.token, "0xc60ba256b44334a0cd2c7242e98b88f031abb006");
  assert.equal(f.raw, 158295690055597763522389n);
  assert.equal(f.usdgIn, 167644142n);
});

test("fillOf on the v3.2 router: the real sell into the v4 PoolManager is not a fill", () => {
  assert.equal(fillOf("0xfecd", real.sell, RELAY_ROUTER_V32), null);
});
