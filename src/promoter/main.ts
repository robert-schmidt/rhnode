// Token promotion: a token older than go-live gets its whole history once, so holders, tokentx and the token card
// answer exactly from then on. The API queues a token the first time it has to refuse one (ctl_promotions).
// Per token: one whole-range eth_getLogs (address + Transfer) for [0, go-live), bisected only when a provider refuses
// the range; block times from the logs' blockTimestamp, block reads only for the ones a provider leaves out. Rows go
// straight to kept_transfers (forever, monthly parts) and agg_balances (summed per holder here: one small insert), not
// through ev_transfers, whose daily partitions would turn months of history into hundreds of tiny parts. What rhnode
// already holds since go-live is copied into kept_transfers, never refetched; its balances are already counted. The
// token is watched (live ingest keeps it) and re-projected: complete = 1 only if minted = totalSupply() on chain.
import { cfg, parseUpstreams } from "../config.ts";
import { ch, insert, rows } from "../ch.ts";
import { upstream } from "../chain/upstream.ts";
import { KEEP } from "../ingest/keep.ts";
import { TRANSFER, topicAddr, word0 } from "../ingest/decode.ts";
import { projectTokens } from "../projector/main.ts";
import { walk, walkFloor } from "./walk.ts";

/** Above this many transfers a token stays refused (WETH, USDG, stables): too big to hold for the gain. */
const MAX_TRANSFERS = Number(process.env.PROMOTE_MAX_TRANSFERS ?? 500_000);
const INSERT_ROWS = 50_000;
const MIN_SPLIT = 2_000; // blocks: below this a refused range is a real failure, not a size limit
type Log = { blockNumber: string; transactionIndex: string; logIndex: string; transactionHash: string; topics: string[]; data: string; blockTimestamp?: string };

// Address-filtered whole-range getLogs: Tenderly's keyless gateway allows it (20K logs a reply, real blockTimestamp),
// the official RPC caps at 10K. Our node, once it's synced: PROMOTE_HTTP=http://nitro:8547|50.
const src = upstream(parseUpstreams(process.env.PROMOTE_HTTP ?? "https://robinhood-chain.gateway.tenderly.co|5,https://rpc.mainnet.chain.robinhood.com|5"), { attempts: 4, timeoutMs: 60_000, ordered: true });
const up = upstream(cfg.upstreamHttp);
const hex = (n: number) => "0x" + n.toString(16);
const CONCURRENCY = Number(process.env.PROMOTE_CONCURRENCY ?? 4);
type Calls = { n: number };

async function logs(token: string, from: number, to: number, out: Log[], calls: Calls): Promise<void> {
  let r: { result?: unknown; error?: { message: string } };
  calls.n++;
  try { r = await src.forward("eth_getLogs", [{ address: token, topics: [TRANSFER], fromBlock: hex(from), toBlock: hex(to) }]); }
  catch (e) { r = { error: { message: (e as Error).message } }; }
  if (Array.isArray(r.result)) { for (const l of r.result as Log[]) out.push(l); }
  else {
    if (to - from < MIN_SPLIT) throw new Error(`getLogs ${from}-${to}: ${r.error?.message ?? "no result"}`);
    const mid = Math.floor((from + to) / 2);
    await logs(token, from, mid, out, calls);
    if (out.length > MAX_TRANSFERS) return;
    await logs(token, mid + 1, to, out, calls);
  }
  if (out.length > MAX_TRANSFERS) throw new TooBig();
}
class TooBig extends Error {}

/** Unix time per block, for logs a provider returned without blockTimestamp (or 0x0, as the official RPC does). */
async function times(ls: Log[], calls: Calls): Promise<Map<number, number>> {
  const t = new Map<number, number>();
  for (const l of ls) if (l.blockTimestamp && Number(l.blockTimestamp)) t.set(Number(l.blockNumber), Number(l.blockTimestamp));
  const missing = [...new Set(ls.map((l) => Number(l.blockNumber)).filter((b) => !t.has(b)))];
  for (let i = 0; i < missing.length; i += 20) {
    await Promise.all(missing.slice(i, i + 20).map(async (b) => {
      calls.n++;
      t.set(b, Number((await up.call<{ timestamp: string }>("eth_getBlockByNumber", [hex(b), false])).timestamp));
    }));
  }
  return t;
}

const setStatus = (token: string, status: string, transfers: number, note: string) =>
  ch.insert({ table: "ctl_promotions", values: [{ token, status, transfers, note, version: Date.now() }], format: "JSONEachRow" });

async function golive(): Promise<number> {
  const [c] = await rows<{ block: string }>("SELECT block FROM ctl_cursors FINAL WHERE name = 'golive'");
  if (c && Number(c.block)) return Number(c.block);
  const [m] = await rows<{ b: string }>("SELECT min(number) AS b FROM raw_blocks");
  if (!Number(m?.b)) throw new Error("no blocks ingested yet");
  await ch.insert({ table: "ctl_cursors", values: [{ name: "golive", block: Number(m.b), hash: "", version: 1 }], format: "JSONEachRow" });
  return Number(m.b);
}

