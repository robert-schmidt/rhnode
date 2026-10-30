// Wallets someone asks about (explorer pages, API calls) get indexed: requested() collects them, and every few seconds
// the new ones are queued in ctl_wallet_index. src/promoter/wallets.ts decides whether to keep them and backfills.
import { insert, rows } from "./ch.ts";

const ADDR = /^0x[0-9a-f]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
let seen = new Set<string>(), pending = new Set<string>();

export function requested(...addrs: (string | null | undefined)[]): void {
  for (const x of addrs) {
    const a = x?.toLowerCase();
    if (!a || !ADDR.test(a) || a === ZERO || seen.has(a)) continue;
    if (seen.size > 100_000) seen = new Set(); // ponytail: forget all at 100K; re-asking costs one lookup each
    seen.add(a); pending.add(a);
  }
}

async function flush(): Promise<void> {
  if (!pending.size) return;
  const batch = [...pending]; pending = new Set();
  try {
    const known = new Set((await rows<{ wallet: string }>("SELECT wallet FROM ctl_wallet_index WHERE wallet IN {w:Array(String)}", { w: batch })).map((r) => r.wallet));
    const fresh = batch.filter((w) => !known.has(w));
    // version 0: a status the promoter wrote (version = now) always wins over a late duplicate of this row
    if (fresh.length) await insert("ctl_wallet_index", fresh.map((wallet) => ({ wallet, status: "queued", floor: 0, txs: 0, note: "", version: 0 })), `want:${fresh.join()}`);
  } catch (e) {
    for (const w of batch) pending.add(w); // retried on the next tick
    throw e;
  }
}

setInterval(() => flush().catch((e: Error) => {
  console.warn(`[watch] ${e.message}`);
}), 5_000).unref();

/** The wallet's index row: status "" when nobody asked yet. */
export async function indexState(w: string): Promise<{ status: string; floor: number }> {
  const [r] = await rows<{ status: string; floor: string }>("SELECT status, floor FROM ctl_wallet_index FINAL WHERE wallet = {w:String}", { w });
  return { status: r?.status ?? "", floor: Number(r?.floor ?? 0) };
}
