// Indexes the wallets src/watch.ts queued (migration 014). A wallet is kept unless it's too busy (a router or a bot:
// more than WALLET_MAX_TXS_DAY txs a day over raw_txs). Kept means: watched from now on (ctl_watchlists 'requested',
// so ingest keeps its txs, logs and trades forever), and its txs still in raw_txs copied into kept_txs (its trades into
// kept_trades), so kept_txs holds every tx from/to/created by it from `floor` (the oldest raw block) on.
// Its ERC-20 transfers need nothing: kept_transfers holds all of them. Logs and receipts of older txs come from the node.
// ponytail: history below the oldest raw block needs full blocks from our node; add that scan once Nitro is synced.
import { ch, rows } from "../ch.ts";
import { KEEP } from "../ingest/keep.ts";

const MAX_DAY = Number(process.env.WALLET_MAX_TXS_DAY ?? 10_000); // ~420 B a kept tx: ≤4 MB a day each (2026-10-30)
const RELOAD_MS = 20_000; // ingest reloads the watchlists every 15 s (src/ingest/keep.ts)
const BATCH = 100;
const TOUCH = "(`from` = {w:String} OR `to` = {w:String} OR created = {w:String})";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type State = { wallet: string; status: string; floor: number; txs: number; note: string };
const save = (s: State[]) => ch.insert({ table: "ctl_wallet_index", values: s.map((x) => ({ ...x, version: Date.now() })), format: "JSONEachRow" });

/** Index a batch: decide each, watch the kept ones, wait for ingest to pick them up, then backfill from raw. */
export async function indexWallets(ws: string[]): Promise<State[]> {
  const [s] = await rows<{ lo: string; days: number }>("SELECT min(number) AS lo, greatest(1, (max(time) - min(time)) / 86400) AS days FROM raw_blocks");
  const out: State[] = [];
  for (const wallet of ws) {
    const [c] = await rows<{ n: string }>(`SELECT count() AS n FROM raw_txs WHERE sign = 1 AND ${TOUCH}`, { w: wallet });
    const txs = Number(c.n), perDay = Math.round(txs / s.days);
    out.push(perDay > MAX_DAY
      ? { wallet, status: "busy", floor: 0, txs, note: `${perDay} txs a day (the cap is ${MAX_DAY})` }
      : { wallet, status: "indexed", floor: Number(s.lo), txs, note: "" });
  }
  const keep = out.filter((x) => x.status === "indexed");
  if (keep.length) {
    await ch.insert({ table: "ctl_watchlists", values: keep.map((x) => ({ list: "requested", kind: "wallet", value: x.wallet, keep_bits: KEEP.WATCH_WALLET, version: Date.now() })), format: "JSONEachRow" });
    await sleep(RELOAD_MS); // from here on ingest keeps them; the copy below covers everything older (kept_* dedupes the overlap)
    for (const { wallet } of keep) {
      await ch.command({ query: `INSERT INTO kept_txs SELECT * REPLACE (bitOr(keep, ${KEEP.WATCH_WALLET}) AS keep) FROM raw_txs WHERE ${TOUCH}`, query_params: { w: wallet } });
      await ch.command({ query: `INSERT INTO kept_trades SELECT * REPLACE (bitOr(keep, ${KEEP.WATCH_WALLET}) AS keep) FROM ev_trades WHERE wallet = {w:String}`, query_params: { w: wallet } });
    }
  }
  await save(out);
  return out;
}

export async function walletWorker(): Promise<never> {
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
