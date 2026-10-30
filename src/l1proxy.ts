// L1 (Ethereum) JSON-RPC for Nitro's parent-chain reads, on the compose network only. Two reasons it exists: Nitro
// logs its L1 URL at startup, and a keyed URL (e.g. PublicNode's token in the path) must never reach a log; and Nitro
// takes one L1 URL, so a failing provider would stall it. Uses the first of L1_HTTP ("url|rps,…") that is up and fails
// over to the next on errors and limits. Logs hosts only.
import http from "node:http";
import { parseUpstreams } from "./config.ts";
import { upstream } from "./chain/upstream.ts";

const list = parseUpstreams(process.env.L1_HTTP || "https://eth.drpc.org|20");
const up = upstream(list, { attempts: 6, timeoutMs: 20_000, ordered: true }); // one provider's view of L1 at a time
type Req = { id?: unknown; method?: string; params?: unknown[] };

async function one(r: Req) {
  try {
    return { jsonrpc: "2.0", id: r.id ?? null, ...(await up.forward(String(r.method), Array.isArray(r.params) ? r.params : [])) };
  } catch (e) {
    return { jsonrpc: "2.0", id: r.id ?? null, error: { code: -32603, message: (e as Error).message } };
  }
}

http.createServer(async (req, res) => {
  let s = "";
  for await (const c of req) s += c;
  let out: unknown;
  try {
    const j = JSON.parse(s) as Req | Req[];
    out = Array.isArray(j) ? await Promise.all(j.map(one)) : await one(j);
  } catch {
    out = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } };
  }
  const body = JSON.stringify(out);
  res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}).listen(8545, () => console.log(`[l1proxy] :8545 → ${list.map((u) => new URL(u.url).host).join(", ")}`));

setInterval(() => console.log(JSON.stringify({ l1: up.stats() })), 600_000);
