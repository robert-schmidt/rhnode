// Launchpad discovery from the chain itself (migration 024). The promoter's worker enriches what the views collect:
// - creations: code_hash (keccak of the code now; '' once it is gone) and implementation, the EIP-1967 implementation
//   slot's address, else the EIP-1967 beacon's implementation();
// - token_origin: the first mint's tx_from and tx_to (from the node's permanent tx and receipt), and its minter, the
//   contract that made the token: the first contract in the mint tx's receipt, other than the token and DEX
//   infrastructure, whose log names the token (a
//   launchpad's launch event does; a router that only forwards does not: 'event'), else its creator when tip traces saw
//   the creation ('trace'); a token deployed by the tx itself has none ('deploy'). tx_to stays what the signer called, so
//   a router in front of a launchpad shows as such.
// - token_markets, per token a launchpad made: its curve, the biggest holder once the mint tx is done if it holds at
//   least half the mint, is a contract and not one of the token's pools, and is on one side of ≥40% of the early tape's
//   txs (early.ts deduceMarkets); its graduation, the tx after which the curve holds under 1% of its peak and in which
//   the token reaches one of its pools (v2/v3/OMM: the pool; v4: the PoolManager, the pool being the token's v4 pool
//   created in that block, a launchpad hook's first). A token without a curve a day after its mint, or graduated, is final;
//   others are looked at again hourly (daily after a week).
// - curve_payouts (migration 025): native ETH out of a curve from tip traces, LAG blocks behind them (a new token's
//   curve is found within the hour of its first trades, so its payouts are scanned after it is known); ERC-20 quotes
//   out of a curve from kept_transfers, block range by range at the same lag, and all of a curve's rows by address when
//   it is found later (an old token, once the history pass reaches its mint): only rows not stored yet, or stored
//   without a USD value that has one now (pre-go-live prices come later), so a rerun writes nothing.
// Throttled (DISCOVERY_PAR calls at a time, a pause between batches) so it never slows the history pass or the API: it
// rests DISCOVERY_REST times as long as a round took (each token read touches a granule in every kept_transfers
// part, ~260K rows whatever its size: measured 2026-10-31, unthrottled it cut the pass from ~800 to ~250 inserts per 5 min).
import { keccak256 } from "viem";
import { createClient } from "@clickhouse/client";
import { ch, insert, rows, workload } from "./ch.ts";
import { cfg } from "./config.ts";
import { PROTOCOL } from "./chain/protocol.ts";
import { BURN_SINKS, METRIC_OMM_FACTORY, NATIVE_ETH, UNIV2_FACTORY, UNIV3_FACTORY, UNIV4_POOL_MANAGER, USDG, WETH } from "./chain/constants.ts";
import { HOOK_SOURCES } from "./chain/registry.ts";
import { deduceMarkets, type Tf } from "./early.ts";
import type { Up } from "./cards.ts";

const PAR = Number(process.env.DISCOVERY_PAR ?? 8);
const REST = Number(process.env.DISCOVERY_REST ?? 4);
const ORIGINS_BATCH = Number(process.env.DISCOVERY_ORIGINS_BATCH ?? 1000);
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"; // EIP-1967 implementation
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50"; // EIP-1967 beacon
const IMPLEMENTATION = "0x5c60da1b"; // implementation()
const NOT_MINTERS = new Set(["quote", "router", "pool_manager", "infra", "relay", "hook", "locker", "burn"]);

type Log = { address: string; topics: string[]; data: string };

/** PURE. The contract that made `token`, from its mint tx's logs: the first emitter (not the token, not `infra`) whose
 *  log names the token in a topic or its data; null when none does. */
