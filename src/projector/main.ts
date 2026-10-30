// The projector (ARCHITECTURE §3.5): recompute only what changed. Every tick it takes the tokens with a
// transfer between its cursor and ingest's, reads their holder stats from agg_balances, and their
// totalSupply (+ name/symbol/decimals on first sight) in ONE Multicall3 eth_call per 200 tokens, at the
// block the stats are for. Writes serve_tokens. Dirty keys come from ev_transfers itself, so there is no
// separate dirty set to lose on a restart.
// ponytail: no Redis cards yet; the API (M3) reads serve_tokens and adds a cache if p95 needs it.
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { cfg } from "../config.ts";
import { ch, insert, inSpan, rows, span } from "../ch.ts";
import { MULTICALL3 } from "../chain/constants.ts";
import { upstream, type Client } from "../chain/upstream.ts";
import { deriveContracts } from "./contracts.ts";
import { resolvePools } from "./pools.ts";
import { derivePrices } from "./prices.ts";
import { deriveTrades } from "./trades.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const MAX_BLOCKS = 5_000; // per tick, so a catch-up after downtime proceeds in steps
const CHUNK = 200;

const MC = parseAbi(["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])"]);
const ERC20 = parseAbi([
  "function name() view returns (string)", "function symbol() view returns (string)",
  "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)",
]);
type Fn = "name" | "symbol" | "decimals" | "totalSupply";

/** Read ERC-20 views for many tokens in one eth_call at `block`. A failed or undecodable call is null. */
export async function readTokens(up: Client, block: number, asks: { token: string; fns: Fn[] }[]) {
  const calls = asks.flatMap(({ token, fns }) => fns.map((fn) => ({ token, fn })));
  const data = encodeFunctionData({
    abi: MC, functionName: "aggregate3",
    args: [calls.map((c) => ({ target: c.token as `0x${string}`, allowFailure: true, callData: encodeFunctionData({ abi: ERC20, functionName: c.fn }) }))],
  });
  const ret = await up.call<`0x${string}`>("eth_call", [{ to: MULTICALL3, data }, "0x" + block.toString(16)]);
  const results = decodeFunctionResult({ abi: MC, functionName: "aggregate3", data: ret });
  const out = new Map<string, Partial<Record<Fn, unknown>>>();
  calls.forEach((c, i) => {
    const r = results[i];
    let v: unknown = null;
    if (r.success && r.returnData !== "0x") {
      try { v = decodeFunctionResult({ abi: ERC20, functionName: c.fn, data: r.returnData }); } catch { /* bytes32 names, non-ERC-20 */ }
    }
    out.set(c.token, { ...out.get(c.token), [c.fn]: v });
  });
  return out;
}

type Stats = { token: string; holder_count: string; top10: string; minted: string };

export async function project(up: Client, from: number, to: number): Promise<number> {
  const dirty = (await rows<{ token: string }>(
    `SELECT DISTINCT token FROM ev_transfers WHERE block > {from:UInt64} AND block <= {to:UInt64} AND ${inSpan()} AND standard = 'erc20'`,
    { from, to, ...await span(from, to) },
  )).map((r) => r.token);
  await projectTokens(up, dirty, to, `${from}-${to}`);
  return dirty.length;
}

