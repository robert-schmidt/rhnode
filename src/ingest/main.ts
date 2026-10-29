// Ingest (ARCHITECTURE §4). `node src/ingest/main.ts` follows the tip from the `tip` cursor;
// `node src/ingest/main.ts backfill FROM TO` re-reads a range through the same code.
//
// Batches are aligned to multiples of BATCH_BLOCKS and inserted with the token "from-to:lasthash", so a
// batch written twice (killed before the cursor moved, or a backfill over ingested blocks) is dropped
// by ClickHouse, while the same range on a new branch after a reorg is not. A kill at any point is
// safe; there is no shutdown handler.
import { cfg } from "../config.ts";
import { ch, insert, rows } from "../ch.ts";
import { migrate } from "../migrate.ts";
import { upstream, type Client } from "../chain/upstream.ts";
import { decodeBlock, emptyRows, type RpcBlock, type RpcReceipt, type Rows } from "./decode.ts";
import { learn, loadCtx, type KeepCtx } from "./keep.ts";
import { findFork, rollback, storedHash } from "./reorg.ts";
import { BLOCKS, connect } from "../bus.ts";

const hex = (n: number) => "0x" + n.toString(16);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const B = cfg.batchBlocks;
const windowSec = cfg.launchWindowHours * 3600;

async function fetchBlock(up: Client, n: number): Promise<[RpcBlock, RpcReceipt[]]> {
  for (let a = 0; ; a++) {
    const [b, r] = await Promise.all([
      up.call<RpcBlock>("eth_getBlockByNumber", [hex(n), true]),
      up.call<RpcReceipt[]>("eth_getBlockReceipts", [hex(n)]),
    ]);
    // Two endpoints can answer from different branches during a reorg: only a matching pair is used.
    if (r.length === b.transactions.length && r.every((x) => x.blockHash.toLowerCase() === b.hash.toLowerCase())) return [b, r];
    if (a >= 5) throw new Error(`block ${n}: block and receipts still disagree after ${a + 1} tries`);
    await sleep(300);
  }
}

/** Fetch, decode and insert blocks from..to (one aligned batch). `parent` = hash expected as block from's parent. */
export class Reorg extends Error {}

export async function runBatch(up: Client, from: number, to: number, ctx: KeepCtx, parent: string | null) {
  let fetched = await Promise.all(Array.from({ length: to - from + 1 }, (_, i) => fetchBlock(up, from + i)));
  // Blocks fetched in parallel can straddle a reorg: refetch once before believing a broken chain.
  const linked = () => fetched.every(([b], i) => i === 0 || b.parentHash.toLowerCase() === fetched[i - 1][0].hash.toLowerCase());
  if (!linked()) fetched = await Promise.all(Array.from({ length: to - from + 1 }, (_, i) => fetchBlock(up, from + i)));
  if (!linked()) throw new Error(`blocks ${from}..${to} don't link after a refetch`);
  if (parent && fetched[0][0].parentHash.toLowerCase() !== parent) throw new Reorg(`reorg below ${from}: parent ${fetched[0][0].parentHash} != stored ${parent}`);
  const all = emptyRows();
  let hash = parent;
  let time = 0;
  for (const [b, r] of fetched) {
    const out = decodeBlock(b, r, ctx);
    learn(ctx, out);
    for (const k of Object.keys(all) as (keyof Rows)[]) for (const row of out[k]) (all[k] as object[]).push(row);
    hash = b.hash.toLowerCase();
    time = Number(b.timestamp);
  }
  await Promise.all(Object.entries(all).map(([table, rs]) => insert(table, rs, `${from}-${to}:${hash}`)));
  return { hash: hash!, time, blocks: fetched, counts: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.length])) };
}

