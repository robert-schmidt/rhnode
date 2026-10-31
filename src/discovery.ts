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
// Throttled (DISCOVERY_PAR calls at a time, a pause between batches) so it never slows the history pass.
import { keccak256 } from "viem";
import { insert, rows } from "./ch.ts";
import { PROTOCOL } from "./chain/protocol.ts";
import { BURN_SINKS, METRIC_OMM_FACTORY, UNIV2_FACTORY, UNIV3_FACTORY, UNIV4_POOL_MANAGER } from "./chain/constants.ts";
import { HOOK_SOURCES } from "./chain/registry.ts";
import { deduceMarkets, type Tf } from "./early.ts";
import type { Up } from "./cards.ts";

const PAR = Number(process.env.DISCOVERY_PAR ?? 8);
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"; // EIP-1967 implementation
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50"; // EIP-1967 beacon
const IMPLEMENTATION = "0x5c60da1b"; // implementation()
const NOT_MINTERS = new Set(["quote", "router", "pool_manager", "infra", "relay", "hook", "locker", "burn"]);

type Log = { address: string; topics: string[]; data: string };

/** PURE. The contract that made `token`, from its mint tx's logs: the first emitter (not the token, not `infra`) whose
 *  log names the token in a topic or its data; null when none does. */
export function minterOf(token: string, logs: Log[], infra: Set<string>): string | null {
  const t = token.slice(2).toLowerCase();
  for (const l of logs) {
    const a = l.address.toLowerCase();
    if (a === token || infra.has(a)) continue;
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

async function origins(up: Up): Promise<number> {
  const due = await rows<Record<string, unknown> & { token: string; tx_hash: string; v: string }>(
    `SELECT token, block, tx_index, log_index, tx_hash, time, mint_recipient, toString(amount) AS amt, toString(version) AS v
     FROM token_origin FINAL WHERE checked = 0 ORDER BY block DESC LIMIT 200`);
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

async function markets(up: Up): Promise<number> {
  const [tip] = await rows<{ b: string }>("SELECT max(block) AS b FROM ctl_cursors FINAL WHERE name = 'tip'");
  const due = await rows<{ token: string; block: string; tx_hash: string; minter: string }>(
    `SELECT o.token AS token, o.block AS block, o.tx_hash AS tx_hash, o.minter AS minter FROM token_origin AS o FINAL
     LEFT JOIN (SELECT token, final, version FROM token_markets FINAL) AS m ON m.token = o.token
     WHERE o.checked = 1 AND o.minter != '' AND (m.version = 0 OR (m.final = 0
       AND m.version < {now:UInt64} - if(o.block + {week:UInt64} > {tip:UInt64}, 3600000, 86400000)))
     ORDER BY o.block DESC LIMIT 100`, { now: Date.now(), week: WEEK, tip: Number(tip.b) });
  if (!due.length) return 0;
  const t = due.map((d) => d.token);
  const [tape, pr, lps] = await Promise.all([
    rows<Row>(`${TF} WHERE token IN {t:Array(String)} AND sign = 1 ORDER BY token, block, log_index LIMIT 500 BY token`, { t }),
    rows<{ pool: string; vn: string; cb: string; hooks: string; token0: string; token1: string }>(
      `SELECT pool, toString(venue) AS vn, created_block AS cb, hooks, token0, token1 FROM pools FINAL
       WHERE ok = 1 AND (token0 IN {t:Array(String)} OR token1 IN {t:Array(String)})`, { t }),
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
  const F = ct.length ? byToken((await rows<Row>(`${TF} WHERE token IN {t:Array(String)} AND (\`from\` IN {c:Array(String)} OR \`to\` IN {c:Array(String)}) AND sign = 1
    ORDER BY token, block, log_index LIMIT 100000 BY token`, { t: ct, c: cs })).filter((r) => r.from === curve.get(r.token) || r.to === curve.get(r.token))) : new Map();
  const empty = new Map(ct.map((k) => [k, emptiedAt(curve.get(k)!, F.get(k) ?? [])] as const).filter(([, e]) => e));
  const G = empty.size ? (await rows<Row>(`${TF} WHERE token IN {t:Array(String)} AND tx_hash IN {h:Array(String)} AND sign = 1 ORDER BY block, log_index`,
    { t: [...empty.keys()], h: [...empty.values()].map((e) => e!.tx_hash) })) : [];
  const out = due.map((d) => {
    const c = curve.get(d.token) ?? "", g = c ? graduationOf(c, F.get(d.token) ?? [], new Map([[empty.get(d.token)?.tx_hash ?? "", G.filter((r) => r.token === d.token).map(tr)]]), P.get(d.token) ?? []) : null;
    return { token: d.token, minter: d.minter, curve: c, grad_block: g?.block ?? 0, grad_tx: g?.tx ?? "", pool: g?.pool ?? "", venue: g?.venue ?? "",
      final: g || (!c && (lp.has(d.token) || skip.has(d.minter) || Number(d.block) + DAY < Number(tip.b))) ? 1 : 0, version: Date.now() };
  });
  await insert("token_markets", out, `markets:${t[0]}:${t.at(-1)}:${Date.now()}`);
  return out.length;
}

export async function discoveryWorker(up: Up): Promise<never> {
  for (let wait = 0; ; await new Promise((r) => setTimeout(r, wait))) {
    try {
      const n = await creations(up) + await origins(up) + await markets(up);
      wait = n ? 1_000 : 60_000;
    } catch (e) { console.error("discovery:", (e as Error).message); wait = 60_000; } // ingest may not have migrated yet
  }
}
