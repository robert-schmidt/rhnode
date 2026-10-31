// The history pass (2026-10-30, "single pass with full decoding"). From go-live down to genesis on our own node,
// newest first, every block and all its receipts are read once and decoded by ingest's own decoder
// (src/ingest/decode.ts). The rows go into the hist_* tables (migration 017), whose views keep forever, with the live
// views' expressions: every wallet's tx pointers, ETH transfers, first txs, ERC-20 transfers, swaps, launches, pools,
// Relay fills and ERC-4337 UserOperationEvents (what the projector needs to derive prices, candles and trades).
// agg_balances is summed here. Tokens that token promotion already backfilled are left out of it: their history before
// go-live is in it already. Token promotion doesn't run while the pass does (src/promoter/main.ts).
// It replaced two passes (Transfers by getLogs, then blocks + receipts of value txs). Measured 2026-10-30 at five
// heights: ~10% less node work, plus every event type. ~830 blocks/s on the node box while Nitro was syncing, so ~34 h.
// ctl_cursors 'walk' and 'scan' both hold its floor: 'walk' is exactFrom and token promotion's top, 'scan' the
// explorer's tx coverage. Chunks sit on a fixed grid, so a retried chunk writes the same rows under the same tokens.
// It runs only while our node is synced and ingest keeps up. Its concurrency adapts (paceStep): it grows while ingest
// stays within a few blocks of our node and our node within a few of the chain, and halves when either trails. The tip
// and the live stream come first.
import { ch, insert, rows } from "../ch.ts";
import { cfg } from "../config.ts";
import { nitro, nitroSynced, watchNitro } from "../chain/nitro.ts";
import { decodeBlock, emptyRows, type RpcBlock, type RpcReceipt } from "../ingest/decode.ts";
import { emptyCtx } from "../ingest/keep.ts";
import { projectTokens } from "../projector/main.ts";
import { USER_OP_EVENT } from "../projector/trades.ts";
import type { Client } from "../chain/upstream.ts";

const STEP = 2_000; // blocks a chunk (the cursor moves per chunk)
const BATCH = 10; // blocks a JSON-RPC batch (and as many receipts)
const PAR_MAX = Number(process.env.HISTORY_PAR_MAX ?? 32);
const MAX_LAG = 50; // blocks ingest may trail our node before the pass waits
const INSERT_ROWS = 100_000;
const PROJECT_EVERY = 1_000_000; // blocks between re-projections of the tokens it touched
const HIST = { raw_txs: "hist_txs", raw_logs: "hist_logs", ev_transfers: "hist_transfers", ev_swaps: "hist_swaps", ev_launches: "hist_launches", ev_pools: "hist_pools", ev_relay: "hist_relay" } as const;
type Hist = { [K in keyof typeof HIST]: object[] };
type Transfer = { token: string; from: string; to: string; amount: string; standard: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) => "0x" + n.toString(16);

export async function walkFloor(): Promise<number | null> {
  const [c] = await rows<{ block: string }>("SELECT block FROM ctl_cursors FINAL WHERE name = 'walk'");
  return c ? Number(c.block) : null;
}

/** Blocks ingest trails our node by (null: the node isn't synced or known). */
async function ingestLag(): Promise<number | null> {
  if (!nitroSynced() || nitro.head == null) return null;
  // With tip traces the tracer counts as ingest: it lost three 1,000-block windows on 2026-10-31 while the pass ran at
  // 32 in flight and ingest itself kept up, so the pass backs off when either trails.
  const [t] = await rows<{ b: string }>("SELECT min(block) AS b FROM ctl_cursors FINAL WHERE name IN {n:Array(String)}",
    { n: cfg.traces === "tip" ? ["tip", "trace"] : ["tip"] });
  return nitro.head - Number(t?.b ?? 0);
}

/** PURE: the next concurrency. +1 while ingest is within 5 blocks of our node and our node within 5 of the chain, halved
 *  when either trails by more than 20, else unchanged. */
export function paceStep(par: number, lag: number, behind: number | null, max = PAR_MAX): number {
  if (lag > 20 || (behind ?? 0) > 20) return Math.max(1, par >> 1);
  if (lag <= 5 && (behind ?? 0) <= 5) return Math.min(max, par + 1);
  return par;
}

/** PURE: what ERC-20 transfers add to agg_balances, per (token, holder), leaving out `skip` tokens. */
export function balances(ts: Transfer[], skip: Set<string>): { token: string; holder: string; balance: string }[] {
  const bal = new Map<string, bigint>();
  for (const t of ts) {
    if (t.standard !== "erc20" || skip.has(t.token)) continue;
    let a = BigInt(t.amount);
    if (a >= 1n << 255n) a -= 1n << 256n; // toInt256 wraps the same way in mv_agg_balances (spam amounts only)
    bal.set(t.token + t.from, (bal.get(t.token + t.from) ?? 0n) - a);
    bal.set(t.token + t.to, (bal.get(t.token + t.to) ?? 0n) + a);
  }
  return [...bal].filter(([, b]) => b !== 0n).map(([k, b]) => ({ token: k.slice(0, 42), holder: k.slice(42), balance: b.toString() }));
}

async function batch<T>(node: string, method: string, from: number, to: number, params: (n: number) => unknown[]): Promise<T[]> {
  const req = [];
  for (let n = from; n <= to; n++) req.push({ jsonrpc: "2.0", id: n, method, params: params(n) });
  const r = await fetch(node, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), signal: AbortSignal.timeout(120_000) });
  const j = (await r.json()) as { result?: T; error?: { message: string } }[];
  const bad = Array.isArray(j) ? j.find((x) => !x.result) : null;
  if (!Array.isArray(j) || bad) throw new Error(`${method} ${from}-${to}: ${bad?.error?.message ?? `HTTP ${r.status}`}`);
  return j.map((x) => x.result!);
}

