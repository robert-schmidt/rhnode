// JSON-RPC (ARCHITECTURE §6): Ethereum methods proxied to the upstreams (our node in `full`), with immutable
// results cached, eth_getLogs answered from ClickHouse when the range is inside what we hold (no range or
// topic caps), and the Alchemy extras apps commonly call. Same handler for /rpc and /ws.
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { cfg } from "../config.ts";
import { rows } from "../ch.ts";
import { MULTICALL3 } from "../chain/constants.ts";
import { upstream, type RpcReply } from "../chain/upstream.ts";
import { coverage } from "./coverage.ts";

export const up = upstream(cfg.upstreamHttp, { attempts: 6 });
const send = upstream(cfg.api.sendHttp, { attempts: 1, timeoutMs: 15_000 });
const CHAIN_ID = "0x" + (4663).toString(16);
const MAX_LOGS = 100_000;

/** Byte-bounded LRU for results that never change. */
const cache = new Map<string, string>();
let cacheBytes = 0;
function remember(key: string, value: unknown) {
  const s = JSON.stringify(value);
  if (s.length > 4_000_000) return;
  cache.delete(key);
  cache.set(key, s);
  cacheBytes += key.length + s.length;
  while (cacheBytes > cfg.api.cacheMb * 1_048_576) {
    const [k, v] = cache.entries().next().value!;
    cache.delete(k);
    cacheBytes -= k.length + v.length;
  }
}
function recall(key: string): RpcReply | null {
  const s = cache.get(key);
  if (s === undefined) return null;
  cache.delete(key); // LRU: move to the back
  cache.set(key, s);
  return { result: JSON.parse(s) };
}

const BY_HASH = new Set(["eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getBlockByHash", "eth_getTransactionByBlockHashAndIndex"]);
const BY_NUMBER = new Set(["eth_getBlockByNumber", "eth_getBlockReceipts", "eth_getTransactionByBlockNumberAndIndex"]);
const isHex = (x: unknown): x is string => typeof x === "string" && /^0x[0-9a-f]+$/i.test(x);
const hex = (n: number | bigint) => "0x" + n.toString(16);
const err = (code: number, message: string): RpcReply => ({ error: { code, message } });

let headAt = 0, headReply: RpcReply | null = null;

export async function handle(method: string, params: unknown[] = []): Promise<RpcReply> {
  switch (method) {
    case "eth_chainId": return { result: CHAIN_ID };
    case "net_version": return { result: "4663" };
    case "eth_blockNumber": // every client polls it: one upstream call per 250 ms at most
      if (!headReply || Date.now() - headAt > 250) { headReply = await up.forward(method, []); headAt = Date.now(); }
      return headReply;
    case "eth_sendRawTransaction": return send.forward(method, params);
    case "eth_getLogs": return getLogs(params[0] as LogFilter);
    case "alchemy_getTokenBalances": return tokenBalances(params);
    case "eth_subscribe": case "eth_unsubscribe": return err(-32601, `${method} needs a WebSocket (/ws)`);
  }
  const key = method + JSON.stringify(params);
  const hit = recall(key);
  if (hit) return hit;
  const r = await up.forward(method, params);
  if (r.result != null && !r.error && (await cacheable(method, params, r.result))) remember(key, r.result);
  return r;
}

async function cacheable(method: string, params: unknown[], result: unknown): Promise<boolean> {
  if (BY_HASH.has(method)) return (result as { blockNumber?: string | null }).blockNumber != null || method === "eth_getBlockByHash";
  // By number: only well below the tip, where a reorg can't reach.
  if (BY_NUMBER.has(method)) return isHex(params[0]) && Number(params[0]) < (await coverage()).ingested - 64;
  if (method === "eth_getCode") return result !== "0x" && params[1] === "latest"; // deployed code doesn't change
  return false;
}

type LogFilter = { fromBlock?: string; toBlock?: string; address?: string | string[]; topics?: (string | string[] | null)[]; blockHash?: string };

/** From ClickHouse when [from, to] lies inside raw coverage; otherwise (or for blockHash/tags) the upstreams. */
// A range that ends just past `ingested` (clients ask up to the head; we run ~1 s behind) waits for ingest instead
// of going upstream, where ranges and 1,000+ OR'd topics are refused.
const WAIT_BLOCKS = 300, WAIT_MS = 3_000;
export const logStats = { waited: 0, caughtUp: 0, upstream: 0 };

