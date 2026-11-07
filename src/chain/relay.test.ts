import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fillOf, proxyFillOf, RELAY_ROUTER, RELAY_ROUTER_V32 } from "./relay.ts";
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

// Real proxy-path fills (solver -> 0xa834e703..., executor 0x0005ea38...), 2026-11-03 sample of 400 txs since go-live
const px = JSON.parse(readFileSync(new URL("./fixtures/relayproxy.json", import.meta.url), "utf8")) as Record<string, { hash: string; logs: { address: string; topics: string[]; data: string }[] }>;
const pf = (k: string) => proxyFillOf(px[k].hash, px[k].logs);

test("proxyFillOf: the executor delivers to the buyer, paid in wrapped ETH", () => {
  const f = pf("executor")!;
  assert.equal(f.recipient, "0xfdd0a3fc4fc504cce0ce67bbfc6244765482bf2b");
  assert.equal(f.token, "0xc57b8b353b684aebc13869abcfa240ee40ee2447");
  assert.equal(f.wethIn, 22305582573678848n);
});
test("proxyFillOf: the pool the executor paid delivers to the buyer directly", () => {
  const f = pf("poolDirect")!;
  assert.equal(f.recipient, "0x1314a2932ef8b02e371859eaf81615cda3d1f9e1");
  assert.equal(f.raw, 262410549878718002176n);
  assert.equal(f.wethIn, 27519641566877282n);
});
test("proxyFillOf: WETH minted and burned again to pay an ETH pool still counts as paid", () => {
  const f = pf("wrapBurn")!;
  assert.equal(f.recipient, "0x37d7991ae87f4f739dfb6a65bae30eca71a0fbeb");
  assert.equal(f.wethIn, 11060946795868913n);
});
test("proxyFillOf: a WETH-only delivery (bridged ETH) is no token buy", () => {
  assert.equal(pf("wethOnly"), null);
});
test("fillOf on the routers misses all four proxy fills (why proxyFillOf exists)", () => {
  for (const k of Object.keys(px)) for (const r of [RELAY_ROUTER_V32, RELAY_ROUTER]) assert.equal(fillOf(px[k].hash, px[k].logs, r), null);
});

test("fillOf on the v3.2 router: a sale into a v4 native-ETH pool is not a fill (the PoolManager is no buyer)", () => {
  const sellEth = (real as unknown as Record<string, { address: string; topics: string[]; data: string }[]>).sellEth;
  assert.equal(fillOf("0x4833", sellEth, RELAY_ROUTER_V32), null);
});
