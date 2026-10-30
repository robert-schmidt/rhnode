// The API (ARCHITECTURE §6). One process: /rpc (JSON-RPC), /ws (eth_subscribe fan-out + JSON-RPC), /api and /api/v2
// (Blockscout-compatible subset), /health. Listens on the compose network only; publish it on loopback and put a
// TLS proxy in front. Every route except /health needs an API key: `x-api-key` header, `?apikey=` (Etherscan
// style), or a path suffix `/rpc/<key>`, `/ws/<key>` (Alchemy style, for clients that only take a URL).
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { cfg } from "../config.ts";
import { BLOCKS, connect } from "../bus.ts";
import { handle, logStats } from "./rpc.ts";
import type { RpcReply } from "../chain/upstream.ts";
import { v1, v2, walletFirst } from "./compat.ts";
import { coverage } from "./coverage.ts";
import { isNitro, nitro, nitroSynced, watchNitro } from "../chain/nitro.ts";
import { matcher, type Sub } from "./subs.ts";

if (!cfg.api.keys.size) throw new Error("API_KEYS is empty: set API_KEYS=name:key[,name:key] in .env");

type Req = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown[] };
const stats = new Map<string, number>();
const count = (k: string) => stats.set(k, (stats.get(k) ?? 0) + 1);

// Per-key token bucket, 2 s burst.
const buckets = new Map<string, { tokens: number; at: number }>();
function allow(key: string): boolean {
  const now = Date.now(), b = buckets.get(key) ?? { tokens: cfg.api.rps * 2, at: now };
  b.tokens = Math.min(cfg.api.rps * 2, b.tokens + ((now - b.at) / 1000) * cfg.api.rps);
  b.at = now;
  buckets.set(key, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** The caller's key name, or null. */
function auth(req: http.IncomingMessage, url: URL): string | null {
  const seg = url.pathname.match(/^\/(?:rpc|ws)\/([^/]+)$/)?.[1];
  const key = (req.headers["x-api-key"] as string | undefined) ?? url.searchParams.get("apikey") ?? seg ?? "";
  return cfg.api.keys.get(key) ?? null;
}

async function rpcOne(r: Req, who: string) {
  if (!r || typeof r.method !== "string") return { jsonrpc: "2.0", id: r?.id ?? null, error: { code: -32600, message: "invalid request" } };
  count(`${who} ${r.method}`);
  try {
    return { jsonrpc: "2.0", id: r.id ?? null, ...(await handle(r.method, Array.isArray(r.params) ? r.params : [])) };
  } catch (e) {
    return { jsonrpc: "2.0", id: r.id ?? null, error: { code: -32603, message: (e as Error).message } };
  }
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s), "access-control-allow-origin": "*" });
  res.end(s);
}

async function body(req: http.IncomingMessage): Promise<string> {
  let s = "";
  for await (const chunk of req) { s += chunk; if (s.length > 5_000_000) throw new Error("body too large"); }
  return s;
}

// /health (no key): whether clients should use rhnode right now, and for what. 503 when not ok, so a plain
// status check is enough; the fields let a client decide per subsystem (e.g. every eth_call only when node = "nitro").
const NITRO_ROUTED = cfg.upstreamHttp.some((u) => isNitro(u.url));
if (process.env.NITRO_HTTP) watchNitro(process.env.NITRO_HTTP); // probed even before /rpc is routed to it
const MAX_LAG_BLOCKS = 600; // ~1 min at ~104 ms blocks
const MAX_STREAM_AGE_S = 30;
let lastBlockAt = 0;

