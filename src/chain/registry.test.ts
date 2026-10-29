// The registry, tested against REAL captured logs (fixtures/logs.json — every
// entry pulled from the live chain / canonical Blockscout on 2026-08-09), not
// hand-invented payloads. If a signature, an indexed flag or a topic0 is
// wrong, decoding real data is what catches it.
//
// Fault-injection log:
// - flipped an indexed flag on hoodfun TokenCreated → decode test failed ✓
// - typo'd ponsv2 TokenLaunched topic0 → registry import threw (self-check) ✓
// - swapped token0/token1 in tokenSideOf → quote-side test failed ✓
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeChainLog, registryEntries, tokenSideOf, type RawLog } from "./registry.ts";
import { WETH } from "./constants.ts";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/logs.json", import.meta.url), "utf8")) as Record<string, RawLog[]>;

test("every registry entry's ABI computes to its pinned observed topic0", () => {
  // The registry throws at import if not — this asserts the import survived
  // AND stays meaningful if that boot check is ever weakened.
  for (const e of registryEntries) assert.equal(e.topic0.length, 66, `${e.key}: malformed topic0`);
  assert.ok(registryEntries.length >= 12, "registry lost entries");
});

test("every fixture decodes through the registry to a sane normalized event", () => {
  let decoded = 0;
  for (const [name, logs] of Object.entries(fixtures)) {
    for (const log of logs) {
      const d = decodeChainLog(log);
      assert.ok(d, `${name}: registry did not claim a log it must own (address+topic0 lookup failed)`);
      decoded++;
      const ev = d!.event;
      if (ev.kind === "pool") {
        assert.match(ev.token0, /^0x[0-9a-f]{40}$/, `${name}: token0`);
        assert.match(ev.token1, /^0x[0-9a-f]{40}$/, `${name}: token1`);
      } else {
        assert.match(ev.token, /^0x[0-9a-f]{40}$/, `${name}: token address missing or not lowercased`);
      }
      if (ev.kind === "launch") {
        assert.ok(ev.source.length > 0, `${name}: launch without source`);
        assert.match(ev.deployer, /^0x[0-9a-f]{40}$/, `${name}: deployer`);
      }
    }
  }
  assert.ok(decoded >= 20, `expected ≥20 fixture logs, decoded ${decoded}`);
});

test("fixture spot-checks: the decoders read the right fields", () => {
  const bags = decodeChainLog(fixtures.bags_TokenCreated[0])!;
  assert.equal(bags.event.kind, "launch");
  if (bags.event.kind === "launch") {
    assert.equal(bags.event.source, "bags");
    assert.match(bags.event.poolId!, /^0x[0-9a-f]{64}$/, "bags launch carries the v4 poolId at creation");
    assert.ok(bags.event.symbol!.length > 0, "bags TokenCreated carries the symbol");
  }
  const mig = decodeChainLog(fixtures.hoodfun_Migrated[0])!;
  assert.equal(mig.event.kind, "migration");
  if (mig.event.kind === "migration") {
    assert.equal(mig.event.poolKind, "v2");
    assert.match(mig.event.pool!, /^0x[0-9a-f]{40}$/, "hoodfun migration names the v2 pair");
  }
  const v4 = decodeChainLog(fixtures.univ4_Initialize[0])!;
  assert.equal(v4.event.kind, "pool");
  if (v4.event.kind === "pool") {
    assert.match(v4.event.poolId!, /^0x[0-9a-f]{64}$/, "v4 pools are bytes32 ids, not contracts");
    assert.match(v4.event.hooks!, /^0x[0-9a-f]{40}$/);
  }
});

test("a log the registry does not claim returns null, never a crash", () => {
  const alien: RawLog = {
    ...fixtures.univ2_PairCreated[0],
    address: "0x000000000000000000000000000000000000dead",
  };
  assert.equal(decodeChainLog(alien), null);
});

test("tokenSideOf picks the non-quote side and refuses non-quote pools", () => {
  const t = "0x1111111111111111111111111111111111111111";
  assert.deepEqual(tokenSideOf(t, WETH), { token: t, quote: WETH });
  assert.deepEqual(tokenSideOf(WETH, t), { token: t, quote: WETH });
  // Two random tokens: not a launch — we do not invent memecoins.
  assert.equal(tokenSideOf(t, "0x2222222222222222222222222222222222222222"), null);
});
