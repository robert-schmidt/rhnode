// Launchpad discovery from the chain itself (migration 024). The promoter's worker enriches what the views collect:
// - creations: code_hash (keccak of the code now; '' once it is gone) and implementation, the EIP-1967 implementation
//   slot's address, else the EIP-1967 beacon's implementation();
// - token_origin: the first mint's tx_from and tx_to (from the node's permanent tx and receipt), and its minter, the
//   contract that made the token: its creator when tip traces saw the creation (minter_source 'trace'); else the first
//   contract in the mint tx's receipt, other than the token and DEX infrastructure, whose log names the token (a
//   launchpad's launch event does; a router that only forwards does not: 'event'); a token deployed by the tx itself has
//   none ('deploy'). tx_to stays what the signer called, so a router in front of a launchpad shows as such.
// Throttled (DISCOVERY_PAR calls at a time, a pause between batches) so it never slows the history pass.
import { keccak256 } from "viem";
import { insert, rows } from "./ch.ts";
import { PROTOCOL } from "./chain/protocol.ts";
import { METRIC_OMM_FACTORY, UNIV2_FACTORY, UNIV3_FACTORY } from "./chain/constants.ts";
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
    const by = traced.get(d.token), ev = by ? null : minterOf(d.token, rc.logs, skip);
    const { v, amt, ...row } = d;
    out.push({ ...row, amount: amt, tx_from: tx.from.toLowerCase(), tx_to: (tx.to ?? "").toLowerCase(), checked: 1, version: String(BigInt(v) + 1n),
      ...(by ? { minter: by, minter_source: "trace" } : tx.to == null ? { minter: "", minter_source: "deploy" } : { minter: ev ?? "", minter_source: ev ? "event" : "" }) });
  });
  await insert("token_origin", out, `origins:${due[0].token}:${due.at(-1)!.token}:${out.length}:${due[0].v}`);
  return out.length;
}

export async function discoveryWorker(up: Up): Promise<never> {
  for (let wait = 0; ; await new Promise((r) => setTimeout(r, wait))) {
    try {
      const n = await creations(up) + await origins(up);
      wait = n ? 1_000 : 60_000;
    } catch (e) { console.error("discovery:", (e as Error).message); wait = 60_000; } // ingest may not have migrated yet
  }
}
