// The wallet scan (2026-10-30: one pass, all wallets). Our node is pruned and has no address index, so the
// txs of a wallet before go-live are found only by reading every block. One pass, from go-live down to genesis, newest
// first, writes a pointer for each tx's sender, recipient and created contract into idx_wallet_txs (migration 015), and
// each ETH transfer that happened into native_edges (migration 016: a value tx whose receipt says it succeeded).
// ctl_cursors 'scan' is its floor: every wallet's txs from there on are indexed. It runs only while our node is synced
// and ingest keeps up, and rests in proportion to its work, as the walk does (src/promoter/walk.ts).
// Measured 2026-10-30 on the node box while Nitro was still syncing: 8×25 blocks in flight read ~1,880 blocks/s, so the
// pass to genesis takes ~15 h of work (~30 h at the default duty). The receipts of value txs add 60-100% (measured at
// blocks 90M, 60M, 30M: +0.5-1.1 s per 2,000 blocks; 1.6-17% of those txs failed), so ~25-30 h at duty 1.
import { getContractAddress } from "viem";
import { ch, insert, rows } from "../ch.ts";
import { watchNitro } from "../chain/nitro.ts";
import { idle } from "./walk.ts";

const STEP = 2_000; // blocks a chunk (the cursor moves per chunk)
const BATCH = 25; // blocks a JSON-RPC batch
const PAR = Number(process.env.SCAN_PAR ?? 8); // batches in flight
const DUTY = Number(process.env.SCAN_DUTY ?? 0.5);
const ARBOS = "0x6a"; // ArbOS's start-of-block tx: one in every block, always from the same address

type Tx = { hash: string; from: string; to: string | null; nonce: string; transactionIndex: string; type: string; value: string };
type Block = { number: string; timestamp: string; transactions: Tx[] };
type Row = { wallet: string; block: number; tx_index: number };
type Edge = { dst: string; src: string; value: string; block: number; tx_index: number; path: string; type: number; time: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) => "0x" + n.toString(16);

export async function scanFloor(): Promise<number | null> {
  const [c] = await rows<{ block: string }>("SELECT block FROM ctl_cursors FINAL WHERE name = 'scan'");
  return c ? Number(c.block) : null;
}

async function blocks(node: string, from: number, to: number): Promise<Block[]> {
  const req = [];
  for (let n = from; n <= to; n++) req.push({ jsonrpc: "2.0", id: n, method: "eth_getBlockByNumber", params: [hex(n), true] });
  const r = await fetch(node, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), signal: AbortSignal.timeout(120_000) });
  const j = (await r.json()) as { result?: Block; error?: { message: string } }[];
  const bad = Array.isArray(j) ? j.find((x) => !x.result) : null;
  if (!Array.isArray(j) || bad) throw new Error(`blocks ${from}-${to}: ${bad?.error?.message ?? `HTTP ${r.status}`}`);
  return j.map((x) => x.result!);
}

/** The value txs whose receipts say they succeeded. */
async function succeeded(node: string, txs: { hash: string }[]): Promise<Set<string>> {
  const ok = new Set<string>();
  for (let i = 0; i < txs.length; i += 100) {
    const req = txs.slice(i, i + 100).map((t, k) => ({ jsonrpc: "2.0", id: k, method: "eth_getTransactionReceipt", params: [t.hash] }));
    const r = await fetch(node, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req), signal: AbortSignal.timeout(120_000) });
    const j = (await r.json()) as { result?: { transactionHash: string; status: string } | null; error?: { message: string } }[];
    const bad = Array.isArray(j) ? j.find((x) => !x.result) : null;
    if (!Array.isArray(j) || bad) throw new Error(`receipts: ${bad?.error?.message ?? `HTTP ${r.status}`}`);
    for (const x of j) if (x.result!.status === "0x1") ok.add(x.result!.transactionHash.toLowerCase());
  }
  return ok;
}

/** What a block gives: a pointer for each tx's sender, recipient and created contract (once each), and an edge for
 *  each tx that carries ETH (kept only if its receipt says it succeeded). */
