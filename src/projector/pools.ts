// Pool identity for pools that trade now but were created before go-live (§4.2). Never trusts the swap
// emitter's own word: v2/v3 answers are checked against the factory, v4 pools come from their Initialize log.
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Abi } from "viem";
import { insert, inSpan, rows, span } from "../ch.ts";
import { MULTICALL3 } from "../chain/constants.ts";
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
const INITIALIZE = registryEntries.find((e) => e.key === "univ4:Initialize")!.topic0;
const RETRY_FAILED_SEC = 3600;
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
async function resolveV23(up: Client, pools: { pool: string; venue: string }[]): Promise<Row[]> {
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

/** Resolve the pools that swapped in (from, to] and aren't known and verified (re-asked hourly otherwise). */
export async function resolvePools(up: Client, lookup: Client, from: number, to: number): Promise<{ v23: number; v4: number; failed: number }> {
  const unknown = await rows<{ pool: string; venue: string; manager: string }>(
    `SELECT pool, any(venue) AS venue, any(emitter) AS manager FROM ev_swaps
     WHERE block > {from:UInt64} AND block <= {to:UInt64} AND ${inSpan()}
       AND pool NOT IN (SELECT pool FROM pools FINAL WHERE verified = 1 OR version > {retry:UInt64})
     GROUP BY pool`,
    { from, to, ...await span(from, to), retry: Date.now() - RETRY_FAILED_SEC * 1000 },
  );
  const v23 = await resolveV23(up, unknown.filter((u) => u.venue !== "v4"));
  const v4 = await Promise.all(unknown.filter((u) => u.venue === "v4").slice(0, V4_PER_TICK).map((u) => resolveV4(lookup, u)));
  const all = [...v23, ...v4];
  await insert("pools", all, `lookup:${from}-${to}:${Date.now()}`);
  return { v23: v23.length, v4: v4.length, failed: all.filter((r) => !r.ok).length };
}
