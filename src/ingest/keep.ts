// The keep-rules engine (ARCHITECTURE §3.1). A snapshot of what we care about, as plain maps,
// so decode stays pure. Granularity is the transaction: a tx touching anything watched is kept
// whole (all its logs and events), so kept_* never holds half a trade.
import { rows } from "../ch.ts";
import { LP_LOCKERS, RELAY_CONTRACTS } from "../chain/constants.ts";
import { tokenSideOf } from "../chain/registry.ts";

export const KEEP = {
  WATCH_WALLET: 1, WATCH_TOKEN: 2, LAUNCH: 4, TRACKED_POOL: 8, RELAY: 16, LOCKS: 32, PINNED: 64, OWN: 128, UNRECOVERABLE: 256,
} as const;

const PINKLOCK = "0xbe0b139abc90723af76a89d3051f60ba1b64c8d9";
// ponytail: Pons per-token fee vaults (BeaconProxy, Merkle `Claimed`) are not matched yet; they need a bytecode check.
const STATIC: [string, number][] = [
  ...[...RELAY_CONTRACTS].map((a): [string, number] => [a, KEEP.RELAY]),
  ...[PINKLOCK, ...Object.keys(LP_LOCKERS)].map((a): [string, number] => [a, KEEP.LOCKS]),
];

export type KeepCtx = {
  /** address or v4 pool id → bits (watchlists + static contracts + pools of watched tokens) */
  watch: Map<string, number>;
  /** pinned tx hash → bits */
  txs: Map<string, number>;
  /** pinned block ranges */
  ranges: { from: number; to: number; bits: number }[];
  /** token, or a pool of it → its launch time (unix s): the token's first `windowSec` are LAUNCH */
  recent: Map<string, number>;
  windowSec: number;
};

export function emptyCtx(windowSec = 86_400): KeepCtx {
  return { watch: new Map(STATIC), txs: new Map(), ranges: [], recent: new Map(), windowSec };
}

const or = (m: Map<string, number>, k: string, bits: number) => m.set(k, (m.get(k) ?? 0) | bits);

/** Fold one block's new launches and pools into the context, before the next block is decoded. */
export function learn(ctx: KeepCtx, out: { ev_launches: Launch[]; ev_pools: Pool[] }): void {
  for (const l of out.ev_launches) {
    if (l.kind !== "launch") continue;
    if (!ctx.recent.has(l.token)) ctx.recent.set(l.token, l.time);
    const d = JSON.parse(l.detail) as { pool?: string; poolId?: string };
    for (const p of [d.pool, d.poolId]) if (p) ctx.recent.set(p.toLowerCase(), ctx.recent.get(l.token)!);
  }
  for (const p of out.ev_pools) {
    const side = tokenSideOf(p.token0, p.token1);
    if (!side) continue;
    // ponytail: a token we haven't seen launch is treated as new at its first pool we see (a
    // 'dex-pool' catch-all). Wrong for a new pool of an old token until pools are backfilled from genesis.
    if (!ctx.recent.has(side.token)) ctx.recent.set(side.token, p.time);
    ctx.recent.set(p.pool, ctx.recent.get(side.token)!);
    const tokenBits = ctx.watch.get(side.token) ?? 0;
    if (tokenBits & KEEP.WATCH_TOKEN) or(ctx.watch, p.pool, KEEP.TRACKED_POOL);
  }
}
type Launch = { kind: string; token: string; time: number; detail: string };
type Pool = { pool: string; token0: string; token1: string; time: number };

/** Rebuild the context from ClickHouse: watchlists, the launch window, pools of watched tokens. */
export async function loadCtx(windowSec: number): Promise<KeepCtx> {
  const ctx = emptyCtx(windowSec);
  const wl = await rows<{ kind: string; value: string; bits: number }>(
    "SELECT kind, lower(value) AS value, groupBitOr(keep_bits) AS bits FROM ctl_watchlists FINAL WHERE removed = 0 GROUP BY kind, value",
  );
  for (const w of wl) {
    if (w.kind === "tx") or(ctx.txs, w.value, w.bits);
    else if (w.kind === "block_range") {
      const [from, to] = w.value.split("-").map(Number);
      ctx.ranges.push({ from, to, bits: w.bits });
    } else or(ctx.watch, w.value, w.bits);
  }
  const since = `now() - INTERVAL ${Math.ceil(windowSec)} SECOND`;
  const launches = await rows<Launch>(
    `SELECT kind, token, toUnixTimestamp(time) AS time, detail FROM kept_launches FINAL WHERE kind = 'launch' AND time > ${since} ORDER BY block`,
  );
  // Pools of watched tokens come from all of kept_pools (pool creations are always kept).
  const watchedTokens = wl.filter((w) => w.kind === "token" && w.bits & KEEP.WATCH_TOKEN).map((w) => w.value);
  const pools = await rows<Pool>(
    `SELECT pool, token0, token1, toUnixTimestamp(time) AS time FROM kept_pools FINAL
     WHERE time > ${since} OR token0 IN {t:Array(String)} OR token1 IN {t:Array(String)} ORDER BY block`,
    { t: watchedTokens },
  );
  learn(ctx, { ev_launches: launches, ev_pools: pools.filter((p) => p.time > Date.now() / 1000 - windowSec) });
  for (const p of pools) {
    const side = tokenSideOf(p.token0, p.token1);
    if (side && (ctx.watch.get(side.token) ?? 0) & KEEP.WATCH_TOKEN) or(ctx.watch, p.pool, KEEP.TRACKED_POOL);
  }
  return ctx;
}