export async function promote(token: string, B0: number): Promise<{ status: string; transfers: number; note: string }> {
  const calls: Calls = { n: 0 };
  const t0 = Date.now();
  // Watch first: live ingest keeps the token's new transfers from its next context reload (15 s) on.
  await ch.insert({ table: "ctl_watchlists", values: [{ list: "promoted", kind: "token", value: token, keep_bits: KEEP.WATCH_TOKEN, version: Date.now() }], format: "JSONEachRow" });
  const ls: Log[] = [];
  try { await logs(token, 0, B0 - 1, ls, calls); }
  catch (e) {
    if (e instanceof TooBig) {
      await ch.insert({ table: "ctl_watchlists", values: [{ list: "promoted", kind: "token", value: token, keep_bits: KEEP.WATCH_TOKEN, removed: 1, version: Date.now() }], format: "JSONEachRow" });
      return { status: "skipped", transfers: ls.length, note: `over ${MAX_TRANSFERS} transfers before go-live` };
    }
    throw e;
  }
  const erc20 = ls.filter((l) => l.topics.length === 3);
  const [seen] = await rows<{ n: string }>("SELECT count() AS n FROM ev_transfers WHERE token = {t:String} AND standard = 'erc20'", { t: token });
  if (!erc20.length && !Number(seen?.n)) {
    await ch.insert({ table: "ctl_watchlists", values: [{ list: "promoted", kind: "token", value: token, keep_bits: KEEP.WATCH_TOKEN, removed: 1, version: Date.now() }], format: "JSONEachRow" });
    return { status: "notoken", transfers: 0, note: `${ls.length} Transfer logs, none ERC-20` };
  }
  const tm = await times(erc20, calls);
  const rowsOut = erc20.map((l) => ({
    block: Number(l.blockNumber), tx_index: Number(l.transactionIndex), log_index: Number(l.logIndex), batch_index: 0,
    tx_hash: l.transactionHash.toLowerCase(), time: tm.get(Number(l.blockNumber)) ?? 0, token,
    from: topicAddr(l.topics[1].toLowerCase()), to: topicAddr(l.topics[2].toLowerCase()), amount: word0(l.data.toLowerCase()),
    token_id: "0", standard: "erc20", keep: KEEP.WATCH_TOKEN, sign: 1,
  }));
  // kept_transfers is a ReplacingMergeTree: a retry rewrites the same keys. agg_balances sums, so it goes last, once,
  // with a deterministic dedup token (a retry within ClickHouse's dedup window is dropped), and is marked right after.
  for (let i = 0; i < rowsOut.length; i += INSERT_ROWS) await insert("kept_transfers", rowsOut.slice(i, i + INSERT_ROWS), `promote:${token}:${B0}:${i}`);
  // Let ingest's context (reloaded every 15 s) pick up the watch before copying the window; the fetch counts toward it.
  await new Promise((r) => setTimeout(r, Math.max(0, 20_000 - (Date.now() - t0))));
  await ch.command({ query: `INSERT INTO kept_transfers SELECT * REPLACE (bitOr(keep, ${KEEP.WATCH_TOKEN}) AS keep) FROM ev_transfers WHERE token = {t:String} AND block >= {b:UInt64}`, query_params: { t: token, b: B0 } });
  const bal = new Map<string, bigint>();
  for (const r of rowsOut) {
    let a = BigInt(r.amount);
    if (a >= 1n << 255n) a -= 1n << 256n; // toInt256 wraps the same way in mv_agg_balances (spam amounts only)
    bal.set(r.from, (bal.get(r.from) ?? 0n) - a);
    bal.set(r.to, (bal.get(r.to) ?? 0n) + a);
  }
  await insert("agg_balances", [...bal].filter(([, b]) => b !== 0n).map(([holder, b]) => ({ token, holder, balance: b.toString() })), `promote:${token}:${B0}`);
  await setStatus(token, "backfilled", rowsOut.length, "");
  const [tip] = await rows<{ block: string }>("SELECT block FROM ctl_cursors FINAL WHERE name = 'tip'");
  await projectTokens(up, [token], Number(tip.block), `promote:${token}`);
  const [s] = await rows<{ complete: number; minted: string; total_supply: string }>(
    "SELECT complete, toString(minted) AS minted, toString(total_supply) AS total_supply FROM serve_tokens FINAL WHERE token = {t:String}", { t: token });
  const note = `${erc20.length} transfers, ${calls.n} calls, ${Math.round((Date.now() - t0) / 1000)} s`;
  return s?.complete ? { status: "done", transfers: erc20.length, note } : { status: "incomplete", transfers: erc20.length, note: `${note}; minted ${s?.minted} ≠ supply ${s?.total_supply}` };
}

if (import.meta.main) {
  const B0 = await golive();
  console.log(`[promoter] go-live block ${B0}; max ${MAX_TRANSFERS} transfers a token, ${CONCURRENCY} at a time`);
  // The walk holds every token's history above its floor, so promotions wait for it, and afterwards fetch only below it.
  if (process.env.WALK === "1") await walk(up, B0);
  const busy = new Set<string>();
  const worker = async () => { for (;;) {
    const [q] = await rows<{ token: string }>(
      "SELECT token FROM ctl_promotions FINAL WHERE status = 'queued' AND token NOT IN {busy:Array(String)} ORDER BY queued_at LIMIT 1", { busy: [...busy] });
    if (!q || busy.has(q.token)) { await new Promise((r) => setTimeout(r, 2_000)); continue; }
    busy.add(q.token);
    try {
      const top = Math.min(B0, (await walkFloor()) ?? B0);
      const r = top > 0 ? await promote(q.token, top) : { status: "done", transfers: 0, note: "the walk holds its whole history" };
      await setStatus(q.token, r.status, r.transfers, r.note);
      console.log(JSON.stringify({ at: new Date().toISOString(), token: q.token, ...r }));
    } catch (e) {
      await setStatus(q.token, "failed", 0, (e as Error).message.slice(0, 300));
      console.warn(`[promoter] ${q.token}: ${(e as Error).message}`);
    }
    busy.delete(q.token);
  } };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}
