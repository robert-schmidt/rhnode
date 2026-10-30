// The explorer: server-rendered pages, no script, mounted by the API before its key check (pages are public).
// Requests are validated by route() before anything is queried; rendered pages are cached in memory (a page of a final
// block or tx for a day, live pages for seconds) and concurrent misses for one page share one render. Each client IP
// gets a token bucket for cache misses only, so a cached page costs nothing; nginx limits raw request rates in front.
import { readFileSync } from "node:fs";
import type http from "node:http";
import { html, page } from "./html.ts";
import { address, block, home, notFound, search, tx, type Page, type Rpc } from "./pages.ts";

const CSS = readFileSync(new URL("./style.css", import.meta.url));
const SECURITY = {
  "content-security-policy": "default-src 'none'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
};
const HASH = /^0x[0-9a-fA-F]{64}$/, ADDR = /^0x[0-9a-fA-F]{40}$/, NUM = /^\d{1,12}$/;

type Route = { key: string; ttl: number; q?: string; run: (rpc: Rpc) => Promise<Page> } | { redirect: string } | null;

/** PURE: the page a path asks for, with a cache key made only of validated parts; null = not ours. */
export function route(path: string, qs: URLSearchParams): Route {
  if (path === "/") return { key: "/", ttl: 2, run: () => home() };
  let m = path.match(/^\/block\/([^/]+)$/);
  if (m) {
    if (NUM.test(m[1])) return { key: `/block/${Number(m[1])}`, ttl: 5, run: (rpc) => block(rpc, String(Number(m![1]))) };
    if (HASH.test(m[1])) return { key: `/block/${m[1].toLowerCase()}`, ttl: 5, run: (rpc) => block(rpc, m![1].toLowerCase()) };
    return { key: "/404", ttl: 3600, run: async () => notFound("Not a block number or hash.") };
  }
  if ((m = path.match(/^\/tx\/([^/]+)$/))) {
    if (!HASH.test(m[1])) return { key: "/404", ttl: 3600, run: async () => notFound("Not a transaction hash.") };
    const h = m[1].toLowerCase();
    return { key: `/tx/${h}`, ttl: 5, run: (rpc) => tx(rpc, h) };
  }
  if ((m = path.match(/^\/(?:address|token)\/([^/]+)$/))) {
    if (!ADDR.test(m[1])) return { key: "/404", ttl: 3600, run: async () => notFound("Not an address.") };
    const a = m[1].toLowerCase(), p = new URLSearchParams();
    for (const k of ["txb", "tfb"]) if (NUM.test(qs.get(k) ?? "")) p.set(k, String(Number(qs.get(k))));
    const canon = `/address/${a}${p.size ? `?${p}` : ""}`;
    if (path !== `/address/${a}` || (qs.size && `?${qs}` !== (p.size ? `?${p}` : ""))) return { redirect: canon };
    return { key: canon, ttl: 10, run: (rpc) => address(rpc, a, p) };
  }
  if (path === "/search") {
    const q = (qs.get("q") ?? "").trim().slice(0, 100);
    return { key: `/search?q=${q}`, ttl: 60, q, run: (rpc) => search(rpc, q) };
  }
  return null;
}

type Out = { status: number; body: string; redirect?: string; ttl: number };
const cache = new Map<string, { out: Out; until: number }>(); // insertion order = LRU order (a hit re-inserts)
const inflight = new Map<string, Promise<Out>>();
const MAX_PAGES = 5000, IMMUTABLE_S = 86400;
const buckets = new Map<string, { tokens: number; at: number }>();
const RATE = 3, BURST = 30; // cache misses per IP per second, and the burst

function allow(ip: string): boolean {
  const now = Date.now(), b = buckets.get(ip) ?? { tokens: BURST, at: now };
  b.tokens = Math.min(BURST, b.tokens + ((now - b.at) / 1000) * RATE);
  b.at = now;
  buckets.delete(ip); buckets.set(ip, b);
  if (buckets.size > 50_000) buckets.delete(buckets.keys().next().value!);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

async function render(r: Exclude<Route, null | { redirect: string }>, rpc: Rpc): Promise<Out> {
  try {
    const p = await r.run(rpc);
    if (p.redirect) return { status: 302, body: "", redirect: p.redirect, ttl: r.ttl };
    return { status: p.status, body: page(p.title, p.body, { q: r.q }), ttl: p.immutable ? IMMUTABLE_S : p.status === 200 ? r.ttl : 30 };
  } catch (e) { // logged, never shown (it can carry SQL or an upstream URL)
    console.warn(`[explorer] ${r.key}: ${(e as Error).message}`);
    return { status: 503, body: page("Unavailable", html`<h1>Temporarily unavailable</h1><p>The node or the index did not answer. Try again in a moment.</p>`), ttl: 0 };
  }
}

/** Serves the request and returns true when the path is an explorer page; false leaves it to the API. */
export async function explorer(req: http.IncomingMessage, res: http.ServerResponse, url: URL, rpc: Rpc): Promise<boolean> {
  if (url.pathname === "/static/style.css") {
    res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600", ...SECURITY });
    res.end(CSS); return true;
  }
  if (url.pathname === "/robots.txt") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("User-agent: *\nDisallow: /search\nDisallow: /address/*?\nCrawl-delay: 2\n"); return true;
  }
  if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return true; }
  const r = route(url.pathname, url.searchParams);
  if (!r) return false;
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }); res.end(); return true; }
  if ("redirect" in r) { res.writeHead(301, { location: r.redirect, ...SECURITY }); res.end(); return true; }

  let out: Out | undefined;
  const hit = cache.get(r.key);
  if (hit && hit.until > Date.now()) { cache.delete(r.key); cache.set(r.key, hit); out = hit.out; }
  else {
    let p = inflight.get(r.key);
    if (!p) {
      const ip = String(req.headers["x-real-ip"] ?? req.socket.remoteAddress ?? "");
      if (!allow(ip)) {
        res.writeHead(429, { "content-type": "text/plain", "retry-after": "2", ...SECURITY }); res.end("Too many requests: slow down a little.\n"); return true;
      }
      p = render(r, rpc).finally(() => inflight.delete(r.key));
      inflight.set(r.key, p);
    }
    out = await p;
    if (out.ttl > 0) {
      cache.delete(r.key); cache.set(r.key, { out, until: Date.now() + out.ttl * 1000 });
      if (cache.size > MAX_PAGES) cache.delete(cache.keys().next().value!);
    }
  }
  if (out.redirect) { res.writeHead(302, { location: out.redirect, "cache-control": "no-store", ...SECURITY }); res.end(); return true; }
  res.writeHead(out.status, {
    "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(out.body),
    "cache-control": out.ttl >= IMMUTABLE_S ? "public, max-age=86400, immutable" : `public, max-age=${Math.min(out.ttl, 60)}`, ...SECURITY,
  });
  res.end(req.method === "HEAD" ? undefined : out.body);
  return true;
}
