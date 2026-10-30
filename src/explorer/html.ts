// HTML for the explorer: every interpolated value is escaped unless it is already Html (built by `html` or `raw`),
// so a page can only contain markup we wrote. Formatters are pure.

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

export function page(title: string, body: Html, opts: { q?: string } = {}): string {
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Robinhood Chain explorer</title><link rel="stylesheet" href="/static/style.css">
<meta name="description" content="Robinhood Chain (4663) block explorer served from our own node and indexer."></head>
<body><header><a class="brand" href="/">rh<span>node</span> explorer</a>
<form action="/search" method="get" role="search"><input name="q" value="${opts.q ?? ""}" maxlength="100" placeholder="Block, tx hash, address or token" aria-label="Search" autocomplete="off"><button>Search</button></form></header>
<main>${body}</main>
<footer>Robinhood Chain (4663), read from our own node and ClickHouse index. Open source:
<a href="${REPO}" rel="noopener">github.com/robert-schmidt/rhnode</a> · <a href="/health">status</a></footer>
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
export const when = (unix: number) => html`<time datetime="${new Date(unix * 1000).toISOString()}" title="${utc(unix)}">${ago(unix)}</time>`;
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
