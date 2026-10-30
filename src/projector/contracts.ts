// New contracts (migrations/013_contracts.sql): every contract a tx creates, or that emits its first log, with a
// fingerprint of its kind so a consumer can look at unique ones only. Facts only; what a contract is for stays in the apps.
import { createHash } from "node:crypto";
import { insert, inSpan, rows, span } from "../ch.ts";
import type { Client } from "../chain/upstream.ts";

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"; // EIP-1967
const CLONE = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/;
const KINDS: [string, string[]][] = [
  ["v3pool", ["3850c7bd", "128acb08"]], // slot0, swap
  ["v2pair", ["0902f1ac", "022c0d9f"]], // getReserves, swap
  ["erc721", ["6352211e", "42842e0e"]], // ownerOf, safeTransferFrom
  ["erc20", ["a9059cbb", "70a08231", "18160ddd", "23b872dd"]], // transfer, balanceOf, totalSupply, transferFrom
];

/** PURE. Runtime code without solc's CBOR metadata (its length is the last 2 bytes), which differs per build. */
export function stripMetadata(code: string): string {
  const hex = code.replace(/^0x/, "");
  const n = parseInt(hex.slice(-4), 16) * 2;
  const at = hex.length - 4 - n;
  return n > 0 && at > 0 && /^a[1-5]$/.test(hex.slice(at, at + 2)) ? hex.slice(0, at) : hex;
}

/** PURE. The dispatcher's selectors: every `PUSH4 x EQ` (solc and vyper compare the calldata selector this way). */
export function selectors(code: string): string[] {
  const b = Buffer.from(stripMetadata(code), "hex"), out = new Set<string>();
  for (let i = 0; i < b.length; i++) {
    const op = b[i];
    if (op === 0x63 && b[i + 5] === 0x14) out.add(b.subarray(i + 1, i + 5).toString("hex"));
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
  return [...out].sort();
}

/** PURE. What a contract is, from its code alone (impl: a proxy's implementation, read separately). */
export function classify(code: string, impl = "") {
  const clone = code.toLowerCase().match(CLONE);
  if (clone) return { kind: "eip1167", impl: "0x" + clone[1], selectors: [] as string[], fingerprint: "1167:0x" + clone[1] };
  if (impl) return { kind: "eip1967", impl, selectors: [] as string[], fingerprint: "1967:" + impl };
  const sels = selectors(code), has = new Set(sels);
  const kind = KINDS.find(([, need]) => need.every((s) => has.has(s)))?.[0] ?? "contract";
  return { kind, impl: "", selectors: sels, fingerprint: createHash("sha256").update(sels.join(",")).digest("hex").slice(0, 16) };
}

let seen: Set<string> | null = null;

/** Contracts first seen in (from, to]: created by a tx there, or emitting their first log there. */
export async function deriveContracts(up: Client, from: number, to: number): Promise<number> {
  seen ??= new Set((await rows<{ f: string }>("SELECT DISTINCT fingerprint AS f FROM contracts WHERE fingerprint != ''")).map((r) => r.f));
  const t = await span(from, to);
  const fresh = await rows<{ address: string; block: string; time: number; tx_hash: string; deployer: string; created: number }>(
    `SELECT address, b AS block, t AS time, h AS tx_hash, d AS deployer, c AS created FROM (
     SELECT address, min(block) AS b, toUnixTimestamp(min(time)) AS t, argMin(tx_hash, block) AS h,
       argMax(deployer, by_tx) AS d, max(by_tx) AS c
     FROM (SELECT created AS address, block, time, hash AS tx_hash, \`from\` AS deployer, 1 AS by_tx FROM raw_txs
           WHERE block > {from:UInt64} AND block <= {to:UInt64} AND ${inSpan()} AND created != '' AND status = 1
           UNION ALL
           SELECT address, block, time, tx_hash, '' AS deployer, 0 AS by_tx FROM raw_logs
           WHERE block > {from:UInt64} AND block <= {to:UInt64} AND ${inSpan()})
     WHERE address NOT IN (SELECT address FROM contracts)
     GROUP BY address)`, { from, to, ...t });
  if (!fresh.length) return 0;
  const tip = "0x" + to.toString(16);
  const out = await Promise.all(fresh.map(async (c) => {
    const code = await up.call<string>("eth_getCode", [c.address, tip]).catch(() => "");
    if (!code) return null; // not stored: it comes back with its next log
    // A small contract that delegates (DELEGATECALL, 0xf4) may be an EIP-1967 proxy: read its implementation slot.
    const slot = code && code.length < 2000 && code.includes("f4")
      ? await up.call<string>("eth_getStorageAt", [c.address, IMPL_SLOT, tip]).catch(() => "") : "";
    const impl = slot && !/^0x0*$/.test(slot) ? "0x" + slot.slice(-40) : "";
    const k = code !== "0x" ? classify(code, impl) : { kind: "contract", impl: "", selectors: [], fingerprint: "" };
    const first = k.fingerprint && !seen!.has(k.fingerprint) ? 1 : 0;
    if (k.fingerprint) seen!.add(k.fingerprint);
    return {
      ...c, ...k, first_of_kind: first, code_size: Math.max(0, (code.length - 2) / 2),
      code_hash: code !== "0x" ? createHash("sha256").update(stripMetadata(code)).digest("hex").slice(0, 16) : "", version: Date.now(),
    };
  }));
  const ok = out.filter((r) => r !== null);
  await insert("contracts", ok, `contracts:${from}-${to}`);
  return ok.length;
}
