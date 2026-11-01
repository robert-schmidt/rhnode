// The home page's "Chain over time" charts: agg_chain_hourly (migration 027), read at most every 5 minutes per range and
// drawn here as SVG (labels in the SVG: the CSP allows no inline styles). live.js adds the hover readout; without it the
// table under each chart has every value.
import { rows } from "../ch.ts";
import { html, type Html } from "./html.ts";

export const RANGES = { "24h": { label: "24 hours", secs: 86_400 }, "7d": { label: "7 days", secs: 7 * 86_400 }, all: { label: "All time", secs: 0 } } as const;
export type Range = keyof typeof RANGES;

export type Bucket = { t: number; secs: number; blocks: number; gas: number; bf: number; txs: number; head: number; failed: number; fees: number; gp: number[]; senders: number };

async function load(range: Range): Promise<{ step: number; b: Bucket[] }> {
  const secs = RANGES[range].secs;
  const [span] = await rows<{ a: number; z: number }>("SELECT toUnixTimestamp(min(hour)) AS a, toUnixTimestamp(max(hour)) AS z FROM agg_chain_hourly WHERE blocks != 0 OR txs != 0");
  const from = secs ? Math.max(Number(span?.a ?? 0), Math.floor(Date.now() / 1000) - secs) : Number(span?.a ?? 0);
  const step = Number(span?.z ?? 0) - from > 21 * 86_400 ? 86_400 : 3_600; // hourly up to 3 weeks, then daily
  const r = await rows<{ t: number; a: number | null; z: number | null; n_blocks: string; n_gas: string; n_bf: string; n_txs: string; n_head: string; n_failed: string; n_fees: string; gp: number[]; n_senders: string }>(
    `SELECT toUnixTimestamp(toStartOfInterval(hour, toIntervalSecond({step:UInt32}))) AS t, toUnixTimestamp(min(t0)) AS a, toUnixTimestamp(max(t1)) AS z,
       sum(blocks) AS n_blocks, sum(gas_used) AS n_gas, sum(base_fee_sum) AS n_bf, sum(txs) AS n_txs, sum(head_txs) AS n_head, sum(failed) AS n_failed,
       toString(sum(fees)) AS n_fees, quantilesTDigestMerge(0.1, 0.5, 0.9)(gas_price) AS gp, uniqMerge(senders) AS n_senders
     FROM agg_chain_hourly WHERE hour >= toDateTime({from:UInt32}) GROUP BY t HAVING n_blocks > 0 ORDER BY t`, { step, from });
  return { step, b: r.map((x) => ({
    t: x.t, secs: x.a != null && x.z != null ? Math.max(1, Math.min(step, x.z - x.a + 1)) : step, blocks: Number(x.n_blocks), gas: Number(x.n_gas),
    bf: Number(x.n_bf), txs: Number(x.n_txs), head: Number(x.n_head), failed: Number(x.n_failed), fees: Number(BigInt(x.n_fees)) / 1e18, gp: x.gp, senders: Number(x.n_senders),
  })) };
}

const memo = new Map<Range, { at: number; p: Promise<Html> }>();
/** The charts for a range, rebuilt at most every 5 minutes (the hour in progress moves; older ones don't). */
export function chainCharts(range: Range): Promise<Html> {
  const m = memo.get(range);
  if (m && Date.now() - m.at < 300_000) return m.p;
  const p = load(range).then(({ step, b }) => render(range, step, b));
  memo.set(range, { at: Date.now(), p });
  p.catch(() => memo.delete(range));
  return p;
}

// --- drawing ---

const W = 480, H = 200, L = 46, R = 10, T = 12, B = 24; // plot box inside the viewBox
const fix = (v: number) => v.toFixed(1);

/** Up to ~4 round ticks covering [lo, hi]. */
export function ticks(lo: number, hi: number): number[] {
  if (!(hi > lo)) hi = lo + (lo ? Math.abs(lo) * 0.1 : 1);
  const raw = (hi - lo) / 4, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  if (out.at(-1)! < hi) out.push(Number((out.at(-1)! + step).toPrecision(12)));
  return out;
}

