// The backward walk (CLAUDE.md, 2026-10-30): from go-live down to genesis on our own node, every ERC-20 Transfer goes
// into kept_transfers and every holder's sum into agg_balances, newest blocks first. ctl_cursors 'walk' is the floor:
// all ERC-20 history at or above it is held (above go-live by migration 009), so the API answers exactly from there
// (`exactFrom`). At 0, every wallet and token is exact.
// Chunks sit on a fixed 10,000-block grid, so a retried chunk writes the same rows under the same dedup tokens (and
// agg_balances, which sums, can't count one twice). Tokens that token promotion already backfilled are left out: their
// history before go-live is in both tables already. Token promotion doesn't run while the walk does (src/promoter/main.ts).
// It only runs while our node is synced and ingest keeps up, and rests in proportion to its work (WALK_DUTY):
// the tip and the live stream come first.
import { ch, insert, rows } from "../ch.ts";
import { upstream, type Client } from "../chain/upstream.ts";
import { nitro, nitroSynced, watchNitro } from "../chain/nitro.ts";
import { KEEP } from "../ingest/keep.ts";
import { TRANSFER, topicAddr, word0 } from "../ingest/decode.ts";
import { projectTokens } from "../projector/main.ts";

const STEP = 10_000;
const DUTY = Number(process.env.WALK_DUTY ?? 0.5);
const MAX_LAG = 50; // blocks ingest may trail our node before the walk waits
const INSERT_ROWS = 50_000;
const PROJECT_EVERY = 1_000_000; // blocks walked between re-projections of the tokens it touched
type Log = { blockNumber: string; transactionIndex: string; logIndex: string; transactionHash: string; address: string; topics: string[]; data: string; blockTimestamp: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) => "0x" + n.toString(16);

export async function walkFloor(): Promise<number | null> {
  const [c] = await rows<{ block: string }>("SELECT block FROM ctl_cursors FINAL WHERE name = 'walk'");
  return c ? Number(c.block) : null;
}

/** The chunk's Transfer logs; a range the node refuses (too many results) is split. */
async function logs(src: Client, from: number, to: number): Promise<Log[]> {
  const r = await src.forward("eth_getLogs", [{ topics: [TRANSFER], fromBlock: hex(from), toBlock: hex(to) }]).catch((e: Error) => ({ error: { message: e.message } }));
  if (Array.isArray((r as { result?: unknown }).result)) return (r as { result: Log[] }).result;
  if (to - from < 100) throw new Error(`getLogs ${from}-${to}: ${(r as { error?: { message: string } }).error?.message ?? "no result"}`);
  const mid = Math.floor((from + to) / 2);
  return [...await logs(src, from, mid), ...await logs(src, mid + 1, to)];
}

async function idle(): Promise<boolean> {
  if (!nitroSynced() || nitro.head == null) return false;
  const [t] = await rows<{ block: string }>("SELECT block FROM ctl_cursors FINAL WHERE name = 'tip'");
  return nitro.head - Number(t?.block ?? 0) <= MAX_LAG;
}

export async function walk(up: Client, golive: number): Promise<void> {
  const node = process.env.NITRO_HTTP;
  if (!node) throw new Error("WALK=1 needs NITRO_HTTP (our own node)");
  watchNitro(node);
  const src = upstream([{ url: node, rps: 20 }], { attempts: 3, timeoutMs: 120_000 });
  let floor = (await walkFloor()) ?? golive;
  console.log(`[walk] floor ${floor}, ${STEP} blocks a chunk, duty ${DUTY}`);
  const dirty = new Set<string>();
  let projectedAt = floor;
  while (floor > 0) {
    if (!(await idle())) { await sleep(10_000); continue; }
    const t0 = Date.now();
    const hi = floor - 1, lo = hi - (hi % STEP);
    const done = new Set((await rows<{ token: string }>(
      "SELECT token FROM ctl_promotions FINAL WHERE status IN ('backfilled', 'done', 'incomplete')")).map((r) => r.token));
    const erc20 = (await logs(src, lo, hi)).filter((l) => l.topics.length === 3 && !done.has(l.address.toLowerCase()));
    const out = erc20.map((l) => ({
      block: Number(l.blockNumber), tx_index: Number(l.transactionIndex), log_index: Number(l.logIndex), batch_index: 0,
      tx_hash: l.transactionHash.toLowerCase(), time: Number(l.blockTimestamp), token: l.address.toLowerCase(),
      from: topicAddr(l.topics[1].toLowerCase()), to: topicAddr(l.topics[2].toLowerCase()), amount: word0(l.data.toLowerCase()),
      token_id: "0", standard: "erc20", keep: KEEP.HISTORY, sign: 1,
    }));
    for (let i = 0; i < out.length; i += INSERT_ROWS) await insert("kept_transfers", out.slice(i, i + INSERT_ROWS), `walk:${lo}:${i}`);
    const bal = new Map<string, bigint>();
    for (const r of out) {
      let a = BigInt(r.amount);
      if (a >= 1n << 255n) a -= 1n << 256n; // toInt256 wraps the same way in mv_agg_balances (spam amounts only)
      bal.set(`${r.token}${r.from}`, (bal.get(`${r.token}${r.from}`) ?? 0n) - a);
      bal.set(`${r.token}${r.to}`, (bal.get(`${r.token}${r.to}`) ?? 0n) + a);
      dirty.add(r.token);
    }
    const sums = [...bal].filter(([, b]) => b !== 0n).map(([k, b]) => ({ token: k.slice(0, 42), holder: k.slice(42), balance: b.toString() }));
    for (let i = 0; i < sums.length; i += INSERT_ROWS) await insert("agg_balances", sums.slice(i, i + INSERT_ROWS), `walk:${lo}:agg:${i}`);
    await ch.insert({ table: "ctl_cursors", values: [{ name: "walk", block: lo, hash: "", version: Date.now() }], format: "JSONEachRow" });
    floor = lo;
    if (projectedAt - floor >= PROJECT_EVERY || floor === 0) {
      const [tip] = await rows<{ block: string }>("SELECT block FROM ctl_cursors FINAL WHERE name = 'tip'");
      await projectTokens(up, [...dirty], Number(tip.block), `walk:${floor}`);
      dirty.clear();
      projectedAt = floor;
    }
    const ms = Date.now() - t0;
    console.log(JSON.stringify({ at: new Date().toISOString(), walk: lo, transfers: out.length, holders: sums.length, ms }));
    await sleep(ms * (1 / DUTY - 1));
  }
  console.log("[walk] reached genesis: every ERC-20 transfer is held");
}
