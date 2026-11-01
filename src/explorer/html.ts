// HTML for the explorer: every interpolated value is escaped unless it is already Html (built by `html` or `raw`),
// so a page can only contain markup we wrote. Formatters are pure.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cfg } from "../config.ts";

/** The stylesheet, served at a content-hashed URL so a new version never meets a cached old one. */
export const CSS = readFileSync(new URL("./style.css", import.meta.url));
export const CSS_PATH = `/static/style.${createHash("sha256").update(CSS).digest("hex").slice(0, 10)}.css`;
/** live.js, on every page: the search box's hint, and on the home page the live feed and the charts' readout. The only
 *  script; pages work without it. */
export const JS = readFileSync(new URL("./live.js", import.meta.url));
export const JS_PATH = `/static/live.${createHash("sha256").update(JS).digest("hex").slice(0, 10)}.js`;

export class Html { readonly s: string; constructor(s: string) { this.s = s; } toString() { return this.s; } }
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
/** Trusted markup only (our own constants). Never pass request or chain data through it. */
export const raw = (s: string) => new Html(s);

function part(v: unknown): string {
  if (v instanceof Html) return v.s;
  if (Array.isArray(v)) return v.map(part).join("");
  if (v === null || v === undefined || v === false) return "";
  return esc(v);
}
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let s = strings[0];
  values.forEach((v, i) => { s += part(v) + strings[i + 1]; });
  return new Html(s);
}

export const REPO = "https://github.com/robert-schmidt/rhnode";

export function page(title: string, body: Html, opts: { q?: string; refresh?: number; live?: boolean } = {}): string {
  const refresh = opts.refresh ? html`<meta http-equiv="refresh" content="${opts.refresh}">` : "";
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${opts.live ? html`<noscript>${refresh}</noscript>` : refresh}
<title>${title} · Robinhood Chain Explorer</title><link rel="stylesheet" href="${CSS_PATH}"><script src="${JS_PATH}" defer></script>
<meta name="description" content="Robinhood Chain (4663) block explorer served from our own node and indexer."></head>
<body><header><div class="bar"><a class="brand" href="/">Robinhood <span>Chain</span> Explorer</a>
<form action="/search" method="get" role="search"><input name="q" value="${opts.q ?? ""}" maxlength="100" placeholder="Block, tx hash, address or token" aria-label="Search" autocomplete="off" enterkeyhint="search"><button>Search</button></form></div></header>
<main>${body}</main>
<footer>Robinhood Chain (4663), read from our own node and ClickHouse index. An independent explorer, not affiliated with Robinhood.
${cfg.explorer.credit ? html`<a href="${cfg.explorer.credit.url}" rel="noopener">${cfg.explorer.credit.text}</a> · ` : ""}Open source:
<a href="${REPO}" rel="noopener">${REPO.replace("https://", "")}</a> · <a href="/access">access</a> · <a href="/health">status</a></footer>
</body></html>`.s;
}

// --- formatters (PURE) ---

export const short = (h: string, n = 8) => (h.length > 2 * n + 2 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h);
export const link = (kind: "block" | "tx" | "address", id: string | number, text?: string) =>
  html`<a class="mono" href="/${kind}/${String(id)}">${text ?? (kind === "block" ? Number(id).toLocaleString("en-US") : short(String(id)))}</a>`;

/** A raw integer amount with `decimals`, at most `max` fraction digits, thousands separated. */
export function units(v: bigint | string | number, decimals: number, max = 6): string {
  let n = BigInt(v);
  const neg = n < 0n; if (neg) n = -n;
  const d = BigInt(Math.max(0, decimals)), base = 10n ** d;
  const int = (n / base).toLocaleString("en-US");
  const frac = decimals > 0 ? (n % base).toString().padStart(decimals, "0").slice(0, max).replace(/0+$/, "") : "";
  const out = frac ? `${int}.${frac}` : int;
  return (neg ? "-" : "") + (out === "0" && n > 0n ? `<0.${"0".repeat(max - 1)}1` : out);
}
export const eth = (wei: bigint | string | number) => `${units(wei, 18)} ETH`;

export function ago(unix: number, now = Date.now() / 1000): string {
  const s = Math.max(0, Math.round(now - unix));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export const utc = (unix: number) => new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
/** The block time in UTC, date and time, its age on hover. */
export const when = (unix: number, now = Date.now() / 1000) =>
  html`<time datetime="${new Date(unix * 1000).toISOString()}" title="${ago(unix, now)}">${utc(unix).slice(0, 19)}</time>`;
/** Its age, kept current by live.js (data-ts); the UTC time on hover. */
export const age = (unix: number, now = Date.now() / 1000) => html`<time class="age" data-ts="${unix}" datetime="${new Date(unix * 1000).toISOString()}" title="${utc(unix)}">${ago(unix, now)}</time>`;
/** The time of day in UTC, then its age (kept current by live.js): "18:51:03 UTC · 3 s ago"; the full date on hover. */
export const stamp = (unix: number, now = Date.now() / 1000) =>
  html`<span class="hms" title="${utc(unix)}">${utc(unix).slice(11)}</span> · ${age(unix, now)}`;
/** A raw integer amount, short for a glance: 46.01M, 3,091.94, 12.3457, 0.0342, <0.0001. */
export function compact(v: bigint | string | number, decimals: number): string {
  const n = Number(BigInt(v)) / 10 ** Math.max(0, decimals);
  if (n >= 1e6) return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 2 : 4 });
  if (n >= 0.0001) return n.toLocaleString("en-US", { maximumSignificantDigits: 3 });
  return n > 0 ? "<0.0001" : "0";
}
export const usd = (v: number) => (v >= 1 ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : v > 0 ? `$${v.toPrecision(4)}` : "$0");

/** An inline SVG line chart (no script): points [t, v], width 100%. */
export function sparkline(points: [number, number][], h = 120): Html {
  if (points.length < 2) return html`<p class="muted">Not enough trades for a chart yet.</p>`;
  const W = 600, xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const x = (t: number) => ((t - x0) / (x1 - x0 || 1)) * W, y = (v: number) => h - 4 - ((v - y0) / (y1 - y0 || 1)) * (h - 8);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  return html`<svg class="chart" viewBox="0 0 ${W} ${h}" preserveAspectRatio="none" role="img" aria-label="price chart"><path d="${d}"/></svg>
<p class="muted small">low ${usd(y0)} · high ${usd(y1)} · ${utc(x0)} to ${utc(x1)}</p>`;
}