async function getLogs(f: LogFilter): Promise<RpcReply> {
  if (!f || typeof f !== "object") return err(-32602, "missing filter");
  let cov = await coverage();
  const want = isHex(f.toBlock) ? Number(f.toBlock) : 0;
  if (want > cov.ingested && want - cov.ingested <= WAIT_BLOCKS) {
    logStats.waited++;
    for (const until = Date.now() + WAIT_MS; want > cov.ingested && Date.now() < until; ) {
      await new Promise((r) => setTimeout(r, 200));
      cov = await coverage(150);
    }
    if (want <= cov.ingested) logStats.caughtUp++;
  }
  const from = isHex(f.fromBlock) ? Number(f.fromBlock) : f.fromBlock === undefined || f.fromBlock === "latest" ? cov.ingested : NaN;
  const to = isHex(f.toBlock) ? Number(f.toBlock) : f.toBlock === undefined || f.toBlock === "latest" ? cov.ingested : NaN;
  if (f.blockHash || !(from >= cov.rawFrom && to <= cov.ingested && from <= to)) { logStats.upstream++; return up.forward("eth_getLogs", [f]); }
  const p: Record<string, unknown> = { from, to };
  const where = ["l.block BETWEEN {from:UInt64} AND {to:UInt64}", "l.sign = 1"];
  const addrs = (Array.isArray(f.address) ? f.address : f.address ? [f.address] : []).map((a) => a.toLowerCase());
  if (addrs.length) { where.push("l.address IN {addrs:Array(String)}"); p.addrs = addrs; }
  (f.topics ?? []).slice(0, 4).forEach((t, i) => {
    const set = (Array.isArray(t) ? t : t ? [t] : []).map((x) => x.toLowerCase());
    if (set.length) { where.push(`l.topic${i} IN {t${i}:Array(String)}`); p[`t${i}`] = set; }
  });
  const logs = await rows<{ block: string; tx_index: number; log_index: number; tx_hash: string; address: string; topic0: string; topic1: string; topic2: string; topic3: string; data: string; block_hash: string; ts: number }>(
    `SELECT l.block, l.tx_index, l.log_index, l.tx_hash, l.address, l.topic0, l.topic1, l.topic2, l.topic3, l.data, b.hash AS block_hash, toUnixTimestamp(l.time) AS ts
     FROM raw_logs AS l INNER JOIN (SELECT number, hash FROM raw_blocks WHERE number BETWEEN {from:UInt64} AND {to:UInt64} AND sign = 1) AS b ON b.number = l.block
     WHERE ${where.join(" AND ")} ORDER BY l.block, l.log_index LIMIT ${MAX_LOGS + 1}`, p);
  if (logs.length > MAX_LOGS) return err(-32005, `query returned more than ${MAX_LOGS} results; narrow the range`);
  return {
    result: logs.map((l) => ({
      address: l.address, topics: [l.topic0, l.topic1, l.topic2, l.topic3].filter(Boolean), data: l.data,
      blockNumber: hex(Number(l.block)), blockHash: l.block_hash, blockTimestamp: hex(l.ts), transactionHash: l.tx_hash,
      transactionIndex: hex(l.tx_index), logIndex: hex(l.log_index), removed: false,
    })),
  };
}

const MC = parseAbi(["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])"]);
const BAL = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** alchemy_getTokenBalances(address, "erc20" | "DEFAULT_TOKENS" | address[]): balanceOf on chain (exact), for the
 *  given tokens or every ERC-20 the wallet touched since we started indexing. */
async function tokenBalances([owner, spec]: unknown[]): Promise<RpcReply> {
  if (typeof owner !== "string" || !/^0x[0-9a-f]{40}$/i.test(owner)) return err(-32602, "invalid address");
  const wallet = owner.toLowerCase();
  const tokens = Array.isArray(spec) ? spec.map((t) => String(t).toLowerCase()) : (await rows<{ token: string }>(
    "SELECT DISTINCT token FROM agg_balances WHERE holder = {w:String} LIMIT 2000", { w: wallet })).map((r) => r.token);
  const balances: { contractAddress: string; tokenBalance: string | null; error: string | null }[] = [];
  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const data = encodeFunctionData({ abi: MC, functionName: "aggregate3", args: [chunk.map((t) => ({
      target: t as `0x${string}`, allowFailure: true, callData: encodeFunctionData({ abi: BAL, functionName: "balanceOf", args: [wallet as `0x${string}`] }) }))] });
    const r = await up.forward("eth_call", [{ to: MULTICALL3, data }, "latest"]);
    if (r.error) return r;
    const out = decodeFunctionResult({ abi: MC, functionName: "aggregate3", data: r.result as `0x${string}` });
    chunk.forEach((t, j) => {
      const ok = out[j].success && out[j].returnData.length === 66;
      balances.push({ contractAddress: t, tokenBalance: ok ? "0x" + out[j].returnData.slice(2).padStart(64, "0") : null, error: ok ? null : "balanceOf failed" });
    });
  }
  return { result: { address: wallet, tokenBalances: Array.isArray(spec) ? balances : balances.filter((b) => b.tokenBalance && BigInt(b.tokenBalance) > 0n) } };
}
