// Indexes the wallets src/watch.ts queued (migration 014). A wallet is kept unless it's too busy (a router or a bot:
// more than WALLET_MAX_TXS_DAY txs a day over raw_txs). Kept means: watched from now on (ctl_watchlists 'requested',
// so ingest keeps its txs, logs and trades forever), and its txs still in raw_txs copied into kept_txs (its trades into
// kept_trades), so kept_txs holds every tx from/to/created by it from `floor` (the oldest raw block) on.
// (A sign -1 trade with keep 0 is a duplicate's correction, src/tools/dedupe-trades.ts: it never reaches kept_trades.)
// Its ERC-20 transfers need nothing: kept_transfers holds all of them. Logs and receipts of older txs come from the node.
// ponytail: history below the oldest raw block needs full blocks from our node; add that scan once Nitro is synced.
import { ch, command, rows, workload } from "../ch.ts";
import { KEEP } from "../ingest/keep.ts";

const MAX_DAY = Number(process.env.WALLET_MAX_TXS_DAY ?? 10_000); // ~420 B a kept tx: ≤4 MB a day each (2026-10-30)
const RELOAD_MS = 20_000; // ingest reloads the watchlists every 15 s (src/ingest/keep.ts)
const BATCH = 100;
const TOUCH = "(`from` = {w:String} OR `to` = {w:String} OR created = {w:String})";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type State = { wallet: string; status: string; floor: number; txs: number; note: string };
const save = async (s: State[]) => void (s.length && await ch.insert({ table: "ctl_wallet_index", values: s.map((x) => ({ ...x, version: Date.now() })), format: "JSONEachRow" }));

/** Index a batch: decide each, watch the kept ones, wait for ingest to pick them up, then backfill from raw. */
export async function indexWallets(ws: string[]): Promise<State[]> {
  const [s] = await rows<{ lo: string; days: number }>("SELECT min(number) AS lo, greatest(1, (max(time) - min(time)) / 86400) AS days FROM raw_blocks");
  const out: State[] = [];
  for (const wallet of ws) {
    // idx_wallet_txs (migration 015) is keyed by wallet; the same count over raw_txs scanned all of it, 48M rows / 13 s
    // per wallet under load (2026-11-06 14:38), and every explorer page queues its address here. ponytail: rows not yet
    // merged away can count twice; it only decides "busy".
    const [c] = await rows<{ n: string }>("SELECT count() AS n FROM idx_wallet_txs WHERE wallet = {w:String} AND block >= {lo:UInt64}", { w: wallet, lo: s.lo });
    const txs = Number(c.n), perDay = Math.round(txs / s.days);
    out.push(perDay > MAX_DAY
      ? { wallet, status: "busy", floor: 0, txs, note: `${perDay} txs a day (the cap is ${MAX_DAY})` }
      : { wallet, status: "indexed", floor: Number(s.lo), txs, note: "" });
  }
  const keep = out.filter((x) => x.status === "indexed");
  if (keep.length) {
    await ch.insert({ table: "ctl_watchlists", values: keep.map((x) => ({ list: "requested", kind: "wallet", value: x.wallet, keep_bits: KEEP.WATCH_WALLET, version: Date.now() })), format: "JSONEachRow" });
    await sleep(RELOAD_MS); // from here on ingest keeps them; the copy below covers everything older (kept_* dedupes the overlap)
    for (const x of keep) {
      const w = x.wallet;
      // A busy wallet's txs touch most of raw_txs' granules: the copy reads ~50M rows (~100 s under load, 2026-11-12). At the
      // default client's 60 s it timed out, the batch's states were never saved, and the whole batch was copied again
      // (one wallet 13 times in an hour). Now the slow lane (600 s) and each wallet's state saved as soon as it's copied.
      await command(`INSERT INTO kept_txs SELECT * REPLACE (bitOr(keep, ${KEEP.WATCH_WALLET}) AS keep) FROM raw_txs WHERE ${TOUCH}`, { w });
      await command(`INSERT INTO kept_trades SELECT * REPLACE (bitOr(keep, ${KEEP.WATCH_WALLET}) AS keep) FROM ev_trades WHERE wallet = {w:String} AND NOT (sign = -1 AND keep = 0)`, { w });
      await save([x]);
    }
  }
  await save(out.filter((x) => x.status !== "indexed"));
  return out;
}

export function walletWorker(): Promise<never> {
  return workload.run("bulk/slow", walletLoop);
}
async function walletLoop(): Promise<never> {
  for (;;) {
    try {
      const q = await rows<{ wallet: string }>(`SELECT wallet FROM ctl_wallet_index FINAL WHERE status = 'queued' ORDER BY requested_at LIMIT ${BATCH}`);
      if (!q.length) { await sleep(2_000); continue; }
      for (const r of await indexWallets(q.map((x) => x.wallet))) console.log(JSON.stringify({ at: new Date().toISOString(), ...r }));
    } catch (e) {
      console.warn(`[wallets] ${(e as Error).message}`);
      await sleep(10_000);
    }
  }
}