// Built in this tx (OwnershipTransferred from 0x0, or Initialized): a per-token helper, never the launchpad (Flap's
// Portal makes two per token, and they name the token before it does).
const OWNED = "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0";
const INITIALIZED = new Set(["0x7f26b83ff96e1f2b6a682f133852f6798a09c465da95921460cefb3847402498", "0xc7f505b2f371ae2175ee4913f4499e1f2633a7b5936321eed1cdaeb6115181d2"]);
export function minterOf(token: string, logs: Log[], infra: Set<string>): string | null {
  const t = token.slice(2).toLowerCase();
  const born = new Set(logs.filter((l) => INITIALIZED.has(l.topics[0]) || (l.topics[0] === OWNED && /^0x0{64}$/.test(l.topics[1] ?? "")))
    .map((l) => l.address.toLowerCase()));
  for (const l of logs) {
    const a = l.address.toLowerCase();
    if (a === token || infra.has(a) || born.has(a)) continue;
    if (l.topics.slice(1).some((x) => x.toLowerCase().endsWith(t)) || l.data.toLowerCase().includes(t)) return a;
  }
  return null;
}

export type Tr = { block: number; log_index: number; tx_hash: string; from: string; to: string; amount: bigint };
export type PoolRow = { pool: string; venue: string; created_block: number; hooks: string };
const ZERO = BURN_SINKS[1], BURN = new Set(BURN_SINKS);

/** PURE. The token's curve (see the top), given its first transfers in order, the mint tx and its pools; null when none. */
export function curveOf(mintTx: string, tape: Tr[], pools: Set<string>): string | null {
  const bal = new Map<string, bigint>();
  let minted = 0n;
  for (const t of tape) {
    if (t.tx_hash !== mintTx) continue;
    if (t.from === ZERO) minted += t.amount; else bal.set(t.from, (bal.get(t.from) ?? 0n) - t.amount);
    bal.set(t.to, (bal.get(t.to) ?? 0n) + t.amount);
  }
  const [h, b] = [...bal].filter(([a]) => !BURN.has(a)).sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0))[0] ?? [];
  if (!h || b! * 2n < minted || pools.has(h) || h === UNIV4_POOL_MANAGER) return null;
  return deduceMarkets(tape.filter((t) => t.tx_hash !== mintTx) as unknown as Tf[], new Set()).has(h) ? h : null;
}

/** PURE. The curve's transfer of the token (in order: `flows`) whose tx leaves it under 1% of its peak; null while it holds more. */
export function emptiedAt(curve: string, flows: Tr[]): Tr | null {
  let bal = 0n, peak = 0n;
  for (let i = 0; i < flows.length; i++) {
    const t = flows[i];
    bal += t.to === curve ? t.amount : -t.amount;
    if (bal > peak) peak = bal;
    if (peak > 0n && flows[i + 1]?.tx_hash !== t.tx_hash && t.from === curve && bal * 100n < peak) return t;
  }
  return null;
}

export type Graduation = { block: number; tx: string; pool: string; venue: string };
/** PURE. The curve's graduation (see the top): `flows` are the curve's transfers of the token in order, `txs` every
 *  transfer of the token in the tx that empties it, `pools` the token's pools. null when it hasn't graduated (or was
 *  emptied without reaching a pool). */
export function graduationOf(curve: string, flows: Tr[], txs: Map<string, Tr[]>, pools: PoolRow[]): Graduation | null {
  const t = emptiedAt(curve, flows);
  if (!t) return null;
  const to = new Set((txs.get(t.tx_hash) ?? []).map((x) => x.to));
  const direct = pools.find((p) => p.venue !== "v4" && to.has(p.pool));
  if (direct) return { block: t.block, tx: t.tx_hash, pool: direct.pool, venue: direct.venue };
  if (!to.has(UNIV4_POOL_MANAGER)) return null;
  // the token's v4 pool created in this block first, a launchpad hook's first, else the newest before it
  const v4 = pools.filter((p) => p.venue === "v4" && p.created_block <= t.block).sort((a, b) =>
    Number(b.created_block === t.block) - Number(a.created_block === t.block) || Number(!!HOOK_SOURCES[b.hooks]) - Number(!!HOOK_SOURCES[a.hooks])
    || b.created_block - a.created_block);
  return v4[0] ? { block: t.block, tx: t.tx_hash, pool: v4[0].pool, venue: "v4" } : null;
}

