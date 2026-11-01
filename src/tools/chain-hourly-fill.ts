// One-off for migration 028 (2026-11-01): the explorer's "Chain over time" before go-live, from block headers. From
// go-live down to genesis, newest first, in 10,000-block chunks on a fixed grid; its floor is ctl_cursors 'hourly', and a
// retried chunk carries the same dedup token. Waits while ingest (or the tracer) trails our node, as the history pass does.
// Measured 2026-11-01: ~1,700 headers/s at 4 in flight beside the history pass, so ~17 h for 101M blocks.
// `docker compose run -d --name rhnode-hourly-fill promoter node src/tools/chain-hourly-fill.ts [par]`
import { ch, insert, rows } from "../ch.ts";

const node = process.env.NITRO_HTTP!;
const STEP = 10_000, BATCH = 100, PAR = Number(process.argv[2] ?? 4), MAX_LAG = 50;
const hex = (n: number) => "0x" + n.toString(16);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cursor = async (n: string) => (await rows<{ block: string }>("SELECT block FROM ctl_cursors FINAL WHERE name = {n:String}", { n }))[0]?.block;

type Head = { number: string; hash: string; parentHash: string; timestamp: string; gasUsed: string; baseFeePerGas?: string; transactions: string[] };
async function rpc<T>(body: unknown): Promise<T> {
  const r = await fetch(node, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  return (await r.json()) as T;
}

async function headers(lo: number, hi: number) {
  const out: object[] = [];
  let next = lo;
  await Promise.all(Array.from({ length: PAR }, async () => {
    while (next <= hi) {
      const a = next, b = Math.min(hi, a + BATCH - 1);
      next = b + 1;
      const j = await rpc<{ result?: Head }[]>(Array.from({ length: b - a + 1 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "eth_getBlockByNumber", params: [hex(a + i), false] })));
      for (const x of j) {
        const h = x.result;
        if (!h) throw new Error(`no header in ${a}-${b}`);
        out.push({ number: Number(h.number), hash: h.hash, parent_hash: h.parentHash, time: Number(h.timestamp), tx_count: h.transactions.length,
          gas_used: Number(h.gasUsed), base_fee: Number(h.baseFeePerGas ?? 0), sign: 1 });
      }
    }
  }));
  if (out.length !== hi - lo + 1) throw new Error(`${lo}-${hi}: ${out.length} headers`);
  return out;
}

const golive = Number(await cursor("golive"));
let floor = Number((await cursor("hourly")) ?? golive);
console.log(`[hourly] floor ${floor}, ${STEP} blocks a chunk, ${PAR} batches of ${BATCH} in flight`);
while (floor > 0) {
  try {
    const head = Number.parseInt((await rpc<{ result: string }>({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] })).result, 16);
    const [t] = await rows<{ b: string }>("SELECT min(block) AS b FROM ctl_cursors FINAL WHERE name IN ('tip', 'trace')");
    if (head - Number(t.b) > MAX_LAG) { await sleep(10_000); continue; }
    const t0 = Date.now(), hi = floor - 1, lo = hi - (hi % STEP);
    await insert("hist_blocks", await headers(lo, hi), `hourly:${lo}`);
    await ch.insert({ table: "ctl_cursors", values: [{ name: "hourly", block: lo, hash: "", version: Date.now() }], format: "JSONEachRow" });
    floor = lo;
    if (lo % 1_000_000 === 0) console.log(JSON.stringify({ at: new Date().toISOString(), hourly: lo, bps: Math.round((hi - lo + 1) / ((Date.now() - t0) / 1000)) }));
  } catch (e) {
    console.warn(`[hourly] ${(e as Error).message}`);
    await sleep(30_000);
  }
}
console.log("[hourly] reached genesis");
process.exit(0);
