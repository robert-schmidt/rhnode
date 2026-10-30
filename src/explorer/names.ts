// Method and event names for 4-byte selectors and topic0s: a few built in, the rest from the public openchain signature
// database (keyless), cached in memory. A lookup that is slow or fails just leaves the raw hex on the page.
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