const addrOf = (w: string | null | undefined) => (w && w.length >= 42 && !/^0x0*$/.test(w) ? "0x" + w.slice(-40).toLowerCase() : "");
const pool = async <T>(xs: T[], f: (x: T) => Promise<void>) => {
  for (let i = 0; i < xs.length; i += PAR) await Promise.all(xs.slice(i, i + PAR).map(f));
};

async function creations(up: Up): Promise<number> {
  const due = await rows<Record<string, unknown> & { created: string; v: string }>(
    "SELECT created, creator, type, block, tx_hash, time, toString(version) AS v FROM creations FINAL WHERE checked = 0 ORDER BY block DESC LIMIT 400");
  const out: Record<string, unknown>[] = [];
  await pool(due, async (c) => {
    const code = await up.call<string>("eth_getCode", [c.created, "latest"]);
    let impl = addrOf(await up.call<string>("eth_getStorageAt", [c.created, IMPL_SLOT, "latest"]));
    if (!impl) {
      const beacon = addrOf(await up.call<string>("eth_getStorageAt", [c.created, BEACON_SLOT, "latest"]));
      if (beacon) impl = addrOf(await up.call<string>("eth_call", [{ to: beacon, data: IMPLEMENTATION }, "latest"]).catch(() => ""));
    }
    const { v, ...row } = c;
    out.push({ ...row, code_hash: code && code !== "0x" ? keccak256(code as `0x${string}`) : "", implementation: impl, checked: 1, version: String(BigInt(v) + 1n) });
  });
  await insert("creations", out, `creations:${due[0]?.created}:${due.at(-1)?.created}:${out.length}`);
  return out.length;
}

let infra: { at: number; set: Set<string> } = { at: 0, set: new Set() };
async function infraSet(): Promise<Set<string>> {
  if (Date.now() - infra.at < 3_600_000) return infra.set;
  const fs = await rows<{ f: string }>("SELECT DISTINCT factory AS f FROM pools FINAL WHERE length(factory) = 42");
  infra = { at: Date.now(), set: new Set([...[...PROTOCOL.values()].filter((e) => NOT_MINTERS.has(e.kind)).map((e) => e.address),
    UNIV2_FACTORY, UNIV3_FACTORY, METRIC_OMM_FACTORY, ...fs.map((r) => r.f)]) };
  return infra.set;
}

async function origins(up: Up, n: number): Promise<number> {
  // Candidates without FINAL first (PREWHERE reads only `checked`), then FINAL by those keys: FINAL over the whole table
  // to find the few unchecked tokens read 5.6M rows / 3.3 s every round (2026-11-06 16:50). Unmerged checked=0 versions
  // of tokens already checked are candidates too until a merge drops them; FINAL sorts them out.
  const cands = (await rows<{ token: string }>(
    "SELECT token FROM token_origin PREWHERE checked = 0 GROUP BY token ORDER BY max(block) DESC LIMIT {n:UInt32}", { n: Math.min(n, 500) })).map((r) => r.token); // ≤500: parameters travel in the URL
  if (!cands.length) return 0;
  const due = await rows<Record<string, unknown> & { token: string; tx_hash: string; v: string }>(
    `SELECT token, block, tx_index, log_index, tx_hash, time, mint_recipient, toString(amount) AS amt, toString(version) AS v
     FROM token_origin FINAL PREWHERE token IN {c:Array(String)} WHERE checked = 0 ORDER BY block DESC LIMIT {n:UInt32}`, { c: cands, n });
  if (!due.length) return 0;
  const traced = new Map((await rows<{ created: string; creator: string }>(
    "SELECT created, creator FROM creations FINAL WHERE created IN {t:Array(String)}", { t: due.map((d) => d.token) })).map((r) => [r.created, r.creator]));
  const skip = await infraSet(), out: Record<string, unknown>[] = [];
  await pool(due, async (d) => {
    const [tx, rc] = await Promise.all([up.call<{ from: string; to: string | null } | null>("eth_getTransactionByHash", [d.tx_hash]),
      up.call<{ logs: Log[] } | null>("eth_getTransactionReceipt", [d.tx_hash])]);
    if (!tx || !rc) return; // not on our node yet: next round
    // the launch event's emitter first: a launchpad's tokens may be created by a helper it calls (Pons v2's 0x3711…)
    const ev = tx.to == null ? null : minterOf(d.token, rc.logs, skip), by = traced.get(d.token);
    const { v, amt, ...row } = d;
    out.push({ ...row, amount: amt, tx_from: tx.from.toLowerCase(), tx_to: (tx.to ?? "").toLowerCase(), checked: 1, version: String(BigInt(v) + 1n),
      ...(tx.to == null ? { minter: "", minter_source: "deploy" } : ev ? { minter: ev, minter_source: "event" } : by ? { minter: by, minter_source: "trace" }
        : { minter: "", minter_source: "" }) });
  });
  await insert("token_origin", out, `origins:${due[0].token}:${due.at(-1)!.token}:${out.length}:${due[0].v}`);
  return out.length;
}

