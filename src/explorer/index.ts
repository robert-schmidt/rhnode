// The explorer: server-rendered pages, no script, mounted by the API before its key check (pages are public).
// Requests are validated by route() before anything is queried; rendered pages are cached in memory (a page of a final
// block or tx for a day, live pages for seconds) and concurrent misses for one page share one render. Each client IP
// gets a token bucket for cache misses only, so a cached page costs nothing; nginx limits raw request rates in front.
import type http from "node:http";
import { CSS, CSS_PATH, html, page, REPO, type Html } from "./html.ts";
import { challenge, claim, CODE_PREFIX, codeOf, gated, mint, REPO_NAME, verify } from "./gate.ts";
import { cfg } from "../config.ts";
import { address, block, home, notFound, search, tx, type Page, type Rpc } from "./pages.ts";

const SECURITY = {
  "content-security-policy": "default-src 'none'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
};
const HASH = /^0x[0-9a-fA-F]{64}$/, ADDR = /^0x[0-9a-fA-F]{40}$/, NUM = /^\d{1,12}$/;

type Route = { key: string; ttl: number; q?: string; run: (rpc: Rpc) => Promise<Page> } | { redirect: string } | null;

/** PURE: the page a path asks for, with a cache key made only of validated parts; null = not ours. */
export function route(path: string, qs: URLSearchParams): Route {
  if (path === "/") return { key: "/", ttl: 2, run: (rpc) => home(rpc) };
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
    return { status: p.status, body: page(p.title, p.body, { q: r.q, refresh: p.refresh }), ttl: p.immutable ? IMMUTABLE_S : p.status === 200 ? r.ttl : 30 };
  } catch (e) { // logged, never shown (it can carry SQL or an upstream URL)
    console.warn(`[explorer] ${r.key}: ${(e as Error).message}`);
    return { status: 503, body: page("Unavailable", html`<h1>Temporarily unavailable</h1><p>The node or the index did not answer. Try again in a moment.</p>`), ttl: 0 };
  }
}

/** Serves the request and returns true when the path is an explorer page; false leaves it to the API. */
export async function explorer(req: http.IncomingMessage, res: http.ServerResponse, url: URL, rpc: Rpc): Promise<boolean> {
  if (url.pathname === CSS_PATH || url.pathname === "/static/style.css") {
    res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": url.pathname === CSS_PATH ? "public, max-age=31536000, immutable" : "no-cache", ...SECURITY });
    res.end(CSS); return true;
  }
  if (url.pathname === "/robots.txt") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("User-agent: *\nDisallow: /search\nDisallow: /address/*?\nCrawl-delay: 2\n"); return true;
  }
  if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return true; }
  if (/^\/access(\/claim|\/token)?$/.test(url.pathname)) { await access(req, res, url); return true; }
  const r = route(url.pathname, url.searchParams);
  if (!r) return false;
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }); res.end(); return true; }
  if ("redirect" in r) { res.writeHead(301, { location: r.redirect, ...SECURITY }); res.end(); return true; }
  if (gated() && !verify(cookies(req).rhx)) { res.writeHead(303, { location: "/access", "cache-control": "no-store", ...SECURITY }); res.end(); return true; }

  let out: Out | undefined;
  const hit = cache.get(r.key);
  if (hit && hit.until > Date.now()) { cache.delete(r.key); cache.set(r.key, hit); out = hit.out; }
  else {
    let p = inflight.get(r.key);
    if (!p) {
      if (!allow(ipOf(req))) {
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
    "cache-control": `${gated() ? "private" : "public"}, ${out.ttl >= IMMUTABLE_S ? "max-age=86400, immutable" : `max-age=${Math.min(out.ttl, 60)}`}`, ...SECURITY,
  });
  res.end(req.method === "HEAD" ? undefined : out.body);
  return true;
}

// --- access (gate.ts): the code/token page and its two forms ---

const ipOf = (req: http.IncomingMessage) => String(req.headers["x-real-ip"] ?? req.socket.remoteAddress ?? "");
const cookies = (req: http.IncomingMessage) => Object.fromEntries((req.headers.cookie ?? "").split(";")
  .map((c) => { const i = c.indexOf("="); return [c.slice(0, i).trim(), c.slice(i + 1).trim()]; }));