export function pointers(b: Block): { rows: Row[]; edges: (Edge & { hash: string })[] } {
  const block = Number(b.number), time = Number(b.timestamp), rows: Row[] = [], edges: (Edge & { hash: string })[] = [];
  for (const t of b.transactions) {
    if (t.type === ARBOS) continue;
    const tx_index = Number(t.transactionIndex), from = t.from.toLowerCase();
    const created = t.to ? "" : getContractAddress({ from: t.from as `0x${string}`, nonce: BigInt(t.nonce) }).toLowerCase();
    for (const wallet of new Set([from, (t.to ?? "").toLowerCase(), created])) if (wallet) rows.push({ wallet, block, tx_index });
    if (BigInt(t.value) > 0n) edges.push({ dst: t.to ? t.to.toLowerCase() : created, src: from, value: BigInt(t.value).toString(), block, tx_index,
      path: "", type: Number(t.type), time, hash: t.hash.toLowerCase() });
  }
  return { rows, edges };
}

/** Pointers and edges of [lo, hi], fetched in batches, PAR at a time. */
async function chunk(node: string, lo: number, hi: number): Promise<{ rows: Row[]; edges: Edge[] }> {
  const parts: [number, number][] = [];
  for (let a = lo; a <= hi; a += BATCH) parts.push([a, Math.min(hi, a + BATCH - 1)]);
  const out = { rows: [] as Row[], edges: [] as Edge[] };
  const work = async () => { for (let p = parts.shift(); p; p = parts.shift()) {
    const got = (await blocks(node, p[0], p[1])).map(pointers), maybe = got.flatMap((r) => r.edges);
    const ok = await succeeded(node, maybe);
    for (const r of got) out.rows.push(...r.rows);
    for (const { hash, ...e } of maybe) if (ok.has(hash)) out.edges.push(e);
  } };
  await Promise.all(Array.from({ length: PAR }, work));
  return out;
}

export async function scan(golive: number): Promise<void> {
  const node = process.env.NITRO_HTTP;
  if (!node) throw new Error("SCAN=1 needs NITRO_HTTP (our own node)");
  watchNitro(node);
  let floor = (await scanFloor()) ?? golive;
  console.log(`[scan] floor ${floor}, ${STEP} blocks a chunk, ${PAR}×${BATCH} in flight, duty ${DUTY}`);
  while (floor > 0) {
    try {
      if (!(await idle())) { await sleep(10_000); continue; }
      const t0 = Date.now();
      const hi = floor - 1, lo = hi - (hi % STEP); // a fixed grid: a retried chunk writes the same rows under the same token
      const out = await chunk(node, lo, hi);
      if (out.edges.length) await insert("native_edges", out.edges, `scan:${lo}`);
      if (out.rows.length) await insert("idx_wallet_txs", out.rows, `scan:${lo}`);
      await ch.insert({ table: "ctl_cursors", values: [{ name: "scan", block: lo, hash: "", version: Date.now() }], format: "JSONEachRow" });
      floor = lo;
      const ms = Date.now() - t0;
      if (lo % 100_000 === 0) console.log(JSON.stringify({ at: new Date().toISOString(), scan: lo, pointers: out.rows.length, edges: out.edges.length, ms }));
      await sleep(ms * (1 / DUTY - 1));
    } catch (e) {
      console.warn(`[scan] ${(e as Error).message}`);
      await sleep(30_000);
    }
  }
  console.log("[scan] reached genesis: every wallet's txs are indexed");
}

// Bench: `node src/promoter/scan.ts bench <from> <blocks>`: fetch speed and pointers, nothing written.
if (import.meta.main && process.argv[2] === "bench") {
  const from = Number(process.argv[3]), n = Number(process.argv[4] ?? 2_000), t0 = Date.now();
  const out = await chunk(process.env.NITRO_HTTP ?? "http://127.0.0.1:8547", from, from + n - 1);
  const s = (Date.now() - t0) / 1000;
  console.log(`${n} blocks, ${out.rows.length} pointers, ${out.edges.length} edges in ${s.toFixed(1)} s: ${Math.round(n / s)} blocks/s`);
}