const DAY = 830_000, WEEK = 7 * DAY; // blocks (~104 ms)
type Row = { token: string; block: string; log_index: number; tx_hash: string; from: string; to: string; amt: string };
const tr = (r: Row): Tr => ({ block: Number(r.block), log_index: r.log_index, tx_hash: r.tx_hash, from: r.from, to: r.to, amount: BigInt(r.amt) });
const byToken = (rs: Row[]) => { const m = new Map<string, Tr[]>(); for (const r of rs) (m.get(r.token) ?? m.set(r.token, []).get(r.token)!).push(tr(r)); return m; };
const TF = "SELECT token, block, log_index, tx_hash, `from`, `to`, toString(amount) AS amt FROM kept_transfers FINAL";
// FINAL per monthly partition (a row and its copies share a block, so a month) on 2 threads: a 100-token tape took 806 MB
// and 1.6 s, this 160 MB and 3.2 s (measured 2026-10-31); at 3.4 GB one hit ClickHouse's cap beside the history pass.
const LEAN = " SETTINGS do_not_merge_across_partitions_select_final = 1, max_threads = 2";

async function markets(up: Up): Promise<number> {
  const [tip] = await rows<{ b: string }>("SELECT max(block) AS b FROM ctl_cursors FINAL WHERE name = 'tip'");
  const due = await rows<{ token: string; block: string; tx_hash: string; minter: string; ts: number }>(
    `SELECT o.token AS token, o.block AS block, o.tx_hash AS tx_hash, o.minter AS minter, toUnixTimestamp(o.time) AS ts FROM token_origin AS o FINAL
     LEFT JOIN (SELECT token, final, version FROM token_markets FINAL) AS m ON m.token = o.token
     WHERE o.checked = 1 AND o.minter != '' AND (m.version = 0 OR (m.final = 0
       AND m.version < {now:UInt64} - if(o.block + {week:UInt64} > {tip:UInt64}, 3600000, 86400000)))
     ORDER BY o.block DESC LIMIT 100`, { now: Date.now(), week: WEEK, tip: Number(tip.b) });
  if (!due.length) return 0;
  const t = due.map((d) => d.token), t0 = Math.min(...due.map((d) => Number(d.ts))) - 86_400; // a day early: a token may move before its first Transfer from 0
  // no transfer before its mint: the bound prunes older months. 100 young tokens' tapes: 54M rows, 381 MiB, 32 s without
  // it, 0.7M rows, 35 MiB, 0.5 s with it (kept_transfers from genesis since the history pass, 2026-11-05)
  const SINCE = " AND time >= toDateTime({t0:UInt32})";
  const [tape, pr, lps] = await Promise.all([
    rows<Row>(`${TF} WHERE token IN {t:Array(String)} AND sign = 1${SINCE} ORDER BY token, block, log_index LIMIT 500 BY token${LEAN}`, { t, t0 }),
    rows<{ pool: string; vn: string; cb: string; hooks: string; token0: string; token1: string }>(
      // the tokens' pools found unmerged first, then FINAL by key, the key filter in PREWHERE so it runs before the merge (pools
      // has ~314 granules: any 1,000 keys touch nearly all; WHERE merged all 2.5M rows first: 249 MiB vs 42, 2026-11-05)
      `SELECT pool, toString(venue) AS vn, created_block AS cb, hooks, token0, token1 FROM pools FINAL
       PREWHERE pool IN (SELECT pool FROM pools WHERE token0 IN {t:Array(String)} OR token1 IN {t:Array(String)}) WHERE ok = 1`, { t }),
    rows<{ pool: string }>("SELECT pool FROM pools WHERE pool IN {t:Array(String)}", { t }),
  ]);
  const T = byToken(tape), P = new Map<string, PoolRow[]>(), lp = new Set(lps.map((r) => r.pool)), skip = await infraSet();
  // a curve is a pools row too (migration 022), but not a market a curve can graduate into
  for (const p of pr) if (p.vn !== "curve") for (const k of [p.token0, p.token1]) (P.get(k) ?? P.set(k, []).get(k)!).push({ pool: p.pool, venue: p.vn, created_block: Number(p.cb), hooks: p.hooks });
  const curve = new Map<string, string>();
  // an LP token (the token is a pool) or a token a DEX made is no launch: final with no curve
  await pool(due.filter((d) => !lp.has(d.token) && !skip.has(d.minter)), async (d) => {
    const c = curveOf(d.tx_hash, T.get(d.token) ?? [], new Set((P.get(d.token) ?? []).map((p) => p.pool)));
    if (!c) return;
    const code = await up.call<string>("eth_getCode", [c, "latest"]);
    if (code && code !== "0x" && !code.startsWith("0xef0100")) curve.set(d.token, c); // a wallet (or an EIP-7702 one) is no curve
  });
  const ct = [...curve.keys()], cs = [...new Set(curve.values())];
  const F = ct.length ? byToken((await rows<Row>(`${TF} WHERE token IN {t:Array(String)} AND (\`from\` IN {c:Array(String)} OR \`to\` IN {c:Array(String)}) AND sign = 1${SINCE}
    ORDER BY token, block, log_index LIMIT 100000 BY token${LEAN}`, { t: ct, c: cs, t0 })).filter((r) => r.from === curve.get(r.token) || r.to === curve.get(r.token))) : new Map();
  const empty = new Map(ct.map((k) => [k, emptiedAt(curve.get(k)!, F.get(k) ?? [])] as const).filter(([, e]) => e));
  const G = empty.size ? (await rows<Row>(`${TF} WHERE token IN {t:Array(String)} AND tx_hash IN {h:Array(String)} AND sign = 1${SINCE} ORDER BY block, log_index${LEAN}`,
    { t: [...empty.keys()], h: [...empty.values()].map((e) => e!.tx_hash), t0 })) : [];
  const out = due.map((d) => {
    const c = curve.get(d.token) ?? "", g = c ? graduationOf(c, F.get(d.token) ?? [], new Map([[empty.get(d.token)?.tx_hash ?? "", G.filter((r) => r.token === d.token).map(tr)]]), P.get(d.token) ?? []) : null;
    return { token: d.token, minter: d.minter, curve: c, grad_block: g?.block ?? 0, grad_tx: g?.tx ?? "", pool: g?.pool ?? "", venue: g?.venue ?? "",
      final: g || (!c && (lp.has(d.token) || skip.has(d.minter) || Number(d.block) + DAY < Number(tip.b))) ? 1 : 0, version: Date.now() };
  });
  await insert("token_markets", out, `markets:${t[0]}:${t.at(-1)}:${Date.now()}`);
  return out.length;
}

