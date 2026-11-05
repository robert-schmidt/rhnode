// Pool identity for pools that trade now but were created before go-live (§4.2). Never trusts the swap
// emitter's own word: v2/v3 answers are checked against the factory, v4 pools come from their Initialize log, Metric OMM
// pools from getImmutables, verified only when Metric's own factory says isPool.
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Abi } from "viem";
import { TupleParam } from "@clickhouse/client";
import { insert, inSpan, rows, span } from "../ch.ts";
import { FLAP_CURVE_BEACON, METRIC_OMM_FACTORY, MULTICALL3 } from "../chain/constants.ts";
import { registryEntries } from "../chain/registry.ts";
import type { Client } from "../chain/upstream.ts";

const MC = parseAbi(["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])"]);
const POOL = parseAbi([
  "function token0() view returns (address)", "function token1() view returns (address)", "function factory() view returns (address)",
  "function fee() view returns (uint24)", "function tickSpacing() view returns (int24)",
]);
const FACTORY = parseAbi([
  "function getPair(address, address) view returns (address)",
  "function getPool(address, address, uint24) view returns (address)",
]);
// Forks keyed by tick spacing (Slipstream-style CLFactory and others): getPool(token0, token1, int24 tickSpacing).
const FACTORY_TS = parseAbi(["function getPool(address, address, int24) view returns (address)"]);
const OMM = parseAbi(["struct I { address factory; address token0; address token1; uint256 s0; uint256 s1; uint256 i0; uint256 i1; uint256 minLiq; address provider; int256 lo; int256 hi; address e1; address e2; address e3; address e4; address e5; address e6; address e7; uint256 o1; uint256 o2; uint256 o3; uint256 o4; uint256 o5; uint256 o6; }",
  "function getImmutables() view returns (I)"]);
const OMM_FACTORY = parseAbi(["function isPool(address) view returns (bool)"]);
const INITIALIZE = registryEntries.find((e) => e.key === "univ4:Initialize")!.topic0;
const RETRY_FAILED_SEC = 3600;
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50"; // EIP-1967 beacon
const V4_PER_TICK = 50;

export type Call = { target: string; abi: Abi; fn: string; args?: unknown[] };
export async function multicall(up: Pick<Client, "call">, calls: Call[]): Promise<unknown[]> {
  if (!calls.length) return [];
  const data = encodeFunctionData({ abi: MC, functionName: "aggregate3", args: [calls.map((c) => ({
    target: c.target as `0x${string}`, allowFailure: true,
    callData: encodeFunctionData({ abi: c.abi, functionName: c.fn, args: c.args ?? [] } as Parameters<typeof encodeFunctionData>[0]),
  }))] });
  const res = decodeFunctionResult({ abi: MC, functionName: "aggregate3", data: await up.call<`0x${string}`>("eth_call", [{ to: MULTICALL3, data }, "latest"]) });
  return res.map((r, i) => {
    if (!r.success || r.returnData === "0x") return null;
    try { return decodeFunctionResult({ abi: calls[i].abi, functionName: calls[i].fn, data: r.returnData } as Parameters<typeof decodeFunctionResult>[0]); } catch { return null; }
  });
}

const lc = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : "");
type Row = Record<string, unknown>;
const failed = (pool: string, venue: string, manager: string): Row => ({
  pool, venue, manager, token0: "", token1: "", fee: 0, tick_spacing: 0, hooks: "", factory: "",
  created_block: 0, created_time: 0, source: "lookup", verified: 0, ok: 0, version: Date.now(),
});

