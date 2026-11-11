// One-off (2026-11-11, a client's report): the launches of launchpads the registry learned after ingest had passed them (Bags'
// second factory since 54,594,936, V3LaunchFactory, Trader Book): their registry logs from our node, decoded as ingest does
// (registryRow), into kept_launches. Idempotent: kept_launches is a ReplacingMergeTree on (token, block, log_index).
// `node src/tools/launch-backfill.ts <from> <to> [--dry]` (NITRO_HTTP); STEP blocks a getLogs (default 200,000).
import { insert } from "../ch.ts";
import { registryEntries } from "../chain/registry.ts";
import { BAGS_FACTORY_V2, TRADERBOOK_PAD, V3LAUNCH_FACTORY } from "../chain/constants.ts";
import { emptyRows, registryRow } from "../ingest/decode.ts";

const node = process.env.NITRO_HTTP;
if (!node) throw new Error("NITRO_HTTP (our own node) is required");
const [from, to] = [Number(process.argv[2]), Number(process.argv[3])];
if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) throw new Error("usage: launch-backfill.ts <from> <to> [--dry]");
const DRY = process.argv.includes("--dry"), STEP = Number(process.env.STEP ?? 200_000);
const ADDRS = [BAGS_FACTORY_V2, V3LAUNCH_FACTORY, TRADERBOOK_PAD];
const TOPICS = [...new Set(registryEntries.filter((e) => ADDRS.includes(e.address)).map((e) => e.topic0))];
const hex = (n: number) => "0x" + n.toString(16);

type Log = { address: string; topics: string[]; data: `0x${string}`; blockNumber: string; blockHash: string; transactionHash: string;
  transactionIndex: string; logIndex: string; blockTimestamp?: string };
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(node!, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(600_000) });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error || j.result === undefined) throw new Error(`${method}: ${j.error?.message ?? `HTTP ${r.status}`}`);
  return j.result;
}

const times = new Map<string, number>();
let total = 0;
for (let b = from; b <= to; b += STEP) {
  const hi = Math.min(to, b + STEP - 1), t0 = Date.now();
  const logs = await rpc<Log[]>("eth_getLogs", [{ address: ADDRS, topics: [TOPICS], fromBlock: hex(b), toBlock: hex(hi) }]);
  const out = emptyRows();
  for (const l of logs) {
    let time = Number(l.blockTimestamp ?? 0) || times.get(l.blockNumber) || 0;
    if (!time) times.set(l.blockNumber, time = Number((await rpc<{ timestamp: string }>("eth_getBlockByNumber", [l.blockNumber, false])).timestamp));
    registryRow(l, { block: Number(l.blockNumber), tx_index: Number(l.transactionIndex), log_index: Number(l.logIndex),
      tx_hash: l.transactionHash.toLowerCase(), time, keep: 512, sign: 1 }, out);
  }
  if (!DRY) await insert("kept_launches", out.ev_launches, `launch-backfill:${b}-${hi}`);
  total += out.ev_launches.length;
  const by = Object.entries(Object.groupBy(out.ev_launches, (r) => `${String(r.source)}:${r.kind}`)).map(([k, v]) => `${k}=${v!.length}`);
  console.log(JSON.stringify({ from: b, to: hi, logs: logs.length, rows: out.ev_launches.length, by, ms: Date.now() - t0, dry: DRY }));
}
console.log(`done: ${total} rows ${DRY ? "(dry run)" : "into kept_launches"}`);
process.exit(0);