export const TRACE_START = 102_274_040; // raw_traces' first block, 2026-10-31 04:12 UTC
const LAG = 70_000, NATIVE_STEP = 50_000; // blocks: ~2 h, ~1.4 h
const CURVES = "(SELECT curve FROM token_markets FINAL WHERE curve != '')";
const OWN = "(SELECT token, curve FROM token_markets FINAL WHERE curve != '')";
// in this tx a token of the curve went into it (a sell)
const SELLS = (since: string) => `(SELECT tx_hash, \`to\` FROM kept_transfers WHERE token IN (SELECT token FROM token_markets FINAL WHERE curve != '')
  AND (token, \`to\`) IN ${OWN} ${since})`;
const EU = (since: string) => `(SELECT toStartOfHour(time) AS h, avg(eth_usd) AS eu FROM ev_prices WHERE eth_usd > 0 ${since} GROUP BY h)`;
const ANCHORS = `('${WETH}', '${NATIVE_ETH}', '${USDG}')`;
export const NATIVE_PAYOUTS = `INSERT INTO curve_payouts
  SELECT t.from AS c, t.block AS b, t.tx_index AS ti, t.idx AS ix, t.tx_hash AS th, t.time AS tm, 'eth' AS a, t.to AS r, t.value AS v,
    if(e.eu > 0, toFloat64(t.value) / 1e18 * e.eu, NULL) AS u, (t.tx_hash, t.from) IN ${SELLS("AND time >= {t0:DateTime}")} AS sl, 'trace' AS src
  FROM raw_traces AS t LEFT JOIN ${EU("AND time >= {t0:DateTime}")} AS e ON e.h = toStartOfHour(t.time)
  WHERE t.block > {lo:UInt64} AND t.block <= {hi:UInt64} AND t.value > 0 AND t.error = '' AND t.from IN ${CURVES}`;
