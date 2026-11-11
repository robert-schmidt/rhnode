// One-off (2026-11-11): the creation block of pools whose factory the registry doesn't decode (v2/v3 forks), so their pools
// rows came from a lookup with created_block 0. Our node's logs of those factories (any event: a factory emits little else)
// are matched against the pools in their data or topics, and each found pool's row is rewritten with the block and the
// event-level version (migration 041). Idempotent. `node src/tools/pool-created-backfill.ts <from> <to> [--dry]` (NITRO_HTTP)
import { insert, rows, workload } from "../ch.ts";

const node = process.env.NITRO_HTTP;
if (!node) throw new Error("NITRO_HTTP (our own node) is required");
const [from, to] = [Number(process.argv[2]), Number(process.argv[3])];
if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to) throw new Error("usage: pool-created-backfill.ts <from> <to> [--dry]");
const DRY = process.argv.includes("--dry"), STEP = Number(process.env.STEP ?? 200_000), EVENT_VERSION = 2n ** 41n;
const hex = (n: number) => "0x" + n.toString(16);

type Log = { address: string; topics: string[]; data: string; blockNumber: string; blockTimestamp?: string };
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(node!, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(600_000) });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error || j.result === undefined) throw new Error(`${method}: ${j.error?.message ?? `HTTP ${r.status}`}`);
  return j.result;
}

async function main() {
  type Pool = Record<string, unknown> & { pool: string; factory: string };
  const zero = new Map((await rows<Pool>("SELECT * FROM pools FINAL WHERE created_block = 0 AND factory != '' AND ok = 1")).map((p) => [p.pool, p]));
  const factories = [...new Set([...zero.values()].map((p) => p.factory))];
  console.log(`${zero.size} pools of ${factories.length} factories have no creation block`);
  let found = 0;
  for (let b = from; b <= to && zero.size; b += STEP) {
    const hi = Math.min(to, b + STEP - 1), t0 = Date.now();
    const logs = await rpc<Log[]>("eth_getLogs", [{ address: factories, fromBlock: hex(b), toBlock: hex(hi) }]);
    const out: object[] = [];
    for (const l of logs) {
      // every 32-byte word of the data and every topic after the first, as an address
      const words = [...l.topics.slice(1), ...(l.data.slice(2).match(/.{64}/g) ?? []).map((w) => "0x" + w)];
      for (const w of words) {
        const p = zero.get("0x" + w.slice(-40).toLowerCase());
        if (!p || p.factory !== l.address.toLowerCase()) continue;
        const block = Number(l.blockNumber);
        const time = Number(l.blockTimestamp ?? 0) || Number((await rpc<{ timestamp: string }>("eth_getBlockByNumber", [l.blockNumber, false])).timestamp);
        out.push({ ...p, created_block: block, created_time: time, source: "event", version: (BigInt(block) + EVENT_VERSION).toString() });
        zero.delete(p.pool);
      }
    }
    if (!DRY) await insert("pools", out, `pool-created-backfill:${b}-${hi}`);
    found += out.length;
    console.log(JSON.stringify({ from: b, to: hi, logs: logs.length, found: out.length, left: zero.size, ms: Date.now() - t0, dry: DRY }));
  }
  console.log(`done: ${found} pools got a creation block, ${zero.size} still have none`);
}
await workload.run("bulk", main);
process.exit(0);
