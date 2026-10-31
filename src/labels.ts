// Address labels (migration 020): exchanges, bridges and solvers, flagged addresses. Free and keyless: Blockscout's
// metadata service answers 200 addresses a call (~0.3 s, measured 2026-10-31), with the Open Labels Initiative's
// labels among its tags. Of our 400 biggest ETH funding hubs it named 3 on 4663 and 28 counting the same addresses on
// Ethereum, Base, Arbitrum and BSC (Relay solvers, Layerswap, Gate.io, SideShift, Robinhood's exchange wallets).
// The promoter's worker labels every hub (an address that sent ETH to or got it from ≥ HUB_PEERS wallets) and every
// requested wallet, rechecked after 30 days. Pages and the API read labelsOf(), which adds the protocol registry.
import { ch, rows } from "./ch.ts";
import { PROTOCOL } from "./chain/protocol.ts";
import type { Up } from "./cards.ts";

export type Label = { kind: string; name: string; source: string; chain: number };
type Tag = { slug: string; name: string; tagType: string; ordinal: number };

const META = "https://metadata.services.blockscout.com/api/v1/metadata";
const CHAINS = [4663, 1, 8453, 42161, 56]; // ours first; the others only for addresses without code here
const HUB_PEERS = Number(process.env.LABEL_HUB_PEERS ?? 50);
// Checked in order: a solver that is also a deposit address is an exchange; a "phish" tag only when nothing else fits
// (labels are crowd-sourced and decoys get tagged too).
const KINDS: [string, RegExp][] = [["cex", /exchange|hot wallet|cold wallet|deposit/i], ["bridge", /bridge|solver|relayer|intents|layerswap/i],
  ["flagged", /phish|hack|scam|exploit|sanction|ofac|heist/i]];

/** The label of one address's tags on one chain: the best name tag, and the kind its tags add up to. */
export function classify(tags: Tag[]): { kind: string; name: string } | null {
  if (!tags.length) return null;
  const all = tags.map((t) => `${t.name} ${t.slug}`).join(" | ");
  const kind = KINDS.find(([, re]) => re.test(all))?.[0] ?? "entity";
  const name = [...tags].filter((t) => t.tagType === "name").sort((a, b) => b.ordinal - a.ordinal)[0]?.name
    ?? tags.find((t) => t.tagType === "protocol")?.name ?? tags[0].name;
  return { kind, name };
}

async function lookup(addrs: string[], chain: number): Promise<Map<string, Tag[]>> {
  const r = await fetch(`${META}?addresses=${addrs.join(",")}&chainId=${chain}`, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`metadata ${chain}: HTTP ${r.status}`);
  const j = (await r.json()) as { addresses: Record<string, { tags: Tag[] }> };
  return new Map(Object.entries(j.addresses).map(([a, v]) => [a.toLowerCase(), v.tags ?? []]));
}

/** Label a batch (≤200): our chain's tags, else another chain's for an address without code here. */
export async function label(up: Up, addrs: string[]): Promise<number> {
  const per = await Promise.all(CHAINS.map((c) => lookup(addrs, c)));
  const out = await Promise.all(addrs.map(async (address) => {
    let hit: { kind: string; name: string; chain: number; tags: string[] } | null = null;
    for (const [i, chain] of CHAINS.entries()) {
      const tags = per[i].get(address) ?? [], c = classify(tags);
      if (!c) continue;
      if (chain !== 4663) {
        const code = await up.call<string>("eth_getCode", [address, "latest"]).catch(() => null);
        if (code == null || (code !== "0x" && !code.startsWith("0xef0100"))) break; // a contract here: another chain's tags say nothing
      }
      hit = { ...c, chain, tags: [...new Set(tags.map((t) => t.name))] };
      break;
    }
    return { address, source: "blockscout", kind: hit?.kind ?? "", name: hit?.name ?? "", chain: hit?.chain ?? 0, tags: hit?.tags ?? [] };
  }));
  await ch.insert({ table: "labels", values: out, format: "JSONEachRow" });
  return out.filter((x) => x.name).length;
}

/** Hubs and requested wallets not checked in 30 days, every hour. */
export async function labelWorker(up: Up): Promise<never> {
  for (;;) {
    try {
      const due = (await rows<{ a: string }>(`SELECT a FROM (
          SELECT src AS a FROM agg_native_src GROUP BY src HAVING uniqMerge(peers) >= {p:UInt32}
          UNION DISTINCT SELECT dst AS a FROM agg_native_dst GROUP BY dst HAVING uniqMerge(peers) >= {p:UInt32}
          UNION DISTINCT SELECT wallet AS a FROM ctl_wallet_index FINAL)
        WHERE a NOT IN (SELECT address FROM labels FINAL WHERE source = 'blockscout' AND checked > now() - INTERVAL 30 DAY)`, { p: HUB_PEERS })).map((r) => r.a);
      let named = 0;
      for (let i = 0; i < due.length; i += 200) named += await label(up, due.slice(i, i + 200));
      if (due.length) console.log(`labels: checked ${due.length}, named ${named}`);
    } catch (e) { console.error("labels:", (e as Error).message); }
    await new Promise((r) => setTimeout(r, 3_600_000));
  }
}

/** Labels of addresses: the protocol registry first, then the free sources. */
export async function labelsOf(addrs: string[]): Promise<Map<string, Label>> {
  const m = new Map<string, Label>();
  for (const a of addrs) { const p = PROTOCOL.get(a); if (p) m.set(a, { kind: p.kind, name: p.label, source: "rhnode", chain: 4663 }); }
  const rest = [...new Set(addrs.filter((a) => !m.has(a)))];
  if (rest.length) for (const r of await rows<Label & { address: string }>(
    "SELECT address, kind, name, source, chain FROM labels FINAL WHERE address IN {a:Array(String)} AND name != ''", { a: rest })) m.set(r.address, r);
  return m;
}