// ERC-20 quotes out of the curves {c} in rows k (kept_transfers' shape): priced when the hour has a price, a row stored
// before without one is written again once it has one, so a rerun writes nothing.
export const ERC20_PAYOUTS = (k: string) => `INSERT INTO curve_payouts
  SELECT k.from AS c, k.block AS b, k.tx_index AS ti, k.log_index AS ix, k.tx_hash AS th, k.time AS tm, toString(k.token) AS a, toString(k.to) AS r, k.amount AS v,
    multiIf(k.token = '${USDG}', toFloat64(k.amount) / 1e6, k.token = '${WETH}' AND e.eu > 0, toFloat64(k.amount) / 1e18 * e.eu,
      p.pu > 0, toFloat64(k.amount) / pow(10, d.dc) * p.pu, NULL) AS u,
    (k.tx_hash, k.from) IN (SELECT tx_hash, \`to\` FROM kept_transfers WHERE token IN (SELECT token FROM token_markets FINAL WHERE curve IN {c:Array(String)})
      AND (token, \`to\`) IN ${OWN} AND block > {lo:UInt64} AND block <= {hi:UInt64} AND time >= {t0:DateTime}) AS sl, 'transfer' AS src
  FROM (${k}) AS k
  LEFT JOIN ${EU("AND time >= {t0:DateTime}")} AS e ON e.h = toStartOfHour(k.time)
  LEFT JOIN (SELECT token AS pt, toStartOfHour(time) AS h, avg(price_usd) AS pu FROM ev_prices WHERE token IN {q:Array(String)} AND quote IN ${ANCHORS}
    AND verified = 1 AND usd >= 100 AND time >= {t0:DateTime} GROUP BY pt, h) AS p ON p.pt = k.token AND p.h = toStartOfHour(k.time)
  LEFT JOIN (SELECT token AS dt, decimals AS dc FROM serve_tokens FINAL WHERE token IN {q:Array(String)}) AS d ON d.dt = k.token
  WHERE (k.token, k.from) NOT IN ${OWN}
    AND (k.from, k.block, k.tx_index, k.log_index) NOT IN (SELECT curve, block, tx_index, idx FROM curve_payouts
      WHERE source = 'transfer' AND usd IS NOT NULL AND curve IN {c:Array(String)} AND block > {lo:UInt64} AND block <= {hi:UInt64})
    AND (u IS NOT NULL OR (k.from, k.block, k.tx_index, k.log_index) NOT IN (SELECT curve, block, tx_index, idx FROM curve_payouts
      WHERE source = 'transfer' AND curve IN {c:Array(String)} AND block > {lo:UInt64} AND block <= {hi:UInt64}))`;
