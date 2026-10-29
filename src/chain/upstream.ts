// JSON-RPC over an ordered list of endpoints, each with its own rate budget (token bucket,
// 1 s burst). A failing endpoint backs off exponentially; a `null` result (an endpoint that
// lags the head and doesn't have the block yet) only rests it briefly. Never logs a URL, only
// its host: a URL can carry a key.
import type { Upstream } from "../config.ts";

type Ep = { host: string; url: string; rps: number; tokens: number; at: number; downUntil: number; fails: number; ok: number; err: number; nulls: number };

export class RpcError extends Error {
  host: string;
  code?: number;
  constructor(host: string, msg: string, code?: number) { super(`${host}: ${msg}`); this.host = host; this.code = code; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function upstream(list: Upstream[], opts: { timeoutMs?: number; attempts?: number } = {}) {
  if (!list.length) throw new Error("no upstream endpoints");
  const eps: Ep[] = list.map(({ url, rps }) => ({ host: new URL(url).host, url, rps, tokens: rps, at: Date.now(), downUntil: 0, fails: 0, ok: 0, err: 0, nulls: 0 }));
  const attempts = opts.attempts ?? 30;
  let rr = 0;
  let id = 0;

  async function take(): Promise<Ep> {
    for (;;) {
      const now = Date.now();
      for (let i = 0; i < eps.length; i++) {
        const e = eps[(rr + i) % eps.length];
        e.tokens = Math.min(e.rps, e.tokens + ((now - e.at) / 1000) * e.rps);
        e.at = now;
        if (e.downUntil <= now && e.tokens >= 1) {
          e.tokens -= 1;
          rr = (rr + i + 1) % eps.length;
          return e;
        }
      }
      await sleep(15);
    }
  }

  /** A result, retried across endpoints. `null` counts as "not there yet". */
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    let last: unknown;
    for (let a = 0; a < attempts; a++) {
      const e = await take();
      try {
        const res = await fetch(e.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        });
        if (!res.ok) throw new RpcError(e.host, `HTTP ${res.status}`, res.status);
        const j = (await res.json()) as { result?: T; error?: { code: number; message: string } };
        if (j.error) throw new RpcError(e.host, `${method}: ${j.error.message}`, j.error.code);
        if (j.result == null) {
          e.nulls++;
          e.downUntil = Date.now() + 300;
          last = new RpcError(e.host, `${method}: null result`);
          continue;
        }
        e.ok++;
        e.fails = 0;
        return j.result;
      } catch (err) {
        e.err++;
        e.fails++;
        e.downUntil = Date.now() + Math.min(60_000, 250 * 2 ** e.fails);
        last = err instanceof RpcError ? err : new RpcError(e.host, `${method}: ${(err as Error).message}`);
      }
    }
    throw last;
  }

  let headSeen = 0;
  return {
    call,
    /** Highest head any endpoint reported (they lag each other by a few blocks). */
    async head(): Promise<number> {
      headSeen = Math.max(headSeen, Number(await call<string>("eth_blockNumber", [])));
      return headSeen;
    },
    stats: () => eps.map(({ host, ok, err, nulls, fails }) => ({ host, ok, err, nulls, down: fails > 0 })),
  };
}
export type Client = ReturnType<typeof upstream>;
