// Background, low priority (migration 029, 2026-11-01): senders, failures and creations per hour for the blocks the
// history pass had already passed when its view landed, go-live down to 51,500,000. Header (for the time) + receipts
// (sender, type, status, created contract) per block, into hist_chain_txs; newest first in 2,000-block chunks on a fixed
// grid, floor in ctl_cursors 'chain_gap', a retried chunk under the same dedup token. One batch of 10 blocks in flight,
// and it waits while ingest or the tracer trails our node by more than 20 blocks: only the charts wait for it.
// `docker compose run -d --name rhnode-gap-fill promoter node src/tools/chain-gap-fill.ts [par]` (`docker start` resumes)
import { ch, insert, rows } from "../ch.ts";

const node = process.env.NITRO_HTTP!;
const BOTTOM = 51_500_000, STEP = 2_000, BATCH = 10, PAR = Number(process.argv[2] ?? 1), MAX_LAG = 20;
const hex = (n: number) => "0x" + n.toString(16);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cursor = async (n: string) => (await rows<{ block: string }>("SELECT block FROM ctl_cursors FINAL WHERE name = {n:String}", { n }))[0]?.block;

type Receipt = { from: string; type: string; status: string; contractAddress: string | null; transactionIndex: string };
async function rpc<T>(body: unknown): Promise<T> {
  const r = await fetch(node, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  return (await r.json()) as T;
}
const many = <T>(method: string, a: number, b: number, p: (n: number) => unknown[]) =>
  rpc<{ result?: T }[]>(Array.from({ length: b - a + 1 }, (_, i) => ({ jsonrpc: "2.0", id: i, method, params: p(a + i) }))).then((j) => j.map((x, i) => {
    if (!x.result) throw new Error(`${method} ${a + i}: no result`);
    return x.result;
  }));

async function txs(lo: number, hi: number) {
  const out: object[] = [];
  let next = lo;
  await Promise.all(Array.from({ length: PAR }, async () => {
    while (next <= hi) {
      const a = next, b = Math.min(hi, a + BATCH - 1);
      next = b + 1;
      const [hs, rs] = await Promise.all([many<{ timestamp: string }>("eth_getBlockByNumber", a, b, (n) => [hex(n), false]),
        many<Receipt[]>("eth_getBlockReceipts", a, b, (n) => [hex(n)])]);
      rs.forEach((block, i) => { for (const r of block) out.push({ block: a + i, tx_index: Number(r.transactionIndex), time: Number(hs[i].timestamp),
        from: r.from.toLowerCase(), type: Number(r.type), status: Number(r.status), created: r.contractAddress?.toLowerCase() ?? "", sign: 1 }); });
    }
  }));
  return out;
}

const golive = Number(await cursor("golive"));
let floor = Number((await cursor("chain_gap")) ?? golive);
console.log(`[gap] floor ${floor} → ${BOTTOM}, ${STEP} blocks a chunk, ${PAR} batches of ${BATCH} in flight`);
while (floor > BOTTOM) {
  try {
    const head = Number.parseInt((await rpc<{ result: string }>({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] })).result, 16);
    const [t] = await rows<{ b: string }>("SELECT min(block) AS b FROM ctl_cursors FINAL WHERE name IN ('tip', 'trace')");
    if (head - Number(t.b) > MAX_LAG) { await sleep(10_000); continue; }
    const t0 = Date.now(), hi = floor - 1, lo = Math.max(BOTTOM, hi - (hi % STEP));
    await insert("hist_chain_txs", await txs(lo, hi), `gap:${lo}`);
    await ch.insert({ table: "ctl_cursors", values: [{ name: "chain_gap", block: lo, hash: "", version: Date.now() }], format: "JSONEachRow" });
    floor = lo;
    if (lo % 200_000 === 0) console.log(JSON.stringify({ at: new Date().toISOString(), gap: lo, bps: Math.round((hi - lo + 1) / ((Date.now() - t0) / 1000)) }));
  } catch (e) {
    console.warn(`[gap] ${(e as Error).message}`);
    await sleep(30_000);
  }
}
console.log(`[gap] reached ${BOTTOM}: the history pass's view covers the rest`);
process.exit(0);