// new blocks: kept_transfers by token (the quotes) and block, so a step reads only its range
export const IN_RANGE = "SELECT * FROM kept_transfers WHERE sign = 1 AND `from` IN {c:Array(String)} AND token IN {q:Array(String)} AND block > {lo:UInt64} AND block <= {hi:UInt64} AND time >= {t0:DateTime}";
export const RANGE_CURVES = `SELECT DISTINCT toString(\`from\`) AS c FROM kept_transfers WHERE sign = 1 AND \`from\` IN ${CURVES} AND token IN {q:Array(String)}
  AND block > {lo:UInt64} AND block <= {hi:UInt64} AND time >= {t0:DateTime}`;
// a curve found after its blocks were read (an old token, once the history pass reaches its mint): all of its rows, by address
export const OF_CURVES = "SELECT * EXCEPT (wallet) FROM kept_transfers_by_wallet WHERE wallet IN {c:Array(String)} AND `from` = wallet AND sign = 1 AND token IN {q:Array(String)} AND time >= {t0:DateTime}";
const QUOTES = `SELECT DISTINCT toString(toFixedString(JSONExtractString(detail, 'pairToken'), 42)) AS q FROM kept_launches
  WHERE kind = 'launch' AND JSONExtractString(detail, 'pairToken') NOT IN ('', '${NATIVE_ETH}')`;
// Until 2026-11-05 the ERC-20 step was one hourly read of every quote transfer out of every curve: 1.56B rows, 316 s
// (query_log 02:24), and it starved Nitro at the 18 W power cap. Now each block range is read once, ERC20_STEP at a time
// (10K blocks: 2.8M rows, 1.3 s, 2026-11-05; the fixed cost is a granule per quote token and part, so not every round),
// and a newly found curve is read by address from the by-wallet copy.
const ERC20_STEP = 10_000, ERC20_MAX = 50_000, BATCH = 100, FAR = Number.MAX_SAFE_INTEGER;
let quotes = { at: 0, q: [] as string[] };
// a busy curve's whole history can outlast the shared client's 60 s; ClickHouse finishes an insert the client gave up on
const slow = createClient({ ...cfg.clickhouse, request_timeout: 600_000,
  clickhouse_settings: { send_progress_in_http_headers: 1, http_headers_progress_interval_ms: "10000" } }); // headers keep the socket alive
