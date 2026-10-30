// Method and event names for 4-byte selectors and topic0s: a few built in, the rest from the public openchain signature
// database (keyless), cached in memory. A lookup that is slow or fails just leaves the raw hex on the page.
import { toFunctionSelector, type AbiFunction } from "viem";
import { stripMetadata } from "../projector/contracts.ts";
import type { Rpc } from "./pages.ts";
const OPENCHAIN = "https://api.openchain.xyz/signature-database/v1/lookup";
const KNOWN: Record<string, string> = {
  "0xa9059cbb": "transfer(address,uint256)", "0x095ea7b3": "approve(address,uint256)", "0x23b872dd": "transferFrom(address,address,uint256)",
  "0xd0e30db0": "deposit()", "0x2e1a7d4d": "withdraw(uint256)", "0x3593564c": "execute(bytes,bytes[],uint256)", "0xac9650d8": "multicall(bytes[])",
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef": "Transfer(address,address,uint256)",
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925": "Approval(address,address,uint256)",
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67": "Swap(address,address,int256,int256,uint160,uint128,int24)",
  "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f": "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)",
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822": "Swap(address,uint256,uint256,uint256,uint256,address)",
};
const seed = () => new Map<string, { name: string | null; at: number }>(Object.entries(KNOWN).map(([k, v]) => [k, { name: v, at: Infinity }]));
let names = seed();
const MISS_TTL = 3_600_000;

/** Names for selectors (0x + 8 hex) and topics (0x + 64 hex); unknown ones are absent from the map. */
export async function lookup(hexes: string[]): Promise<Map<string, string>> {
  const want = [...new Set(hexes.map((h) => h.toLowerCase()))].filter((h) => /^0x([0-9a-f]{8}|[0-9a-f]{64})$/.test(h));
  const todo = want.filter((h) => { const c = names.get(h); return !c || (c.name === null && Date.now() - c.at > MISS_TTL); });
  if (todo.length) {
    const fn = todo.filter((h) => h.length === 10), ev = todo.filter((h) => h.length === 66);
    try {
      const r = await fetch(`${OPENCHAIN}?function=${fn.join(",")}&event=${ev.join(",")}&filter=true`, { signal: AbortSignal.timeout(1500) });
      const j = (await r.json()) as { result?: { function?: Record<string, { name: string }[] | null>; event?: Record<string, { name: string }[] | null> } };
      for (const h of todo) {
        const hit = (h.length === 10 ? j.result?.function : j.result?.event)?.[h]?.[0]?.name ?? null;
        names.set(h, { name: hit, at: Date.now() });
      }
    } catch { /* leave them unknown; asked again next time */ }
    if (names.size > 50_000) names = seed();
  }
  return new Map(want.flatMap((h) => { const n = names.get(h)?.name; return n ? [[h, n] as [string, string]] : []; }));
}

/** "transfer(address,uint256)" → "transfer" */
export const bare = (sig: string) => sig.replace(/\(.*$/, "");

// --- method names checked against the called contract ---
// The public databases also hold vanity-mined names that only share the 4 bytes (0x00000000 answers
// "fulfillBasicOrder_efficient_6GL6yc(...)"; bots use such selectors for packed calldata). So a database name is shown
// only when the called code has the selector as a PUSH4 constant (its dispatcher compares against it), through a clone
// or EIP-1967 proxy. A contract verified on Sourcify names its methods from its own ABI.

const SOURCIFY = "https://sourcify.dev/server/v2/contract/4663/";
const CLONE = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/;
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
type Known = { push4: Set<string>; abi: Map<string, string>; at: number };
let contracts = new Map<string, Promise<Known>>();
const TTL = 6 * 3_600_000; // a proxy can be upgraded

/** PURE. Every PUSH4 constant in the code (metadata stripped), "0x"-prefixed. */
export function push4s(code: string): Set<string> {
  const b = Buffer.from(stripMetadata(code), "hex"), out = new Set<string>();
  for (let i = 0; i < b.length; i++) {
    const op = b[i];
    if (op === 0x63) out.add("0x" + b.subarray(i + 1, i + 5).toString("hex"));
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
  return out;
}

async function sourcifyAbi(a: string): Promise<Map<string, string>> {
  try {
    const r = await fetch(`${SOURCIFY}${a}?fields=abi`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return new Map();
    const abi = ((await r.json()) as { abi?: AbiFunction[] }).abi ?? [];
    return new Map(abi.filter((x) => x.type === "function").map((f) => [toFunctionSelector(f), `${f.name}(${f.inputs.map((i) => i.type).join(",")})`]));
  } catch { return new Map(); }
}

async function learn(rpc: Rpc, a: string): Promise<Known> {
  const code = ((await rpc("eth_getCode", [a, "latest"])).result as string | undefined) ?? "0x";
  let impl = code.toLowerCase().match(CLONE)?.[1] ? "0x" + code.toLowerCase().match(CLONE)![1] : "";
  if (!impl && code.length > 2 && code.length < 4000) {
    const s = ((await rpc("eth_getStorageAt", [a, IMPL_SLOT, "latest"])).result as string | undefined) ?? "0x";
    if (!/^0x0*$/.test(s)) impl = "0x" + s.slice(-40);
  }
  const implCode = impl ? ((await rpc("eth_getCode", [impl, "latest"])).result as string | undefined) ?? "0x" : "0x";
  const [abi, implAbi] = await Promise.all([sourcifyAbi(a), impl ? sourcifyAbi(impl) : Promise.resolve(new Map<string, string>())]);
  return { push4: new Set([...push4s(code), ...push4s(implCode)]), abi: new Map([...implAbi, ...abi]), at: Date.now() };
}

/** Method names for calls `to`+`input`, keyed `${to}:${selector}`; a call whose name can't be checked is absent. */
export async function methods(rpc: Rpc, calls: { to: string | null; input: string }[]): Promise<Map<string, string>> {
  const want = calls.filter((c) => c.to && c.input.length >= 10).map((c) => ({ to: c.to!.toLowerCase(), sel: c.input.slice(0, 10).toLowerCase() }));
  const tos = [...new Set(want.map((w) => w.to))];
  if (contracts.size > 20_000) contracts = new Map();
  const known = await Promise.all(tos.map((a) => {
    let k = contracts.get(a);
    if (!k) { k = learn(rpc, a); contracts.set(a, k); k.catch(() => contracts.delete(a)); }
    else k.then((v) => { if (Date.now() - v.at > TTL) contracts.delete(a); }, () => {});
    return k.catch(() => null);
  }));
  const byTo = new Map(tos.map((a, i) => [a, known[i]]));
  const db = await lookup(want.map((w) => w.sel));
  const out = new Map<string, string>();
  for (const { to, sel } of want) {
    const k = byTo.get(to), n = k?.abi.get(sel) ?? (k?.push4.has(sel) ? db.get(sel) : undefined);
    if (n) out.set(`${to}:${sel}`, n);
  }
  return out;
}