/** v2/v3: read the pool, then ask its factory whether it is the pool for that pair (and fee). */
export async function resolveV23(up: Client, pools: { pool: string; venue: string }[]): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < pools.length; i += 100) {
    const part = pools.slice(i, i + 100);
    const r = await multicall(up, part.flatMap(({ pool }) => ["token0", "token1", "factory", "fee", "tickSpacing"].map((fn) => ({ target: pool, abi: POOL, fn }))));
    const got = part.map((p, j) => {
      const [t0, t1, factory, fee, ts] = r.slice(j * 5, j * 5 + 5);
      return { ...p, token0: lc(t0), token1: lc(t1), factory: lc(factory), fee: Number(fee ?? 0), tick_spacing: Number(ts ?? 0) };
    });
    const ok = got.filter((g) => g.token0 && g.token1 && g.factory);
    const checks = await multicall(up, ok.map((g) => g.venue === "v2"
      ? { target: g.factory, abi: FACTORY, fn: "getPair", args: [g.token0, g.token1] }
      : { target: g.factory, abi: FACTORY, fn: "getPool", args: [g.token0, g.token1, g.fee] }));
    const vouched = new Map(ok.map((g, j) => [g.pool, lc(checks[j]) === g.pool]));
    const byTs = ok.filter((g) => g.venue !== "v2" && !vouched.get(g.pool));
    const ts = await multicall(up, byTs.map((g) => ({ target: g.factory, abi: FACTORY_TS, fn: "getPool", args: [g.token0, g.token1, g.tick_spacing] })));
    byTs.forEach((g, j) => { if (lc(ts[j]) === g.pool) vouched.set(g.pool, true); });
    // A flap curve has no factory: vouched for by its beacon and its token's own launch (see flapCurves); unvouched it is still
    // a pool (it trades and gets prices), just unverified, like a fork's.
    for (const [pool, v] of await flapCurves(up, got.filter((g) => g.venue === "v2" && g.token0 && g.token1 && !g.factory))) {
      got.find((g) => g.pool === pool)!.factory = FLAP_CURVE_BEACON;
      vouched.set(pool, v);
    }
    for (const g of got) {
      if (!vouched.has(g.pool)) { out.push(failed(g.pool, g.venue, g.pool)); continue; }
      out.push({
        pool: g.pool, venue: g.venue, manager: g.pool, token0: g.token0, token1: g.token1, fee: g.fee, tick_spacing: g.tick_spacing,
        hooks: "", factory: g.factory, created_block: 0, created_time: 0, source: "lookup",
        // A fork factory that vouches for its own pool is a real pool; `factory` says whose.
        verified: vouched.get(g.pool) ? 1 : 0, ok: 1, version: Date.now(),
      });
    }
  }
  return out;
}

/** Flap curves among pools that answer token0/token1 but not factory(): those whose EIP-1967 beacon is FLAP_CURVE_BEACON, each
 *  true when it swaps in its token's flap launch tx (8,069 of 8,112 measured 2026-11-05; the other 43 had no buy at launch).
 *  The curve is made in that tx, so such a swap is among its first. Anyone can deploy a proxy on that beacon, so the beacon
 *  alone doesn't vouch: a decoy can't swap in the token's launch tx. Two reads on the tables' keys (launches by token, swaps
 *  by pool and block): a first-swap argMin per pool read ~43M rows a call (2026-11-05). */
export async function flapCurves(up: Pick<Client, "call">, cand: { pool: string; token0: string; token1: string }[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (!cand.length) return out;
  const slots = await Promise.all(cand.map((c) => up.call<string>("eth_getStorageAt", [c.pool, BEACON_SLOT, "latest"]).catch(() => "")));
  const flap = cand.filter((_, j) => ("0x" + (slots[j] ?? "").slice(-40)).toLowerCase() === FLAP_CURVE_BEACON);
  if (!flap.length) return out;
  const launches = await rows<{ token: string; tx_hash: string; block: string }>(
    `SELECT token, tx_hash, block FROM ev_launches WHERE token IN {t:Array(String)} AND source = 'flap' AND kind = 'launch'
     UNION ALL SELECT token, tx_hash, block FROM kept_launches WHERE token IN {t:Array(String)} AND source = 'flap' AND kind = 'launch'`,
    { t: flap.flatMap((c) => [c.token0, c.token1]) });
  const launchTx = new Map<string, { tx_hash: string; block: string }[]>();
  for (const l of launches) (launchTx.get(l.token) ?? launchTx.set(l.token, []).get(l.token)!).push(l);
  // (pool, launch block) pairs: one granule per part each (1,000 curves: 16.9M rows, not 26M for pool IN + block IN)
  const pb = flap.flatMap((c) => [c.token0, c.token1].flatMap((t) => (launchTx.get(t) ?? []).map((l) => new TupleParam([c.pool, Number(l.block)]))));
  const swaps = !pb.length ? [] : await rows<{ pool: string; tx_hash: string }>(
    `SELECT DISTINCT pool, tx_hash FROM (SELECT pool, tx_hash FROM ev_swaps WHERE (pool, block) IN {pb:Array(Tuple(String, UInt64))}
     UNION ALL SELECT pool, tx_hash FROM kept_swaps WHERE (pool, block) IN {pb:Array(Tuple(String, UInt64))})`, { pb });
  const ok = new Set(swaps.map((s) => `${s.pool}:${s.tx_hash}`));
  for (const c of flap) out.set(c.pool, [c.token0, c.token1].some((t) => (launchTx.get(t) ?? []).some((l) => ok.has(`${c.pool}:${l.tx_hash}`))));
  return out;
}

/** Metric OMM: the pool's immutables, verified when Metric's factory is the one it names and that factory vouches for it. */
async function resolveOmm(up: Client, pools: { pool: string }[]): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < pools.length; i += 100) {
    const part = pools.slice(i, i + 100);
    const [im, ok] = await Promise.all([multicall(up, part.map(({ pool }) => ({ target: pool, abi: OMM, fn: "getImmutables" }))),
      multicall(up, part.map(({ pool }) => ({ target: METRIC_OMM_FACTORY, abi: OMM_FACTORY, fn: "isPool", args: [pool] })))]);
    part.forEach(({ pool }, j) => {
      const m = im[j] as { factory: string; token0: string; token1: string } | null;
      if (!m) { out.push(failed(pool, "omm", pool)); return; }
      out.push({
        pool, venue: "omm", manager: pool, token0: lc(m.token0), token1: lc(m.token1), fee: 0, tick_spacing: 0, hooks: "", factory: lc(m.factory),
        created_block: 0, created_time: 0, source: "lookup", verified: lc(m.factory) === METRIC_OMM_FACTORY && ok[j] === true ? 1 : 0, ok: 1, version: Date.now(),
      });
    });
  }
  return out;
}

