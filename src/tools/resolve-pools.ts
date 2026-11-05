// Resolves the v2/v3 pools that swapped in [from, to) (unix seconds) and have no resolved pools row: never looked up, or failed
// (ok = 0) before resolveV23 learnt a case (flap curves, 2026-11-05: 14,119 failed v2 pools, 8,120 of Oct 22–29's 8,121 flap's).
// Run it before hist-candles --missing and hist-trades, which price only resolved pools (hist-trades resolves only pools with no
// row at all). `node src/tools/resolve-pools.ts <from> <to>`; DRY=1 resolves and prints the counts, writes nothing.
import { cfg } from "../config.ts";
import { insert, rows, workload } from "../ch.ts";
import { upstream } from "../chain/upstream.ts";
import { resolveV23 } from "../projector/pools.ts";

const [from, to] = process.argv.slice(2).map(Number), DRY = process.env.DRY === "1";
if (!(from < to)) throw new Error("usage: resolve-pools.ts <from> <to> (unix seconds)");

async function main(): Promise<void> {
  const pv = (await rows<{ pool: string; vn: string }>(`SELECT pool, any(toString(venue)) AS vn FROM kept_swaps
    WHERE time >= toDateTime({from:UInt32}) AND time < toDateTime({to:UInt32}) AND venue IN ('v2', 'v3')
      AND pool NOT IN (SELECT pool FROM pools FINAL WHERE ok = 1) GROUP BY pool`, { from, to })).map((r) => ({ pool: r.pool, venue: r.vn }));
  const up = upstream(cfg.upstreamHttp);
  let ok = 0, verified = 0;
  for (let i = 0; i < pv.length; i += 1_000) {
    // ClickHouse's total cap (~5.6 GiB) kills the biggest query when the box is busy (twice on 2026-11-05): wait, retry
    let got: Awaited<ReturnType<typeof resolveV23>> | null = null;
    for (let k = 1; !got; k++) {
      try { got = await resolveV23(up, pv.slice(i, i + 1_000)); }
      catch (e) { if (k === 5 || (e as { code?: string }).code !== "241") throw e; console.error(`memory cap at ${i}, retry ${k} in 30 s`); await new Promise((r) => setTimeout(r, 30_000)); }
    }
    ok += got.filter((r) => r.ok).length;
    verified += got.filter((r) => r.verified).length;
    if (!DRY) await insert("pools", got, `resolve-pools:${from}-${to}:${i}:${Date.now()}`);
    console.log(JSON.stringify({ at: new Date().toISOString(), done: Math.min(i + 1_000, pv.length), of: pv.length, ok, verified }));
  }
}

await workload.run("bulk", main);
process.exit(0); // the clients' sockets would keep a one-off running
