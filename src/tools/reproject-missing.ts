// One-off (2026-11-11, a client's report): tokens with a mint (token_origin) and no card row (serve_tokens), ~226K on that day, in
// whole block ranges whose tokens the history pass's re-projection lost (48–55M, 64–68M, 74–78M, 82–86M, 92–96M). Each slice
// is projected at a fresh tip (our node keeps ~1,200 blocks of state), as the bulk workload, and waits while ingest or the
// projector trail (the node's priorities). Idempotent: every run re-reads what is still missing.
// `node src/tools/reproject-missing.ts [--dry]` (NITRO_HTTP for the lag check)
import { cfg } from "../config.ts";
import { rows, workload } from "../ch.ts";
import { upstream } from "../chain/upstream.ts";
import { projectTokens } from "../projector/main.ts";

const SLICE = 1_000, MAX_LAG = 50, PROJ_MAX_LAG = 300;
const node = process.env.NITRO_HTTP;
if (!node) throw new Error("NITRO_HTTP (our own node) is required");
const up = upstream(cfg.upstreamHttp, { attempts: 4, timeoutMs: 60_000 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function head(): Promise<number> {
  const r = await fetch(node!, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), signal: AbortSignal.timeout(10_000) });
  return Number(((await r.json()) as { result: string }).result);
}
/** The tip ingest stored, once ingest is within MAX_LAG of our node and the projector within PROJ_MAX_LAG of ingest. */
async function calmTip(): Promise<number> {
  for (;;) {
    const [c] = await rows<{ tip: string; proj: string }>(
      "SELECT maxIf(block, name = 'tip') AS tip, maxIf(block, name = 'projector') AS proj FROM ctl_cursors FINAL WHERE name IN ('tip', 'projector')");
    const tip = Number(c.tip), h = await head().catch(() => 0);
    if (h && h - tip <= MAX_LAG && tip - Number(c.proj) <= PROJ_MAX_LAG) return tip;
    await sleep(10_000);
  }
}

async function main() {
  const missing = (await rows<{ token: string }>(
    `SELECT o.token AS token FROM (SELECT token FROM token_origin FINAL) o LEFT ANTI JOIN (SELECT DISTINCT token FROM serve_tokens) s USING token`))
    .map((r) => r.token);
  console.log(`${missing.length} tokens have a mint and no card`);
  if (process.argv.includes("--dry")) return;
  const t0 = Date.now();
  for (let i = 0; i < missing.length; i += SLICE) {
    const s = missing.slice(i, i + SLICE), t1 = Date.now();
    await projectTokens(up, s, await calmTip(), `reproject-missing:${i}`);
    console.log(JSON.stringify({ at: new Date().toISOString(), done: i + s.length, of: missing.length, ms: Date.now() - t1, total_min: Math.round((Date.now() - t0) / 60_000) }));
  }
}
await workload.run("bulk", main);
process.exit(0);
