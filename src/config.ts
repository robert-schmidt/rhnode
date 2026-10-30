// All settings, from env. Two deployment profiles (ARCHITECTURE §8.1): `lite` (no node,
// free endpoints) and `full` (own Nitro). A profile only picks defaults; every setting
// can still be overridden on its own, so behavior never forks on the profile name.
const env = process.env;
const profile = (env.PROFILE ?? "lite") as "lite" | "full";
if (profile !== "lite" && profile !== "full") throw new Error(`PROFILE must be lite|full, got ${profile}`);

const preset = {
  lite: { scope: "watched", traces: "off", ttlDays: 3 },
  full: { scope: "all", traces: "tip", ttlDays: 14 },
}[profile];

/** `url|rps,url|rps`. Measured keyless limits (research/free-chain-data.md §3): official ~15 rps, dRPC ~15,
 *  PublicNode ~25, Pocket 1,200/min shared. Defaults stay below them. All five serve eth_getBlockReceipts
 *  (checked 2026-10-29). Tenderly is left out on purpose: its keyless HTTP has a 1 GB/day egress cap
 *  (x-tdly-egress-limit) that tip ingest alone nearly uses up. It is also the only one whose eth_getLogs
 *  carries a real blockTimestamp (the official RPC returns 0x0), worth keeping for a one-off log job. */
const FREE_HTTP = [
  "https://rpc.mainnet.chain.robinhood.com|10",
  "https://robinhood.drpc.org|10",
  "https://robinhood-rpc.publicnode.com|10",
  "https://robinhood.api.pocket.network|5",
  "https://rpc.sentio.xyz/robinhood|5",
].join(",");

export type Upstream = { url: string; rps: number };
export const parseUpstreams = (s: string): Upstream[] =>
  s.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
    const [url, rps] = x.split("|");
    return { url, rps: Number(rps ?? 10) };
  });

const int = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));

export const cfg = {
  profile,
  upstreamHttp: parseUpstreams(env.UPSTREAM_HTTP ?? FREE_HTTP),
  /** v4 pool lookups (one whole-range eth_getLogs per pool, ~1 KB): Tenderly is the free endpoint that allows it.
   *  ponytail: no fallback; if it fails the pool is retried an hour later. Fallback = official RPC in 10M-block windows. */
  lookupHttp: parseUpstreams(env.LOOKUP_HTTP ?? "https://robinhood-chain.gateway.tenderly.co|5"),
  ingestScope: (env.INGEST_SCOPE ?? preset.scope) as "all" | "watched",
  traces: (env.TRACES ?? preset.traces) as "off" | "tip",
  rawTtlDays: int(env.RAW_TTL_DAYS, preset.ttlDays),
  /** Blocks per insert. Batches are aligned to multiples of this, so a re-run produces the same
   *  batches and ClickHouse drops them by dedup token. Changing it breaks re-run dedup of older ranges. */
  batchBlocks: int(env.BATCH_BLOCKS, 10),
  /** First block on an empty cursor; empty = the current head. */
  startBlock: env.START_BLOCK ? Number(env.START_BLOCK) : null,
  /** LAUNCH keep bit: a new token's first N hours of activity are kept. */
  launchWindowHours: int(env.LAUNCH_WINDOW_HOURS, 24),
  /** Pub/sub between ingest (publishes each batch's blocks + logs) and the API (WebSocket fan-out). Empty = off. */
  redisUrl: env.REDIS_URL ?? "",
  api: {
    port: int(env.API_LISTEN_PORT, 8080),
    /** `name:key,name:key`. Every route except /health needs one (header x-api-key, ?apikey=, or /rpc/<key>, /ws/<key>). */
    keys: new Map((env.API_KEYS ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => { const i = x.indexOf(":"); return [x.slice(i + 1), x.slice(0, i)] as [string, string]; })),
    /** Requests per second per key (token bucket, 2 s burst). WebSocket notifications don't count. */
    rps: int(env.API_RPS, 200),
    /** Immutable JSON-RPC results (receipts, txs, old blocks) kept in memory. */
    cacheMb: int(env.API_CACHE_MB, 128),
    /** eth_sendRawTransaction goes here only, once (never retried across endpoints). */
    sendHttp: parseUpstreams(env.SEND_HTTP ?? "https://rpc.mainnet.chain.robinhood.com|20"),
    /** Optional: Blockscout PRO key. When set, /api questions we can't answer exactly are proxied there. */
    blockscoutKey: env.BLOCKSCOUT_API_KEY ?? "",
  },
  /** The explorer's pages (src/explorer). With a secret they need an access token (src/explorer/gate.ts); empty = open. */
  explorer: {
    secret: env.EXPLORER_SECRET ?? "",
    /** Self-serve tokens: the GitHub repo where an access issue is opened (owner/name). */
    repo: env.EXPLORER_REPO ?? "", // default: the repo the footer links
    /** The issue's author must also have starred the repo. */
    requireStar: env.EXPLORER_REQUIRE_STAR !== "0",
    /** Optional: a GitHub token (no scopes) lifts the keyless 60 requests/h. Never logged. */
    githubToken: env.GITHUB_TOKEN ?? "",
    /** GitHub logins whose tokens no longer work. */
    revoked: new Set((env.EXPLORER_REVOKED ?? "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean)),
  },
  clickhouse: {
    url: env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123",
    username: env.CLICKHOUSE_USER ?? "rhnode",
    password: env.CLICKHOUSE_PASSWORD ?? "",
    database: env.CLICKHOUSE_DB ?? "rhnode",
  },
};