async function health() {
  const c = await coverage();
  const head: RpcReply = await handle("eth_blockNumber").catch((e: Error) => ({ error: { code: -1, message: e.message } }));
  const headN = head.error ? null : Number(head.result);
  const lag = headN == null ? null : Math.max(0, headN - c.ingested);
  const streamAgeS = lastBlockAt ? Math.round((Date.now() - lastBlockAt) / 1000) : null;
  const upstream = !head.error, index = lag != null && lag <= MAX_LAG_BLOCKS, stream = streamAgeS != null && streamAgeS <= MAX_STREAM_AGE_S;
  return {
    ok: upstream && index && stream,
    // "nitro": /rpc is served by our own node and it's synced; "public": /rpc proxies the free endpoints (rate-shared)
    node: NITRO_ROUTED && nitro.since ? "nitro" : "public",
    nitroSinceS: NITRO_ROUTED && nitro.since ? Math.round((Date.now() - nitro.since) / 1000) : null,
    nitroHead: nitro.head, nitroBehind: nitro.behind,
    upstream, index, stream,
    head: headN, ingested: c.ingested, lagBlocks: lag, streamAgeS,
    rawFrom: Number.isFinite(c.rawFrom) ? c.rawFrom : null,
    // every ERC-20 transfer from here on is held (go-live, then the walk's floor down to 0); absent until known
    ...(c.exactFrom != null ? { exactFrom: c.exactFrom } : {}),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (url.pathname === "/health") {
      const h = await health();
      return send(res, h.ok ? 200 : 503, h);
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, x-api-key", "access-control-allow-methods": "GET, POST" });
      return res.end();
    }
    const who = auth(req, url);
    if (!who) return send(res, 401, { error: "missing or unknown API key" });
    if (!allow(who)) return send(res, 429, { error: `rate limit: ${cfg.api.rps} req/s` });
    if (req.method === "POST" && /^\/rpc(\/[^/]+)?$/.test(url.pathname)) {
      let j: Req | Req[];
      try { j = JSON.parse(await body(req)); } catch { return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
      return send(res, 200, Array.isArray(j) ? await Promise.all(j.map((r) => rpcOne(r, who))) : await rpcOne(j, who));
    }
    if (req.method === "GET" && url.pathname === "/api") {
      count(`${who} api ${url.searchParams.get("module")}.${url.searchParams.get("action")}`);
      const r = await v1(url.searchParams);
      return send(res, r.status, r.body);
    }
    const first = req.method === "GET" && url.pathname.match(/^\/v1\/wallets\/([^/]+)\/first$/);
    if (first) {
      count(`${who} v1 wallets/first`);
      const r = await walletFirst(first[1]);
      return send(res, r.status, r.body);
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/v2/")) {
      count(`${who} api ${url.pathname.replace(/0x[0-9a-fA-F]{40}/g, "{a}")}`);
      const r = await v2(url.pathname, url.searchParams);
      return send(res, r.status, r.body);
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    console.warn(`[api] ${req.method} ${url.pathname}: ${(e as Error).message}`);
    if (!res.headersSent) send(res, 500, { error: (e as Error).message });
  }
});

// WebSocket: eth_subscribe (newHeads, logs) from ingest's stream, everything else through the JSON-RPC handler.
const wss = new WebSocketServer({ noServer: true, maxPayload: 5_000_000 });
const conns = new Map<WebSocket, { who: string; subs: Map<string, Sub> }>();
let subId = 0;

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://x");
  const who = /^\/ws(\/[^/]+)?$/.test(url.pathname) ? auth(req, url) : null;
  if (!who) { socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n"); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const c = { who, subs: new Map<string, Sub>() };
    conns.set(ws, c);
    let alive = true;
    ws.on("pong", () => { alive = true; });
    const ping = setInterval(() => { if (!alive) return ws.terminate(); alive = false; ws.ping(); }, 30_000);
    ws.on("close", () => { clearInterval(ping); conns.delete(ws); });
    ws.on("message", async (raw) => {
      let r: Req;
      try { r = JSON.parse(String(raw)); } catch { return ws.send(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })); }
      if (!allow(who)) return ws.send(JSON.stringify({ jsonrpc: "2.0", id: r.id ?? null, error: { code: -32005, message: "rate limit" } }));
      if (r.method === "eth_subscribe") {
        count(`${who} ws eth_subscribe`);
        const [kind, filter] = (r.params ?? []) as [string, unknown];
        const sub = matcher(kind, filter);
        if (!sub) return ws.send(JSON.stringify({ jsonrpc: "2.0", id: r.id ?? null, error: { code: -32602, message: `unsupported subscription ${kind}` } }));
        const id = "0x" + (++subId).toString(16).padStart(32, "0");
        c.subs.set(id, sub);
        return ws.send(JSON.stringify({ jsonrpc: "2.0", id: r.id ?? null, result: id }));
      }
      if (r.method === "eth_unsubscribe") return ws.send(JSON.stringify({ jsonrpc: "2.0", id: r.id ?? null, result: c.subs.delete(String(r.params?.[0])) }));
      ws.send(JSON.stringify(await rpcOne(r, who)));
    });
  });
});