const cookie = (name: string, v: string, maxAge: number) => `${name}=${v}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
const YEAR = 31_536_000;

function send(res: http.ServerResponse, status: number, title: string, body: Html, setCookies: string[] = []) {
  const s = page(title, body);
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...(setCookies.length ? { "set-cookie": setCookies } : {}), ...SECURITY });
  res.end(s);
}
async function form(req: http.IncomingMessage): Promise<URLSearchParams> {
  let s = "";
  for await (const chunk of req) { s += chunk; if (s.length > 2048) throw new Error("form too large"); }
  return new URLSearchParams(s);
}

function accessPage(code: string, o: { error?: string; token?: string; login?: string | null } = {}): Html {
  const issue = `${REPO}/issues/new?title=${encodeURIComponent("Explorer access")}&body=${encodeURIComponent(`${CODE_PREFIX}${code}\n\nWhat will you use the explorer for? (optional)`)}`;
  return html`<h1>Explorer access</h1>
${o.error ? html`<p class="bad">${o.error}</p>` : ""}
${o.token ? html`<div class="note"><p class="ok">Welcome, @${o.login}: this browser has access now.</p>
<p>Your token, for other browsers and devices. Keep it private: it is tied to your GitHub account.</p>
<p class="mono wrap token">${o.token}</p><p><a href="/">Open the explorer →</a></p></div>`
    : o.login ? html`<p class="ok">This browser has access (@${o.login}). <a href="/">Open the explorer →</a></p>` : ""}
<p>The explorer is free: Robinhood Chain read straight from our own node and index. Access tokens keep it fast for everyone.</p>
<h2>Get a token</h2>
<ol class="steps">
${cfg.explorer.requireStar ? html`<li>Star the repository <a href="${REPO}" rel="noopener" target="_blank">${REPO_NAME}</a>.</li>` : ""}
<li>Open an issue there containing your code <span class="tag">${CODE_PREFIX}${code}</span>: <a href="${issue}" rel="noopener" target="_blank">open it prefilled</a>.</li>
<li>Come back and <form method="post" action="/access/claim" class="inline"><button>get my token</button></form></li>
</ol>
<p class="muted small">The code works only in this browser, for a day. Your token is shown here and never posted on GitHub.</p>
<h2>Have a token?</h2>
<form method="post" action="/access/token" class="row"><input name="token" required maxlength="120" autocomplete="off" spellcheck="false" placeholder="yourlogin.1793360000.…" aria-label="Access token"><button>Use it</button></form>`;
}

async function access(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  if (!gated()) return send(res, 200, "Access", html`<h1>Explorer access</h1><p>This explorer is open: no token needed. <a href="/">Open it →</a></p>`);
  const c = cookies(req), set: string[] = [];
  let code = codeOf(c.rhc);
  const fresh = !code;
  if (!code) { const ch = challenge(); code = ch.code; set.push(cookie("rhc", ch.cookie, 86400)); }
  if (req.method === "GET" || req.method === "HEAD") return send(res, 200, "Access", accessPage(code, { login: verify(c.rhx) }), set);
  if (req.method !== "POST" || url.pathname === "/access") { res.writeHead(405, { allow: "GET, POST" }); res.end(); return; }
  if (!allow(ipOf(req))) { res.writeHead(429, { "content-type": "text/plain", "retry-after": "2", ...SECURITY }); res.end("Too many requests: slow down a little.\n"); return; }
  let f: URLSearchParams;
  try { f = await form(req); } catch { res.writeHead(413); res.end(); return; }
  if (url.pathname === "/access/token") {
    const t = (f.get("token") ?? "").trim();
    if (!verify(t)) return send(res, 401, "Access", accessPage(code, { error: "That token is not valid (or was withdrawn)." }), set);
    res.writeHead(303, { location: "/", "set-cookie": [...set, cookie("rhx", t, YEAR)], "cache-control": "no-store", ...SECURITY });
    res.end(); return;
  }
  if (fresh) return send(res, 400, "Access", accessPage(code, { error: "This browser had no code yet (cookies off, or it expired). Here is a new one: put it in your issue." }), set);
  let r: Awaited<ReturnType<typeof claim>>;
  try { r = await claim(code); } catch (e) {
    console.warn(`[explorer] access claim: ${(e as Error).message}`);
    r = { error: "GitHub didn't answer just now. Try again in a few minutes." };
  }
  if ("error" in r) return send(res, 200, "Access", accessPage(code, { error: r.error }), set);
  const token = mint(r.login);
  console.log(`[explorer] access token minted for @${r.login}`);
  send(res, 200, "Access", accessPage(code, { token, login: r.login }), [cookie("rhx", token, YEAR), cookie("rhc", "", 0)]);
}
