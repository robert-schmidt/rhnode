// eth_subscribe filters, matched in-process against ingest's blocks. No caps on addresses or topics: a set per
// topic position, so a 1,700-wallet topic filter costs one Set lookup per log.
type Log = Record<string, unknown> & { address?: string; topics?: string[] };
type Block = { header: Record<string, unknown>; logs: Log[] };
export type Sub = { match: (b: Block) => unknown[] };

const set = (x: unknown) => {
  const xs = (Array.isArray(x) ? x : x ? [x] : []).map((v) => String(v).toLowerCase());
  return xs.length ? new Set(xs) : null;
};

/** A matcher for `eth_subscribe(kind, filter)`, or null if the kind isn't supported. */
export function matcher(kind: string, filter: unknown): Sub | null {
  if (kind === "newHeads") return { match: (b) => [b.header] };
  if (kind !== "logs") return null;
  const f = (filter ?? {}) as { address?: unknown; topics?: unknown[] };
  const addrs = set(f.address);
  const topics = (f.topics ?? []).slice(0, 4).map(set);
  return {
    match: (b) => b.logs.filter((l) =>
      (!addrs || addrs.has(String(l.address).toLowerCase())) &&
      topics.every((t, i) => !t || (l.topics?.[i] !== undefined && t.has(l.topics[i].toLowerCase())))),
  };
}

// Self-check: node src/api/subs.ts
if (import.meta.main) {
  const W = "0x000000000000000000000000" + "ab".repeat(20), T = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const log = { address: "0xAA", topics: [T, "0x" + "0".repeat(64), W] };
  const b = { header: { number: "0x1" }, logs: [log, { address: "0xbb", topics: [T] }] };
  console.assert(matcher("logs", { topics: [T, null, [W.toUpperCase().replace("0X", "0x")]] })!.match(b).length === 1, "topic set");
  console.assert(matcher("logs", { address: ["0xaa"] })!.match(b).length === 1, "address");
  console.assert(matcher("logs", { topics: [T, null, null, T] })!.match(b).length === 0, "missing position");
  console.assert(matcher("newHeads", null)!.match(b).length === 1 && matcher("pending", null) === null, "kinds");
  console.log("subs ok");
}