/** [lo, hi] decoded, `par` batches in flight. */
export async function chunk(node: string, lo: number, hi: number, par: number): Promise<Hist> {
  const parts: [number, number][] = [];
  for (let a = lo; a <= hi; a += BATCH) parts.push([a, Math.min(hi, a + BATCH - 1)]);
  const out: Hist = { raw_txs: [], raw_logs: [], ev_transfers: [], ev_swaps: [], ev_launches: [], ev_pools: [], ev_relay: [] };
  const ctx = emptyCtx(); // keep bits come from the HISTORY views, not from watchlists
  const work = async () => { for (let p = parts.shift(); p; p = parts.shift()) {
    const [bs, rs] = await Promise.all([
      batch<RpcBlock>(node, "eth_getBlockByNumber", p[0], p[1], (n) => [hex(n), true]),
      batch<RpcReceipt[]>(node, "eth_getBlockReceipts", p[0], p[1], (n) => [hex(n)]),
    ]);
    for (let i = 0; i < bs.length; i++) {
      const d = decodeBlock(bs[i], rs[i], ctx);
      d.raw_logs = d.raw_logs.filter((l) => (l as { topic0: string }).topic0 === USER_OP_EVENT); // the only raw logs kept
      for (const k of Object.keys(HIST) as (keyof Hist)[]) out[k].push(...(d[k as keyof ReturnType<typeof emptyRows>] as object[]));
    }
  } };
  await Promise.all(Array.from({ length: Math.min(par, parts.length) }, work));
  return out;
}

export async function write(lo: number, h: Hist, skip: Set<string>): Promise<{ sums: number }> {
  for (const [k, table] of Object.entries(HIST) as [keyof Hist, string][])
    for (let i = 0; i < h[k].length; i += INSERT_ROWS) await insert(table, h[k].slice(i, i + INSERT_ROWS), `hist:${lo}:${i}`);
  const sums = balances(h.ev_transfers as Transfer[], skip);
  for (let i = 0; i < sums.length; i += INSERT_ROWS) await insert("agg_balances", sums.slice(i, i + INSERT_ROWS), `hist:${lo}:${i}`);
  return { sums: sums.length };
}

export async function history(up: Client, golive: number): Promise<void> {
  const node = process.env.NITRO_HTTP;
  if (!node) throw new Error("HISTORY=1 needs NITRO_HTTP (our own node)");
  watchNitro(node);
  let floor = (await walkFloor()) ?? golive, par = 4, projectedAt = floor;
  const dirty = new Set<string>();
  console.log(`[history] floor ${floor}, ${STEP} blocks a chunk, ${BATCH} blocks a batch, up to ${PAR_MAX} in flight`);
  while (floor > 0) {
    try {
      const lag = await ingestLag();
      if (lag == null || lag > MAX_LAG) { await sleep(10_000); continue; }
      par = paceStep(par, lag, nitro.behind);
      const t0 = Date.now();
      const hi = floor - 1, lo = hi - (hi % STEP);
      const skip = new Set((await rows<{ token: string }>(
        "SELECT token FROM ctl_promotions FINAL WHERE status IN ('backfilled', 'done', 'incomplete')")).map((r) => r.token));
      const h = await chunk(node, lo, hi, par);
      const { sums } = await write(lo, h, skip);
      for (const t of h.ev_transfers as Transfer[]) dirty.add(t.token);
      await ch.insert({ table: "ctl_cursors", values: ["walk", "scan"].map((name) => ({ name, block: lo, hash: "", version: Date.now() })), format: "JSONEachRow" });
      floor = lo;
      if (projectedAt - floor >= PROJECT_EVERY || floor === 0) {
        const [tip] = await rows<{ block: string }>("SELECT block FROM ctl_cursors FINAL WHERE name = 'tip'");
        await projectTokens(up, [...dirty], Number(tip.block), `history:${floor}`);
        dirty.clear();
        projectedAt = floor;
      }
      const ms = Date.now() - t0;
      if (lo % 20_000 === 0) console.log(JSON.stringify({ at: new Date().toISOString(), history: lo, par, lag, behind: nitro.behind, ms,
        bps: Math.round(STEP / (ms / 1000)), txs: h.raw_txs.length, transfers: h.ev_transfers.length, swaps: h.ev_swaps.length, holders: sums }));
    } catch (e) {
      par = Math.max(1, par >> 1);
      console.warn(`[history] ${(e as Error).message}`);
      await sleep(30_000);
    }
  }
  console.log("[history] reached genesis: every block is decoded");
}

// Bench: `node src/promoter/history.ts bench <from> <blocks> [par]`: fetch + decode speed, nothing written.
if (import.meta.main && process.argv[2] === "bench") {
  const from = Number(process.argv[3]), n = Number(process.argv[4] ?? 2_000), par = Number(process.argv[5] ?? 8), t0 = Date.now();
  const h = await chunk(process.env.NITRO_HTTP ?? "http://127.0.0.1:8547", from, from + n - 1, par);
  const s = (Date.now() - t0) / 1000;
  console.log(`${n} blocks at ${par} in flight: ${Math.round(n / s)} blocks/s;`, Object.entries(h).map(([k, v]) => `${k} ${v.length}`).join(", "));
}