const DAY = 86_400;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (t: number) => { const d = new Date(t * 1000); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`; };
const hourLabel = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);
/** Time ticks at whole hours or days, at most ~6. */
function timeTicks(a: number, z: number): { t: number; label: string }[] {
  const steps = [3_600, 3 * 3_600, 6 * 3_600, 12 * 3_600, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];
  const s = steps.find((x) => (z - a) / x <= 6) ?? 30 * DAY;
  const out = [];
  for (let t = Math.ceil(a / s) * s; t <= z; t += s) out.push({ t, label: s >= DAY || t % DAY === 0 ? dayLabel(t) : hourLabel(t) });
  return out;
}

type Series = { title: string; note: string; v: (b: Bucket) => number; fmt: (v: number) => string; tick?: (v: number) => string; band?: (b: Bucket) => [number, number]; zero: boolean; detail?: true };

function plot(s: Series, b: Bucket[], step: number): Html {
  // senders and failures need the txs themselves: only hours with none from headers (before go-live, migration 028)
  const pts = b.filter((x) => !s.detail || x.head === 0).map((x) => ({ t: x.t, v: s.v(x), band: s.band?.(x) }));
  const t0 = b[0].t, t1 = b.at(-1)!.t;
  if (!pts.length) return html``;
  const vals = pts.flatMap((p) => (p.band ? [p.v, ...p.band] : [p.v])).filter(Number.isFinite);
  const lo0 = s.zero ? 0 : Math.min(...vals), hi0 = Math.max(...vals);
  const pad = s.zero ? 0 : (hi0 - lo0 || hi0 * 0.01 || 1) * 0.15;
  const ys = ticks(s.zero ? 0 : lo0 - pad, hi0 + pad), lo = ys[0], hi = ys.at(-1)!;
  const x = (t: number) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R), y = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${fix(x(p.t))},${fix(y(p.v))}`).join("");
  const area = s.zero ? `${line}L${fix(x(t1))},${fix(y(lo))}L${fix(x(t0))},${fix(y(lo))}Z` : "";
  const band = s.band ? pts.map((p, i) => `${i ? "L" : "M"}${fix(x(p.t))},${fix(y(p.band![1]))}`).join("")
    + pts.slice().reverse().map((p) => `L${fix(x(p.t))},${fix(y(p.band![0]))}`).join("") + "Z" : "";
  const when = (t: number) => (step >= DAY ? dayLabel(t) : `${dayLabel(t)} ${hourLabel(t)} UTC`);
  // the hover readout's data: x in viewBox units, then the labels it shows (live.js puts them in with textContent)
  const data = JSON.stringify(pts.map((p) => [Math.round(x(p.t) * 10) / 10, Math.round(y(p.v) * 10) / 10, when(p.t), s.fmt(p.v), p.band ? `${s.fmt(p.band[0])} – ${s.fmt(p.band[1])}` : ""]));
  const last = pts.at(-1)!;
  return html`<figure class="ch">
<figcaption><span>${s.title}</span><b>${s.fmt(last.v)}</b><small>${s.note}</small></figcaption>
<div class="plot"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${s.title}, ${when(t0)} to ${when(t1)}" tabindex="0" data-pts="${data}">
${ys.map((v) => html`<line class="grid" x1="${L}" x2="${W - R}" y1="${fix(y(v))}" y2="${fix(y(v))}"/><text class="ytick" x="${L - 6}" y="${fix(y(v) + 4)}">${(s.tick ?? s.fmt)(v)}</text>`)}
${timeTicks(t0, t1).map((k) => html`<text class="xtick" x="${fix(x(k.t))}" y="${H - 6}">${k.label}</text>`)}
${band ? html`<path class="band" d="${band}"/>` : ""}${area ? html`<path class="area" d="${area}"/>` : ""}<path class="line" d="${line}"/>
<circle class="end" cx="${fix(x(last.t))}" cy="${fix(y(last.v))}" r="4"/>
<line class="xh" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/><circle class="dot" r="4" visibility="hidden"/>
</svg><div class="tip" hidden><b></b><span></span><small></small></div></div>
<details><summary>Table</summary><div class="tw"><table><tr><th>${step >= DAY ? "Day" : "Hour"} (UTC)</th><th class="num">${s.title}</th>${s.band ? html`<th class="num">p10 – p90</th>` : ""}</tr>
${pts.slice().reverse().map((p) => html`<tr><td>${when(p.t)}</td><td class="num">${s.fmt(p.v)}</td>${p.band ? html`<td class="num">${s.fmt(p.band[0])} – ${s.fmt(p.band[1])}</td>` : ""}</tr>`)}
</table></div></details></figure>`;
}

const per = (step: number) => (step >= DAY ? "day" : "hour");
const num = (d: number) => (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const compactN = (v: number) => v.toLocaleString("en-US", { notation: v >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 });
const gwei = (v: number) => `${v.toPrecision(4)} gwei`; // 0.02004: the price moves in the 4th digit

export function render(range: Range, step: number, b: Bucket[]): Html {
  const nav = html`<nav class="seg" aria-label="Chart range">${Object.entries(RANGES).map(([k, r]) =>
    k === range ? html`<b aria-current="true">${r.label}</b>` : html`<a href="/?range=${k}#chain">${r.label}</a>`)}</nav>`;
  if (b.length < 2) return html`<section id="chain"><h2>Chain over time</h2>${nav}<p class="muted">Not enough history yet: the charts start after the first full hours of indexing.</p></section>`;
  const series: Series[] = [
    { title: "Transactions per second", note: `average per ${per(step)}`, v: (x) => (x.txs + x.head) / x.secs, fmt: num(1), zero: true },
    { title: "Gas price", note: "gwei, median paid; band: p10 – p90", v: (x) => x.gp[1] / 1e9, band: (x) => [x.gp[0] / 1e9, x.gp[2] / 1e9], fmt: gwei, tick: (v) => `${+v.toPrecision(4)}`, zero: false },
    { title: "Active senders", note: `distinct senders per ${per(step)}`, v: (x) => x.senders, fmt: compactN, zero: true, detail: true },
    { title: "Gas used", note: "Mgas per second", v: (x) => x.gas / x.secs / 1e6, fmt: num(1), zero: true },
    { title: "Fees paid", note: `ETH per ${per(step)}`, v: (x) => x.fees, fmt: (v) => `${v.toPrecision(3)} ETH`, tick: (v) => `${+v.toPrecision(3)}`, zero: true },
    { title: "Failed transactions", note: "share of user txs", v: (x) => (x.txs ? (x.failed / x.txs) * 100 : 0), fmt: (v) => `${v.toFixed(1)}%`, zero: true, detail: true },
  ];
  return html`<section id="chain"><h2>Chain over time</h2>${nav}
<div class="charts">${series.map((s) => plot(s, b, step))}</div>
<p class="muted small">From our node and index, ${step >= DAY ? "per day" : "per hour"} (UTC); the last point is still filling. Before go-live (Oct 29) from block headers, so senders and failures start there.</p></section>`;
}