/** Rewrite serve_tokens for these tokens as of block `to` (also used by the promoter after a backfill). */
export async function projectTokens(up: Client, dirty: string[], to: number, tag: string): Promise<void> {
  for (let i = 0; i < dirty.length; i += CHUNK) {
    const chunk = dirty.slice(i, i + CHUNK);
    // ponytail: groups every holder of WETH/USDG each tick; a per-token holder count kept by an MV if this gets slow.
    const stats = await rows<Stats>(
      `SELECT token, countIf(b > 0 AND holder != {zero:String}) AS holder_count,
         toString(arraySum(arraySlice(arrayReverseSort(groupArrayIf(b, b > 0 AND holder != {zero:String})), 1, 10))) AS top10,
         toString(-sumIf(b, holder = {zero:String})) AS minted
       FROM (SELECT token, holder, sum(balance) AS b FROM agg_balances WHERE token IN {t:Array(String)} GROUP BY token, holder)
       GROUP BY token`,
      { t: chunk, zero: ZERO },
    );
    // A token whose every balance went back to 0 has no agg_balances rows left (SummingMergeTree drops zero sums), so it
    // isn't in `stats`: it still gets its row, or its card would keep the last non-zero state (wRDDT, 2026-10-30).
    const have = new Set(stats.map((s) => s.token));
    for (const token of chunk) if (!have.has(token)) stats.push({ token, holder_count: "0", top10: "0", minted: "0" });
    const known = new Map((await rows<{ token: string; name: string; symbol: string; decimals: number }>(
      "SELECT token, name, symbol, decimals FROM serve_tokens FINAL WHERE token IN {t:Array(String)}", { t: chunk },
    )).map((r) => [r.token, r]));
    const reads = await readTokens(up, to, chunk.map((token) => ({ token, fns: known.has(token) ? ["totalSupply"] : ["name", "symbol", "decimals", "totalSupply"] })));
    const version = Date.now();
    await insert("serve_tokens", stats.map((s) => {
      const r = reads.get(s.token) ?? {};
      const k = known.get(s.token);
      const supply = typeof r.totalSupply === "bigint" ? r.totalSupply : null;
      return {
        token: s.token,
        name: k?.name ?? (typeof r.name === "string" ? r.name : ""),
        symbol: k?.symbol ?? (typeof r.symbol === "string" ? r.symbol : ""),
        decimals: k?.decimals ?? (typeof r.decimals === "number" ? r.decimals : -1),
        total_supply: (supply ?? 0n).toString(),
        holder_count: s.holder_count, top10: s.top10, minted: s.minted,
        complete: supply !== null && supply > 0n && BigInt(s.minted) === supply ? 1 : 0,
        block: to, version,
      };
    }), `${tag}:${i}`);
  }
}

/** Hourly: a complete token whose totalSupply() moved without a Transfer we saw (rebasing, a non-standard mint) is
 *  re-projected, which clears `complete` when minted no longer matches. One multicall per 500 tokens. */
export async function driftSweep(up: Client, tip: number): Promise<number> {
  const done = await rows<{ token: string; supply: string }>("SELECT token, toString(total_supply) AS supply FROM serve_tokens FINAL WHERE complete = 1");
  const drifted: string[] = [];
  for (let i = 0; i < done.length; i += 500) {
    const chunk = done.slice(i, i + 500);
    const reads = await readTokens(up, tip, chunk.map(({ token }) => ({ token, fns: ["totalSupply"] as Fn[] })));
    for (const { token, supply } of chunk) {
      const s = reads.get(token)?.totalSupply;
      if (typeof s !== "bigint" || s.toString() !== supply) drifted.push(token);
    }
  }
  if (drifted.length) await projectTokens(up, drifted, tip, `drift:${tip}`);
  return drifted.length;
}

const cursor = async (name: string) => Number((await rows<{ block: string }>("SELECT block FROM ctl_cursors FINAL WHERE name = {name:String}", { name }))[0]?.block ?? 0);

if (import.meta.main) {
  const up = upstream(cfg.upstreamHttp);
  const lookup = upstream(cfg.lookupHttp, { attempts: 2 });
  let last = await cursor("projector");
  let sweptAt = 0;
  for (;;) {
    if (Date.now() - sweptAt > 3_600_000 && last) {
      sweptAt = Date.now();
      const n = await driftSweep(up, last).catch((e: Error) => { console.warn(`[drift] ${e.message}`); return -1; });
      console.log(JSON.stringify({ at: new Date().toISOString(), drift: n }));
    }
    const tip = await cursor("tip");
    if (!last) last = tip; // cold start: from now on
    if (tip <= last) { await new Promise((r) => setTimeout(r, 2000)); continue; }
    const to = Math.min(tip, last + MAX_BLOCKS);
    const t0 = Date.now();
    const pools = await resolvePools(up, lookup, last, to);
    const n = await project(up, last, to);
    const prices = await derivePrices(last, to);
    const trades = await deriveTrades(last, to);
    const contracts = await deriveContracts(up, last, to);
    await ch.insert({ table: "ctl_cursors", values: [{ name: "projector", block: to, hash: "", version: Date.now() }], format: "JSONEachRow" });
    console.log(JSON.stringify({ at: new Date().toISOString(), from: last + 1, to, tokens: n, pools, prices, trades, contracts, ms: Date.now() - t0 }));
    last = to;
  }
}