type InitLog = { topics: string[]; data: string; blockNumber: string; blockTimestamp?: string };

/** v4: the pool's Initialize log on its manager, one whole-range eth_getLogs. */
async function resolveV4(lookup: Client, p: { pool: string; manager: string }): Promise<Row> {
  try {
    const [l] = await lookup.call<InitLog[]>("eth_getLogs", [{ address: p.manager, topics: [INITIALIZE, p.pool], fromBlock: "0x0", toBlock: "latest" }]);
    if (!l) return failed(p.pool, "v4", p.manager);
    const w = (i: number) => l.data.slice(2 + 64 * i, 2 + 64 * (i + 1));
    const int24 = (h: string) => { const v = BigInt("0x" + h); return Number(v >= 1n << 255n ? v - (1n << 256n) : v); };
    return {
      pool: p.pool, venue: "v4", manager: p.manager, token0: "0x" + l.topics[2].slice(26), token1: "0x" + l.topics[3].slice(26),
      fee: Number(BigInt("0x" + w(0))), tick_spacing: int24(w(1)), hooks: "0x" + w(2).slice(24), factory: "",
      created_block: Number(l.blockNumber), created_time: Number(l.blockTimestamp ?? 0), source: "lookup", verified: 1, ok: 1, version: Date.now(),
    };
  } catch {
    return failed(p.pool, "v4", p.manager);
  }
}

/** Resolve the pools that swapped in (from, to] and aren't known and verified (re-asked hourly otherwise); only: just
 *  these pools (a backfill's, src/tools/venue-backfill.ts). */
export async function resolvePools(up: Client, lookup: Client, from: number, to: number, only?: string[]): Promise<{ v23: number; v4: number; failed: number }> {
  const unknown = (await rows<{ pool: string; vn: string; manager: string }>(
    // only the tick's pools are looked up in pools (keyed by pool): a set of every verified pool was 849 MiB a tick once
    // the history pass had filled pools (2.5M rows); this is 225 MiB (2026-11-05)
    `WITH seen AS (SELECT pool, any(venue) AS vn, any(emitter) AS manager FROM ev_swaps
       WHERE block > {from:UInt64} AND block <= {to:UInt64} AND ${inSpan()} AND venue != 'curve' -- a curve's row comes from its launch (migration 021)
         ${only ? "AND pool IN {only:Array(String)}" : ""} GROUP BY pool)
     SELECT pool, vn, manager FROM seen
     WHERE pool NOT IN (SELECT pool FROM pools FINAL PREWHERE pool IN (SELECT pool FROM seen) WHERE verified = 1 OR version > {retry:UInt64})`,
    { from, to, ...await span(from, to), retry: Date.now() - RETRY_FAILED_SEC * 1000, ...(only ? { only } : {}) },
  )).map(({ vn, ...u }) => ({ ...u, venue: vn }));
  const v23 = await resolveV23(up, unknown.filter((u) => u.venue === "v2" || u.venue === "v3"));
  const v4 = await Promise.all(unknown.filter((u) => u.venue === "v4").slice(0, V4_PER_TICK).map((u) => resolveV4(lookup, u)));
  const all = [...v23, ...v4, ...await resolveOmm(up, unknown.filter((u) => u.venue === "omm"))];
  await insert("pools", all, `lookup:${from}-${to}:${Date.now()}`);
  return { v23: v23.length, v4: v4.length, failed: all.filter((r) => !r.ok).length };
}