function reporter(up: Client) {
  const total: Record<string, number> = {};
  let at = Date.now();
  return (block: number, head: number, time: number, counts: Record<string, number>) => {
    for (const [k, v] of Object.entries(counts)) total[k] = (total[k] ?? 0) + v;
    if (Date.now() - at < 30_000) return;
    at = Date.now();
    const lagS = Math.round(Date.now() / 1000 - time);
    console.log(JSON.stringify({ at: new Date().toISOString(), block, head, lagBlocks: head - block, lagS, rows: total, upstream: up.stats() }));
  };
}

const setCursor = (block: number, hash: string) =>
  ch.insert({ table: "ctl_cursors", values: [{ name: "tip", block, hash, version: Date.now() }], format: "JSONEachRow" });

async function tip(up: Client) {
  const cur = (await rows<{ block: string; hash: string }>("SELECT block, hash FROM ctl_cursors FINAL WHERE name = 'tip'"))[0];
  let next = cur ? Number(cur.block) + 1 : Math.floor((cfg.startBlock ?? (await up.head())) / B) * B;
  let parent: string | null = cur?.hash ?? null;
  let ctx = await loadCtx(windowSec), ctxAt = Date.now();
  const report = reporter(up);
  const bus = await connect();
  console.log(`[ingest] tip from ${next} (${cur ? "cursor" : "cold start"}), batch ${B}, ttl ${cfg.rawTtlDays}d, upstreams ${up.stats().map((s) => s.host).join(", ")}`);
  for (;;) {
    const end = next - (next % B) + B - 1;
    let head = await up.head();
    while (head < end) { await sleep(400); head = await up.head(); }
    if (Date.now() - ctxAt > 15_000) { ctx = await loadCtx(windowSec); ctxAt = Date.now(); }
    let r;
    try {
      r = await runBatch(up, next, end, ctx, parent);
    } catch (e) {
      if (!(e instanceof Reorg)) throw e;
      const fork = await findFork(next - 1, storedHash, async (n) => (await up.call<{ hash: string }>("eth_getBlockByNumber", [hex(n), false])).hash.toLowerCase());
      if (fork === null) throw new Error(`${e.message}; no common block within 1000: stopping`);
      const from = fork + 1 - ((fork + 1) % B); // re-ingest whole aligned batches
      console.warn(`[ingest] ${e.message}; fork at ${fork}, rolling back from ${from}`);
      await rollback(from, parent!);
      parent = from > 0 ? await storedHash(from - 1) : null;
      await setCursor(from - 1, parent ?? "");
      next = from;
      continue;
    }
    await setCursor(end, r.hash);
    // The API's /ws fan-out: headers + logs, after they are stored (so a resume from ClickHouse never misses one).
    bus?.publish(BLOCKS, JSON.stringify(r.blocks.map(([b, rc]) => ({ header: { ...b, transactions: undefined }, logs: rc.flatMap((x) => x.logs) }))))
      .catch((e: Error) => console.warn(`[ingest] publish: ${e.message}`));
    report(end, head, r.time, r.counts);
    parent = r.hash;
    next = end + 1;
  }
}

async function backfill(up: Client, from: number, to: number) {
  const start = from - (from % B);
  let ctx = await loadCtx(windowSec), ctxAt = Date.now();
  let parent: string | null = null;
  const report = reporter(up);
  for (let a = start; a <= to; a += B) {
    if (Date.now() - ctxAt > 15_000) { ctx = await loadCtx(windowSec); ctxAt = Date.now(); }
    const r = await runBatch(up, a, a + B - 1, ctx, parent);
    parent = r.hash;
    report(a + B - 1, to, r.time, r.counts);
  }
  console.log(`[backfill] ${start}..${to - (to % B) + B - 1} done`);
}

if (import.meta.main) {
  if (cfg.ingestScope !== "all") throw new Error("INGEST_SCOPE=watched is not built yet (lite profile, after M1). Set INGEST_SCOPE=all.");
  if (cfg.traces !== "off") throw new Error("TRACES=tip needs our own node (M6). Set TRACES=off.");
  await migrate();
  const up = upstream(cfg.upstreamHttp);
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "backfill") await backfill(up, Number(a), Number(b));
  else await tip(up);
  await ch.close();
}