// Two feeds into one fan-out. Ingest's (Redis, ~2 s behind: it publishes after the ClickHouse insert) always runs; our
// node's (newHeads + one local eth_getLogs per block, ~100 ms) runs while the node is synced. Each block goes out once,
// in order: whichever feed delivers it first, and the node's feed fills its own gaps.
// ponytail: no `removed: true` on a reorg (the single sequencer hasn't reorged); a replaced block number is just skipped.
type Blk = { header: Record<string, unknown>; logs: Record<string, unknown>[] };
let lastSent = 0;
function fanout(blocks: Blk[]) {
  lastBlockAt = Date.now();
  for (const b of blocks) {
    const n = Number(b.header.number);
    if (n <= lastSent) continue;
    lastSent = n;
    for (const [ws, c] of conns) for (const [id, sub] of c.subs) {
      for (const result of sub.match(b)) ws.send(`{"jsonrpc":"2.0","method":"eth_subscription","params":{"subscription":"${id}","result":${JSON.stringify(result)}}}`);
    }
  }
}

const bus = await connect();
if (bus) {
  const sub = bus.duplicate();
  sub.on("error", (e: Error) => console.warn(`[redis] ${e.message}`));
  await sub.connect();
  await sub.subscribe(BLOCKS, (msg: string) => fanout(JSON.parse(msg) as Blk[]));
} else console.warn("[api] REDIS_URL unset: /ws subscriptions get no events from ingest");

const NITRO_WS = process.env.NITRO_WS ?? "";
async function nodeRpc(method: string, params: unknown[]) {
  const r = await fetch(nitro.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(5_000) });
  return ((await r.json()) as { result: unknown }).result;
}
let fastBusy = Promise.resolve();
function fastFeed() {
  const ws = new WebSocket(NITRO_WS);
  ws.on("open", () => ws.send('{"jsonrpc":"2.0","id":1,"method":"eth_subscribe","params":["newHeads"]}'));
  ws.on("message", (raw) => {
    const head = (JSON.parse(String(raw)) as { params?: { result?: Record<string, unknown> } }).params?.result;
    if (!head || !nitroSynced() || !lastSent) return; // lastSent: start from where ingest's feed is, never from nothing
    const n = Number(head.number);
    fastBusy = fastBusy.then(async () => {
      // Our gap first (a missed head), at most 200 blocks; beyond that ingest's feed is the one catching up.
      for (let k = Math.max(lastSent + 1, n - 200); k <= n; k++) {
        const h = k === n ? head : (await nodeRpc("eth_getBlockByNumber", ["0x" + k.toString(16), false])) as Record<string, unknown>;
        if (!h) return;
        const logs = (await nodeRpc("eth_getLogs", [{ blockHash: h.hash }])) as Record<string, unknown>[];
        fanout([{ header: { ...h, transactions: undefined }, logs }]);
      }
    }).catch((e: Error) => console.warn(`[fastfeed] ${e.message}`));
  });
  ws.on("error", () => {});
  ws.on("close", () => setTimeout(fastFeed, 5_000));
}
if (NITRO_WS && process.env.NITRO_HTTP) fastFeed();

setInterval(() => {
  if (!stats.size) return;
  console.log(JSON.stringify({ at: new Date().toISOString(), ws: conns.size, calls: Object.fromEntries(stats), getLogs: logStats }));
  stats.clear();
}, 60_000);

server.listen(cfg.api.port, () => console.log(`[api] listening on :${cfg.api.port}, ${cfg.api.keys.size} key(s), ${cfg.api.rps} req/s each`));