async function payouts(): Promise<number> {
  const [c] = await rows<{ p: string; t: string; e: string; m: string }>(`SELECT maxIf(block, name = 'payouts') AS p, maxIf(block, name = 'trace') AS t,
    maxIf(block, name = 'payouts_erc20') AS e, maxIf(block, name = 'payouts_markets') AS m FROM ctl_cursors FINAL WHERE name IN ('payouts', 'trace', 'payouts_erc20', 'payouts_markets')`);
  const t0 = async (b: number) => (await rows<{ t: string }>("SELECT toString(time - INTERVAL 1 HOUR) AS t FROM raw_blocks WHERE number = {b:UInt64}", { b }))[0]?.t ?? "2026-10-31 00:00:00";
  const lo = Math.max(Number(c.p), TRACE_START - 1), hi = Math.min(Number(c.t) - LAG, lo + NATIVE_STEP);
  let n = 0;
  if (hi > lo) {
    await ch.command({ query: NATIVE_PAYOUTS, query_params: { lo, hi, t0: await t0(lo + 1) }, clickhouse_settings: { workload: "bulk" } });
    await insert("ctl_cursors", [{ name: "payouts", block: hi, hash: "", version: Date.now() }], `payouts:${hi}`);
    n = hi - lo;
  }
  if (Date.now() - quotes.at > 3_600_000) quotes = { at: Date.now(), q: [WETH, USDG, ...(await rows<{ q: string }>(QUOTES)).map((r) => r.q)] };
  const q = quotes.q, elo = Number(c.e) || lo, ehi = Math.min(Number(c.t) - LAG, elo + ERC20_MAX); // the hourly scan covered all up to now
  if (ehi - elo >= ERC20_STEP) {
    const p = { q, lo: elo, hi: ehi, t0: await t0(elo + 1) };
    const cs = (await rows<{ c: string }>(RANGE_CURVES, p)).map((r) => r.c);
    if (cs.length) await ch.command({ query: ERC20_PAYOUTS(IN_RANGE), query_params: { ...p, c: cs }, clickhouse_settings: { workload: "bulk" } });
    await insert("ctl_cursors", [{ name: "payouts_erc20", block: ehi, hash: "", version: Date.now() }], `payouts_erc20:${ehi}`);
    n++;
  }
  const since = Number(c.m) || Date.now() - 7_200_000; // markets written before this were in the last hourly scan
  // from the batch's earliest mint (an hour early), so the reads skip older parts: an hour's 13 curves 1.9M rows, 0.8 s; 100 over a
  // week 41.5M, 15 s; the same 100 unbounded 81M, 67 s (2026-11-05)
  const fresh = await rows<{ c: string; v: string; t: string }>(`SELECT m.curve AS c, max(m.version) AS v, toString(greatest(min(o.time), toDateTime(3600)) - INTERVAL 1 HOUR) AS t
    FROM (SELECT token, curve, version FROM token_markets FINAL WHERE curve != '' AND version > {since:UInt64}) AS m
    LEFT JOIN (SELECT token, time FROM token_origin FINAL WHERE token IN (SELECT token FROM token_markets FINAL WHERE curve != '' AND version > {since:UInt64})) AS o
    ON o.token = m.token GROUP BY c ORDER BY v LIMIT ${BATCH} WITH TIES`, { since }); // only these tokens' origins: 133 MiB, not 629 (2026-11-05)
  if (fresh.length) {
    const floor = fresh.map((r) => r.t).sort()[0]; // no origin row is 1970 (all); ponytail: one floor per batch, the oldest token's; per-month batches if mixed ages cost too much
    await slow.command({ query: ERC20_PAYOUTS(OF_CURVES), query_params: { q, c: fresh.map((r) => r.c), lo: 0, hi: FAR, t0: floor }, clickhouse_settings: { workload: "bulk" } });
    const v = Math.max(...fresh.map((r) => Number(r.v)));
    await insert("ctl_cursors", [{ name: "payouts_markets", block: v, hash: "", version: Date.now() }], `payouts_markets:${v}`);
    n++;
  } else if (!Number(c.m)) await insert("ctl_cursors", [{ name: "payouts_markets", block: since, hash: "", version: Date.now() }], `payouts_markets:${since}`);
  return n;
}

export async function discoveryWorker(up: Up): Promise<never> {
  return workload.run("bulk/slow", () => Promise.race([discoveryLoop(up), originsLoop(up)])); // its reads are heavy and nobody waits on them
}
// origins in a loop of its own: in the main round it waited on markets' tape reads (~30 s each, 2026-11-05) and checked
// 200 tokens a minute, ~7 days for the 2M tokens the history pass found. Its own read is ~1 s; the rest is 2 calls a token.
async function originsLoop(up: Up): Promise<never> {
  for (let wait = 0; ; await new Promise((r) => setTimeout(r, wait))) {
    try { wait = await origins(up, ORIGINS_BATCH) ? 1_000 : 60_000; }
    catch (e) { console.error("discovery origins:", (e as Error).message); wait = 60_000; }
  }
}

async function discoveryLoop(up: Up): Promise<never> {
  for (let wait = 0; ; await new Promise((r) => setTimeout(r, wait))) {
    try {
      const t0 = Date.now(), n = await creations(up) + await markets(up) + await payouts();
      // it rests REST times its round always, not only while the history pass ran: once the pass was done it ran flat out,
      // ~0.25 of ClickHouse's 3.5 CPUs while API reads queued behind them (2026-11-06 06:10)
      wait = !n ? 60_000 : Math.max(1_000, REST * (Date.now() - t0));
    } catch (e) { console.error("discovery:", (e as Error).message); wait = 60_000; } // ingest may not have migrated yet
  }
}
