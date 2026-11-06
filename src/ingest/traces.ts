// Tip traces (TRACES=tip, 2026-10-31). Our node keeps ~1,200 blocks of state (measured 2026-10-31: a trace 1,100 blocks
// back works, 1,300 gives "historical state is not available"), so traces are the one thing taken at the tip or never.
// This follows ingest's `tip` cursor one aligned batch at a time and traces each stored block by its hash, so a trace
// always belongs to the branch we stored. callTracer's tree is flattened into raw_traces (migration 019) and published
// for the stream. 22 ms a block on our node, ~65 frames a block (2026-10-31). If it falls more than MAX_BEHIND blocks
// back it skips ahead and records the gap (ctl_trace_gaps) instead of stalling on blocks it can no longer trace.
// A reorg rollback deletes the rows and rewinds the `trace` cursor (reorg.ts).
import { ch, insert, rows } from "../ch.ts";
import { cfg } from "../config.ts";

export const TRACES = "rh:traces";
const MAX_BEHIND = 1_000;
const B = cfg.batchBlocks;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Frame = { type: string; from: string; to?: string; value?: string; input?: string; error?: string; calls?: Frame[] };
export type TraceRow = { block: number; tx_index: number; tx_hash: string; idx: number; depth: number; type: string;
  from: string; to: string; value: string; selector: string; error: string; time: number };

/** PURE: one tx's callTracer tree as rows in call order (depth-first, parent before children). */
export function flatten(block: number, time: number, tx_index: number, tx_hash: string, root: Frame): TraceRow[] {
  const out: TraceRow[] = [];
  const walk = (f: Frame, depth: number) => {
    out.push({ block, tx_index, tx_hash, idx: out.length, depth, type: f.type, from: f.from.toLowerCase(), to: (f.to ?? "").toLowerCase(),
      value: BigInt(f.value ?? "0x0").toString(), selector: f.input && f.input.length >= 10 ? f.input.slice(0, 10).toLowerCase() : "",
      error: f.error ?? "", time });
    for (const c of f.calls ?? []) walk(c, depth + 1);
  };
  walk(root, 0);
  return out;
}

// One request per block, in parallel: a JSON-RPC batch of 10 traces passed Nitro's batch response limit on a heavy block
// ("response too large"), and retrying it opened four 1,000-block gaps on 2026-10-31. A single call has no such limit.
async function trace(node: string, hashes: string[]): Promise<{ txHash: string; result?: Frame; error?: string }[][]> {
  return Promise.all(hashes.map(async (h) => {
    const r = await fetch(node, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "debug_traceBlockByHash", params: [h, { tracer: "callTracer" }] }) });
    const j = (await r.json()) as { result?: { txHash: string; result?: Frame; error?: string }[]; error?: { message: string } };
    if (!j.result) throw new Error(`debug_traceBlockByHash ${h}: ${j.error?.message ?? `HTTP ${r.status}`}`);
    return j.result;
  }));
}

const cursor = async (name: string) =>
  (await rows<{ block: string }>("SELECT block FROM ctl_cursors FINAL WHERE name = {name:String}", { name }))[0]?.block;
const cursors = async () => Object.fromEntries((await rows<{ name: string; block: string }>(
  "SELECT name, block FROM ctl_cursors FINAL WHERE name IN ('trace', 'tip')")).map((r) => [r.name, Number(r.block)]));
// Each step costs ~5 serial ClickHouse round trips, ~1.4 s when ClickHouse is busy, against ~350 ms to trace 20 blocks
// (2026-11-06 00:10, query_log + a timed trace): at 20 blocks a step the tracer fell behind in bursts (gaps 144, 145).
// Behind by more than CATCHUP batches, a step takes CATCHUP batches, traced one batch at a time (Nitro's load is unchanged).
const CATCHUP = 4;
const setCursor = (block: number, hash: string) =>
  ch.insert({ table: "ctl_cursors", values: [{ name: "trace", block, hash, version: Date.now() }], format: "JSONEachRow" });

export async function traceLoop(node: string, publish?: (msg: string) => Promise<unknown>): Promise<never> {
  let cur = Number((await cursor("trace")) ?? (await cursor("tip")) ?? 0);
  console.log(`[traces] from ${cur + 1}, node ${new URL(node).host}`);
  let tried = { from: 0, to: 0 };
  for (;;) {
    try {
      const c = await cursors();
      if (c.trace !== undefined && c.trace < cur) cur = c.trace; // a rollback rewound it
      const tip = c.tip ?? 0;
      if (tip <= cur) { await sleep(200); continue; }
      if (tip - cur > MAX_BEHIND) {
        const skip = tip - B; // the tip cursor is a batch end, so this is the end of the batch before it
        await ch.insert({ table: "ctl_trace_gaps", values: [{ from_block: cur + 1, to_block: skip }], format: "JSONEachRow" });
        console.warn(`[traces] ${tip - cur} blocks behind: gap ${cur + 1}..${skip} not traced`);
        await setCursor(skip, "");
        cur = skip;
        continue;
      }
      const from = cur + 1, S = tip - cur > CATCHUP * B ? CATCHUP * B : B;
      // a retry of a failed step takes the same range, so its dedup token drops rows the failed try already stored
      const to = from === tried.from && tried.to <= tip ? tried.to :Math.min(tip, from - (from % S) + S - 1);
      tried = { from, to };
      const blocks = await rows<{ number: string; hash: string; time: number }>(
        "SELECT number, hash, toUInt32(time) AS time FROM raw_blocks WHERE number BETWEEN {from:UInt64} AND {to:UInt64} AND sign = 1 ORDER BY number",
        { from, to });
      if (blocks.length !== to - from + 1) { await sleep(500); continue; } // a rollback is under way
      const res: Awaited<ReturnType<typeof trace>> = [];
      for (let i = 0; i < blocks.length; i += B) res.push(...await trace(node, blocks.slice(i, i + B).map((b) => b.hash)));
      const out = blocks.flatMap((b, i) => res[i].flatMap((x, tx) => (x.result ? flatten(Number(b.number), b.time, tx, x.txHash.toLowerCase(), x.result) : [])));
      const last = blocks[blocks.length - 1].hash;
      await insert("raw_traces", out, `${from}-${to}:${last}`);
      // A reorg between reading the hashes and now: those rows are of the dropped branch, so delete them and trace again
      const [still] = await rows<{ n: string }>("SELECT count() AS n FROM raw_blocks WHERE number = {to:UInt64} AND hash = {h:String} AND sign = 1", { to, h: last });
      if (Number(still.n) === 0) {
        await ch.command({ query: "DELETE FROM raw_traces WHERE block BETWEEN {from:UInt64} AND {to:UInt64}", query_params: { from, to } });
        continue;
      }
      await setCursor(to, last);
      cur = to;
      publish?.(JSON.stringify(blocks.map((b, i) => ({ block: Number(b.number), hash: b.hash, rows: out.filter((r) => r.block === Number(b.number)) }))))
        .catch((e: Error) => console.warn(`[traces] publish: ${e.message}`));
    } catch (e) {
      console.warn(`[traces] ${(e as Error).message}`);
      await sleep(2_000);
    }
  }
}
