// Explorer pages. Blocks, txs and receipts come from the node (the permanent archive, through the caller's cached
// JSON-RPC); lists, tokens, pools and prices from ClickHouse (14 days raw, kept_* and agg_* forever).
// Every id reaching a query has passed the regexes in index.ts, and every query takes bound parameters.
import { rows } from "../ch.ts";
import { ago, eth, html, link, short, sparkline, units, usd, utc, when, type Html } from "./html.ts";
import { bare, lookup, methods } from "./names.ts";
import { requested } from "../watch.ts";
import { cards, NET24 } from "../cards.ts";
import { earlyBuyers } from "../early.ts";
import { PROTOCOL } from "../chain/protocol.ts";
import { NATIVE_ETH, USDG, WETH } from "../chain/constants.ts";

export type Rpc = (method: string, params: unknown[]) => Promise<{ result?: unknown; error?: { message: string } }>;
export type Page = { status: number; title: string; body: Html; immutable?: boolean; redirect?: string; refresh?: number };

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x" + "0".repeat(40);
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"; // EIP-1967
const DEEP = 64; // blocks below the head that we treat as final
// a log's data can be "0x" or longer than one word on non-standard tokens: the first word, or 0
const big = (h: unknown) => { const s = (h as string) ?? ""; return s.length > 2 ? BigInt(s.slice(0, 66)) : 0n; };
const num = (h: unknown) => Number(big(h));

async function call<T>(rpc: Rpc, method: string, params: unknown[]): Promise<T> {
  const r = await rpc(method, params);
  if (r.error) throw new Error(`node: ${r.error.message}`);
  return r.result as T;
}
export async function headBlock(): Promise<number> {
  return Number((await rows<{ b: string }>("SELECT max(block) AS b FROM ctl_cursors FINAL WHERE name = 'tip'"))[0]?.b ?? 0);
}
type Token = { token: string; name: string; symbol: string; decimals: number; supply: string; holder_count: string; complete: number };
async function tokens(addrs: string[]): Promise<Map<string, Token>> {
  if (!addrs.length) return new Map();
  const r = await rows<Token>("SELECT token, name, symbol, decimals, toString(total_supply) AS supply, holder_count, complete FROM serve_tokens FINAL WHERE token IN {a:Array(String)}", { a: [...new Set(addrs)] });
  return new Map(r.map((t) => [t.token, t]));
}
const sym = (t: Token | undefined, a: string) => (t?.symbol ? t.symbol.slice(0, 24) : short(a, 4));
/** The method's name when it could be checked against the called contract (names.ts), else its selector. */
const method = (to: string | null, input: string, names: Map<string, string>) => {
  if (!input || input === "0x") return "transfer";
  const s = input.slice(0, 10).toLowerCase(), n = to ? names.get(`${to.toLowerCase()}:${s}`) : undefined;
  return n ? bare(n) : s;
};
/** Most calls send no ETH: what they move is tokens (the Moved column). */
const value = (wei: bigint | string) => (BigInt(wei) === 0n ? html`<span class="muted">0</span>` : eth(wei));

type Move = { token: string; amount: bigint; nft: boolean };
const movesOf = (logs: Log[]): Move[] => logs.filter((l) => l.topics[0] === TRANSFER && l.topics.length >= 3)
  .map((l) => ({ token: l.address.toLowerCase(), amount: l.topics.length === 4 ? 1n : big(l.data), nft: l.topics.length === 4 }));
function moved(ms: Move[], meta: Map<string, Token>): Html {
  if (!ms.length) return html`<span class="muted">—</span>`;
  const one = (m: Move) => { const t = meta.get(m.token); return html`${m.nft ? "1 NFT" : t ? units(m.amount, t.decimals, 4) : m.amount.toString()} ${link("address", m.token, sym(t, m.token))}`; };
  return html`${ms.slice(0, 2).map((m, i) => html`${i ? ", " : ""}${one(m)}`)}${ms.length > 2 ? html` <span class="muted small">+${ms.length - 2} more</span>` : ""}`;
}
export const notFound = (what: string): Page => ({ status: 404, title: "Not found", body: html`<h1>Not found</h1><p>${what}</p>` });

// --- home ---

// Network numbers over the last minute, 15 minutes, hour and day; ~0.4 s of ClickHouse, so computed at most every 15 s.
const WINDOWS = [60, 900, 3600, 86400];
type Stats = { table: Html; tiles: Html };
let statsMemo: { at: number; p: Promise<Stats> } | null = null;
function stats(): Promise<Stats> {
  if (!statsMemo || Date.now() - statsMemo.at > 15_000) {
    statsMemo = { at: Date.now(), p: computeStats() };
    statsMemo.p.catch(() => { statsMemo = null; });
  }
  return statsMemo.p;
}
async function computeStats(): Promise<Stats> {
  const T1 = "(SELECT max(time) FROM raw_blocks WHERE time > now() - INTERVAL 1 HOUR)";
  const [bs, ts, [px]] = await Promise.all([
    rows<{ w: number; blocks: string; gas: string; bf: number; a: number; b: number }>(
      `SELECT w, count() AS blocks, sum(gas_used) AS gas, avg(base_fee) AS bf, toUnixTimestamp(min(time)) AS a, toUnixTimestamp(max(time)) AS b
       FROM raw_blocks ARRAY JOIN {ws:Array(UInt32)} AS w WHERE time > now() - INTERVAL 25 HOUR AND sign = 1 AND time > ${T1} - w
       GROUP BY w ORDER BY w`, { ws: WINDOWS }),
    rows<{ w: number; n: string; failed: string; senders: string; creates: string; gp50: number; gp90: number; fees: string }>(
      `SELECT w, count() AS n, countIf(status = 0 AND type != 106) AS failed, uniq(\`from\`) AS senders, countIf(created != '') AS creates,
         quantileIf(0.5)(effective_gas_price, type != 106) AS gp50, quantileIf(0.9)(effective_gas_price, type != 106) AS gp90,
         toString(sum(toUInt256(gas_used) * effective_gas_price)) AS fees
       FROM raw_txs ARRAY JOIN {ws:Array(UInt32)} AS w WHERE time > now() - INTERVAL 25 HOUR AND sign = 1 AND time > ${T1} - w
       GROUP BY w ORDER BY w`, { ws: WINDOWS }),
    rows<{ eth: number }>(`SELECT argMaxMerge(close_usd) AS eth FROM agg_candles_1m WHERE token = {z:String} AND minute > now() - INTERVAL 10 MINUTE
       GROUP BY pool ORDER BY sum(volume_usd) DESC LIMIT 1`, { z: ZERO }),
  ]);
  const cols = WINDOWS.map((w) => {
    const b = bs.find((x) => x.w === w), t = ts.find((x) => x.w === w);
    const span = b ? Math.max(1, b.b - b.a + 1) : 0, n = Number(t?.n ?? 0), fees = BigInt(t?.fees ?? "0");
    return { w, b, t, span, n, fees };
  });
  const label = (w: number, span: number) => (w >= 86400 && span < w - 600 ? `${w / 3600} h (have ${Math.round(span / 3600)} h)` : w >= 3600 ? `${w / 3600} h` : `${w / 60} min`);
  const gwei = (wei: number) => `${(wei / 1e9).toPrecision(3)} gwei`;
  const ethUsd = px?.eth ?? 0;
  const feeEth = (wei: bigint) => Number(wei) / 1e18;
  const row = (name: string, f: (c: (typeof cols)[number]) => unknown) => html`<tr><th>${name}</th>${cols.map((c) => html`<td>${c.b && c.t ? f(c) : "—"}</td>`)}</tr>`;
  const m1 = cols[0], h1 = cols[2];
  const tile = (v: unknown, k: string) => html`<div><b>${v}</b><span>${k}</span></div>`;
  const tiles = m1.b && m1.t && h1.b && h1.t ? html`${tile((m1.n / m1.span).toFixed(1), "tx/s, last minute")}
${tile(`${((m1.span / Number(m1.b.blocks)) * 1000).toFixed(0)} ms`, "block time")}
${tile(gwei(m1.t.gp50), "gas price (median)")}
${tile(ethUsd ? usd(ethUsd) : "?", "ETH, from on-chain pools")}
${tile(ethUsd ? usd(feeEth(h1.fees) * ethUsd) : `${feeEth(h1.fees).toFixed(3)} ETH`, "fees paid, last hour")}` : html``;
  return { tiles, table: html`<h2>Network <span class="muted small">(from our index; ETH ${ethUsd ? usd(ethUsd) : "?"} from on-chain pools)</span></h2>
<div class="tw"><table class="stats-table"><tr><th></th>${cols.map((c) => html`<th>${label(c.w, c.span)}</th>`)}</tr>
${row("Transactions", (c) => c.n.toLocaleString("en-US"))}
${row("Tx per second", (c) => (c.n / c.span).toFixed(1))}
${row("Block time", (c) => `${((c.span / Number(c.b!.blocks)) * 1000).toFixed(0)} ms`)}
${row("Gas per second", (c) => `${(Number(c.b!.gas) / c.span / 1e6).toFixed(1)} Mgas`)}
${row("Gas price (median / p90)", (c) => `${gwei(c.t!.gp50)} / ${gwei(c.t!.gp90)}`)}
${row("Base fee (avg)", (c) => gwei(c.b!.bf))}
${row("Fees paid", (c) => `${feeEth(c.fees).toFixed(4)} ETH${ethUsd ? ` (${usd(feeEth(c.fees) * ethUsd)})` : ""}`)}
${row("Avg fee per tx", (c) => (ethUsd && c.n ? `$${((feeEth(c.fees) / c.n) * ethUsd).toFixed(5)}` : `${(feeEth(c.fees) / Math.max(1, c.n)).toExponential(2)} ETH`))}
${row("Failed", (c) => `${((Number(c.t!.failed) / Math.max(1, c.n)) * 100).toFixed(1)}%`)}
${row("Active senders", (c) => Number(c.t!.senders).toLocaleString("en-US"))}
${row("Contracts created", (c) => Number(c.t!.creates).toLocaleString("en-US"))}
</table></div>` };
}

export async function home(rpc: Rpc): Promise<Page> {
  const head = await headBlock();
  const [blocks, txs, net] = await Promise.all([
    rows<{ number: string; hash: string; ts: number; tx_count: number; gas_used: string }>(
      `SELECT number, hash, toUnixTimestamp(time) AS ts, tx_count, gas_used FROM raw_blocks
       WHERE number > {lo:UInt64} AND sign = 1 ORDER BY number DESC LIMIT 15`, { lo: head - 200 }),
    rows<{ hash: string; block: string; from: string; to: string; v: string; selector: string; status: number; created: string; ts: number }>(
      `SELECT hash, block, \`from\`, \`to\`, toString(value) AS v, selector, status, created, toUnixTimestamp(time) AS ts FROM raw_txs
       WHERE block > {lo:UInt64} AND sign = 1 AND type != 106 ORDER BY block DESC, tx_index DESC LIMIT 15`, { lo: head - 50 }),
    stats().catch((): Stats => ({ tiles: html``, table: html`<p class="muted">Network numbers are unavailable right now.</p>` })),
  ]);
  const [names, mv] = await Promise.all([
    methods(rpc, txs.map((t) => ({ to: t.to || null, input: t.created ? "" : t.selector }))),
    rows<{ tx_hash: string; token: string; amt: string; standard: string }>(
      `SELECT tx_hash, token, toString(amount) AS amt, standard FROM ev_transfers
       WHERE block > {lo:UInt64} AND tx_hash IN {h:Array(String)} AND sign = 1 ORDER BY log_index`, { lo: head - 60, h: txs.map((t) => t.hash) }),
  ]);
  const meta = await tokens(mv.map((m) => m.token));
  const movesBy = new Map<string, Move[]>();
  for (const m of mv) movesBy.set(m.tx_hash, [...(movesBy.get(m.tx_hash) ?? []), { token: m.token, amount: BigInt(m.amt), nft: m.standard !== "erc20" }]);
  return { status: 200, title: "Latest blocks and transactions", refresh: 10, body: html`
<h1>Robinhood Chain</h1>
<div class="stats"><div><b>${link("block", head)}</b><span>latest indexed block</span></div>${net.tiles}</div>
<div class="cols"><section><h2>Latest blocks</h2><div class="tw"><table><tr><th>Block</th><th>Time (UTC)</th><th class="num">Txs</th><th class="num">Gas used</th></tr>
${blocks.map((b) => html`<tr><td>${link("block", b.number)}</td><td>${when(b.ts)}<span class="sub">${ago(b.ts)}</span></td><td class="num">${b.tx_count}</td><td class="num">${Number(b.gas_used).toLocaleString("en-US")}</td></tr>`)}
</table></div></section>
<section><h2>Latest transactions</h2><div class="tw"><table><tr><th>Tx</th><th>From / To</th><th>Moved</th><th class="num">Value</th></tr>
${txs.map((t) => html`<tr${t.status ? "" : html` class="failed"`}><td>${link("tx", t.hash)}<span class="sub"><span class="tag">${method(t.to || null, t.created ? "" : t.selector, names)}</span> ${when(t.ts)}</span></td>
<td>${link("address", t.from)}<span class="sub">→ ${t.created ? link("address", t.created, "new contract") : t.to ? link("address", t.to) : "—"}</span></td>
<td class="moved">${moved(movesBy.get(t.hash) ?? [], meta)}</td><td class="num">${value(t.v)}</td></tr>`)}
</table></div></section></div>
${net.table}
<p class="muted small">This page refreshes every 10 s. Failed transactions are dimmed.</p>` };
}

// --- block ---

type RpcTx = { hash: string; from: string; to: string | null; value: string; input: string; nonce: string; gas: string; transactionIndex: string; type: string };
type RpcBlock = { number: string; hash: string; parentHash: string; timestamp: string; gasUsed: string; gasLimit: string; baseFeePerGas?: string; l1BlockNumber?: string; transactions: RpcTx[]; size?: string };

export async function block(rpc: Rpc, id: string): Promise<Page> {
  const b = id.startsWith("0x")
    ? await call<RpcBlock | null>(rpc, "eth_getBlockByHash", [id, true])
    : await call<RpcBlock | null>(rpc, "eth_getBlockByNumber", ["0x" + BigInt(id).toString(16), true]);
  if (!b) return notFound(`No block ${id} (yet).`);
  const n = num(b.number), ts = num(b.timestamp);
  const [head, names, receipts] = await Promise.all([
    headBlock(), methods(rpc, b.transactions),
    call<Receipt[] | null>(rpc, "eth_getBlockReceipts", [b.number]).catch(() => null),
  ]);
  const rc = new Map((receipts ?? []).map((r) => [r.transactionHash.toLowerCase(), r]));
  const meta = await tokens((receipts ?? []).flatMap((r) => movesOf(r.logs).map((m) => m.token)));
  return { status: 200, title: `Block ${n.toLocaleString("en-US")}`, immutable: n < head - DEEP, body: html`
<h1>Block <span class="mono">${n.toLocaleString("en-US")}</span></h1>
<nav class="pager">${n > 0 ? link("block", n - 1, "← previous") : ""} ${n < head ? link("block", n + 1, "next →") : ""}</nav>
<dl><dt>Hash</dt><dd class="mono">${b.hash}</dd><dt>Parent</dt><dd>${n > 0 ? link("block", b.parentHash, b.parentHash) : "—"}</dd>
<dt>Timestamp</dt><dd>${utc(ts)} <span class="muted small">(unix ${ts}; whole seconds, so ~10 blocks share one)</span></dd><dt>Transactions</dt><dd>${b.transactions.length}</dd>
<dt>Gas used</dt><dd>${num(b.gasUsed).toLocaleString("en-US")} of ${num(b.gasLimit).toLocaleString("en-US")}</dd>
${b.baseFeePerGas ? html`<dt>Base fee</dt><dd>${units(big(b.baseFeePerGas), 9, 4)} gwei</dd>` : ""}
${b.l1BlockNumber ? html`<dt>L1 block</dt><dd>${num(b.l1BlockNumber).toLocaleString("en-US")}</dd>` : ""}</dl>
<h2>Transactions</h2><div class="tw"><table><tr><th>#</th><th>Tx</th><th>Method</th><th>From</th><th>To</th><th>Moved</th><th>Value</th></tr>
${b.transactions.map((t) => { const r = rc.get(t.hash.toLowerCase()), sys = t.type === "0x6a";
  return html`<tr${r && num(r.status) !== 1 && !sys ? html` class="failed"` : ""}><td>${num(t.transactionIndex)}</td><td>${link("tx", t.hash)}</td>
<td><span class="tag">${sys ? "ArbOS block start" : t.to ? method(t.to, t.input, names) : "create"}</span></td>
<td>${link("address", t.from)}</td><td>${t.to ? link("address", t.to) : "—"}</td><td>${r ? moved(movesOf(r.logs), meta) : ""}</td><td>${value(big(t.value))}</td></tr>`; })}</table></div>
<p class="muted small">Value is the ETH a transaction sends; most are contract calls that send none and move tokens instead (Moved). Failed ones are dimmed.</p>` };
}

// --- tx ---

type Log = { address: string; topics: string[]; data: string; logIndex: string };
type Receipt = { transactionHash: string; status: string; blockNumber: string; gasUsed: string; effectiveGasPrice?: string; contractAddress: string | null; logs: Log[]; gasUsedForL1?: string };

export async function tx(rpc: Rpc, hash: string): Promise<Page> {
  const [t, r] = await Promise.all([
    call<(RpcTx & { blockNumber: string | null; gasPrice?: string }) | null>(rpc, "eth_getTransactionByHash", [hash]),
    call<Receipt | null>(rpc, "eth_getTransactionReceipt", [hash]),
  ]);
  if (!t) return notFound(`No transaction ${hash}.`);
  if (!r || !t.blockNumber) return { status: 200, title: "Pending transaction", body: html`<h1>Transaction</h1><p class="mono">${hash}</p><p>Pending: not in a block yet.</p>` };
  const n = num(t.blockNumber), head = await headBlock();
  const b = await call<{ timestamp: string } | null>(rpc, "eth_getBlockByNumber", [t.blockNumber, false]);
  const ts = b ? num(b.timestamp) : 0;
  const transfers = r.logs.filter((l) => l.topics[0] === TRANSFER && l.topics.length >= 3);
  const [meta, names, checked] = await Promise.all([
    tokens(transfers.map((l) => l.address.toLowerCase())),
    lookup(r.logs.map((l) => l.topics[0]).filter(Boolean)),
    methods(rpc, [t]),
  ]);
  const sig = t.to ? checked.get(`${t.to.toLowerCase()}:${t.input.slice(0, 10).toLowerCase()}`) : undefined;
  const fee = big(r.gasUsed) * big(r.effectiveGasPrice ?? t.gasPrice ?? "0x0");
  const ok = num(r.status) === 1;
  const addr = (topic: string) => "0x" + topic.slice(26);
  return { status: 200, title: `Tx ${short(hash)}`, immutable: n < head - DEEP, body: html`
<h1>Transaction</h1>
<dl><dt>Hash</dt><dd class="mono">${hash}</dd>
<dt>Status</dt><dd>${ok ? html`<span class="ok">Success</span>` : html`<span class="bad">Failed</span>`}</dd>
<dt>Block</dt><dd>${link("block", n)}${ts ? html` · ${utc(ts)}` : ""}</dd>
<dt>From</dt><dd>${link("address", t.from, t.from)}</dd>
<dt>To</dt><dd>${t.to ? link("address", t.to, t.to) : r.contractAddress ? html`${link("address", r.contractAddress, r.contractAddress)} (created)` : "—"}</dd>
<dt>Method</dt><dd><span class="tag">${t.type === "0x6a" ? "ArbOS block start" : t.to ? method(t.to, t.input, checked) : "create"}</span> ${sig ? html`<span class="muted mono small">${sig}</span>` : ""}</dd>
<dt>Value</dt><dd>${eth(big(t.value))}</dd><dt>Fee</dt><dd>${units(fee, 18, 12)} ETH</dd>
<dt>Gas used</dt><dd>${num(r.gasUsed).toLocaleString("en-US")} of ${num(t.gas).toLocaleString("en-US")}</dd><dt>Nonce</dt><dd>${num(t.nonce)}</dd></dl>
${transfers.length ? html`<h2>Token transfers</h2><div class="tw"><table><tr><th>Token</th><th>From</th><th>To</th><th>Amount</th></tr>
${transfers.map((l) => { const a = l.address.toLowerCase(), m = meta.get(a); return html`<tr><td>${link("address", a, sym(m, a))}</td><td>${link("address", addr(l.topics[1]))}</td>
<td>${link("address", addr(l.topics[2]))}</td><td>${l.topics.length === 4 ? `#${big(l.topics[3]).toString()}` : m ? units(big(l.data), m.decimals) : big(l.data).toString()}</td></tr>`; })}</table></div>` : ""}
<h2>Logs (${r.logs.length})</h2>
${r.logs.map((l) => html`<details class="log"><summary><span class="muted">#${num(l.logIndex)}</span> ${link("address", l.address)} <span class="tag">${names.has(l.topics[0] ?? "") ? bare(names.get(l.topics[0])!) : short(l.topics[0] ?? "anonymous")}</span></summary>
<dl>${l.topics.map((tp, i) => html`<dt>topic${i}</dt><dd class="mono wrap">${tp}</dd>`)}<dt>data</dt><dd class="mono wrap">${l.data}</dd></dl></details>`)}
<details><summary>Input data (${(t.input.length - 2) / 2} bytes)</summary><p class="mono wrap">${t.input}</p></details>` };
}

// --- address (and token) ---

type WTx = { hash: string; block: string; tx_index: number; from: string; to: string; v: string; selector: string; status: number; created: string; ts: number };
const TX_COLS = "hash, block, tx_index, `from`, `to`, toString(value) AS v, selector, status, created, toUnixTimestamp(time) AS ts";

/** The address's latest 25 txs below block `before`: pointers from idx_wallet_txs (migration 015), each tx from
 *  ClickHouse while it holds it, else from the node. */
async function walletTxs(rpc: Rpc, a: string, before: number): Promise<WTx[]> {
  const ptrs = await rows<{ block: string; tx_index: number }>(
    `SELECT DISTINCT block, tx_index FROM idx_wallet_txs WHERE wallet = {a:String} ${before ? "AND block < {before:UInt64}" : ""}
     ORDER BY block DESC, tx_index DESC LIMIT 25`, { a, before });
  if (!ptrs.length) return [];
  const b = [...new Set(ptrs.map((p) => p.block))];
  const have = new Map((await rows<WTx>(
    `SELECT ${TX_COLS} FROM raw_txs WHERE block IN {b:Array(UInt64)} AND sign = 1
     UNION ALL SELECT ${TX_COLS} FROM kept_txs FINAL WHERE block IN {b:Array(UInt64)} AND sign = 1`, { b })).map((t) => [`${t.block}:${t.tx_index}`, t]));
  // a pointer left by a reorged block can point at another tx: show only txs that involve the wallet
  return (await Promise.all(ptrs.map(async (p) => have.get(`${p.block}:${p.tx_index}`) ?? nodeTx(rpc, Number(p.block), p.tx_index))))
    .filter((t) => t.from === a || t.to === a || t.created === a);
}
async function nodeTx(rpc: Rpc, n: number, i: number): Promise<WTx> {
  const [t, blk] = await Promise.all([
    call<RpcTx>(rpc, "eth_getTransactionByBlockNumberAndIndex", ["0x" + n.toString(16), "0x" + i.toString(16)]),
    call<{ timestamp: string }>(rpc, "eth_getBlockByNumber", ["0x" + n.toString(16), false]),
  ]);
  const r = await call<{ status: string; contractAddress: string | null }>(rpc, "eth_getTransactionReceipt", [t.hash]);
  return { hash: t.hash, block: String(n), tx_index: i, from: t.from.toLowerCase(), to: (t.to ?? "").toLowerCase(), v: BigInt(t.value).toString(),
    selector: t.input.length >= 10 ? t.input.slice(0, 10).toLowerCase() : "", status: num(r.status), created: (r.contractAddress ?? "").toLowerCase(), ts: num(blk.timestamp) };
}
type Edge = { peer: string; v: string; block: string; tx_index: number; type: number; ts: number };
type Side = { edges: number; wallets: number; wei: string };
const BRIDGE: Record<number, string> = { 100: "L1 deposit", 104: "retryable", 105: "retryable" };
const EDGE_COLS = "toString(value) AS v, block, tx_index, type, toUnixTimestamp(time) AS ts";
const SIDE = (t: string, k: string) => `SELECT uniqMerge(n) AS edges, uniqMerge(peers) AS wallets, toString(sum(total)) AS wei FROM ${t} WHERE ${k} = {a:String}`;

/** The wallet's ETH funding (migration 016, transfers that happened): its first funders with how many wallets each
 *  funded (a funder of thousands is an exchange, solver or bridge), the first wallets it funded, and both sides' totals. */
async function funding(rpc: Rpc, a: string) {
  const [first, funded, [inSide], [outSide]] = await Promise.all([
    rows<Edge>(`SELECT src AS peer, ${EDGE_COLS} FROM native_edges FINAL WHERE dst = {a:String} ORDER BY block, tx_index, path LIMIT 5`, { a }),
    rows<Edge>(`SELECT dst AS peer, ${EDGE_COLS} FROM native_edges_by_src FINAL WHERE src = {a:String} ORDER BY block, tx_index, path LIMIT 10`, { a }),
    rows<Side>(SIDE("agg_native_dst", "dst"), { a }),
    rows<Side>(SIDE("agg_native_src", "src"), { a }),
  ]);
  const srcs = [...new Set(first.map((e) => e.peer))];
  const [hubs, hash] = await Promise.all([
    srcs.length ? rows<{ src: string; w: number }>("SELECT src, uniqMerge(peers) AS w FROM agg_native_src WHERE src IN {s:Array(String)} GROUP BY src", { s: srcs }) : [],
    txHashes(rpc, [...first, ...funded]),
  ]);
  return { first, funded, inSide, outSide, hubs: new Map(hubs.map((h) => [h.src, Number(h.w)])), hash };
}

/** Hashes of (block, tx_index) pairs: ClickHouse, else the node. */
async function txHashes(rpc: Rpc, ps: { block: string; tx_index: number }[]): Promise<Map<string, string>> {
  if (!ps.length) return new Map();
  const b = [...new Set(ps.map((p) => p.block))];
  const m = new Map((await rows<{ block: string; tx_index: number; hash: string }>(
    `SELECT block, tx_index, hash FROM raw_txs WHERE block IN {b:Array(UInt64)} UNION ALL SELECT block, tx_index, hash FROM kept_txs WHERE block IN {b:Array(UInt64)}`, { b }))
    .map((r) => [`${r.block}:${r.tx_index}`, r.hash]));
  await Promise.all(ps.filter((p) => !m.has(`${p.block}:${p.tx_index}`)).map(async (p) => {
    const t = await call<{ hash: string } | null>(rpc, "eth_getTransactionByBlockNumberAndIndex", ["0x" + Number(p.block).toString(16), "0x" + p.tx_index.toString(16)]).catch(() => null);
    if (t) m.set(`${p.block}:${p.tx_index}`, t.hash);
  }));
  return m;
}

/** Where every address's txs are indexed from (0: all of them): the scan's floor, or go-live before it starts. */
async function txsFrom(): Promise<{ from: number; scan: number | null; golive: number }> {
  const [r] = await rows<{ scan: string; golive: string; has_scan: number }>(
    "SELECT minIf(block, name = 'scan') AS scan, minIf(block, name = 'golive') AS golive, countIf(name = 'scan') AS has_scan FROM ctl_cursors FINAL WHERE name IN ('scan', 'golive')");
  const golive = Number(r?.golive ?? 0), scan = r?.has_scan ? Number(r.scan) : null;
  return { from: scan ?? golive, scan, golive };
}

export async function address(rpc: Rpc, a: string, q: URLSearchParams): Promise<Page> {
  const txb = /^\d{1,12}$/.test(q.get("txb") ?? "") ? Number(q.get("txb")) : 0;
  const tfb = /^\d{1,12}$/.test(q.get("tfb") ?? "") ? Number(q.get("tfb")) : 0;
  requested(a);
  const [bal, code, [c], meta, txs, cov, tfs, fund] = await Promise.all([
    call<string>(rpc, "eth_getBalance", [a, "latest"]),
    call<string>(rpc, "eth_getCode", [a, "latest"]),
    rows<{ kind: string; impl: string; deployer: string; block: string; created: number; fingerprint: string }>(
      "SELECT kind, impl, deployer, block, created, fingerprint FROM contracts FINAL WHERE address = {a:String}", { a }),
    tokens([a]),
    walletTxs(rpc, a, txb),
    txsFrom(),
    rows<{ tx_hash: string; block: string; token: string; from: string; to: string; amt: string; ts: number }>(
      `SELECT tx_hash, block, token, \`from\`, \`to\`, toString(amount) AS amt, toUnixTimestamp(time) AS ts FROM kept_transfers_by_wallet FINAL
       WHERE wallet = {a:String} ${tfb ? "AND block < {tfb:UInt64}" : ""} ORDER BY block DESC, log_index DESC LIMIT 25`, { a, tfb }),
    funding(rpc, a),
  ]);
  const tok = meta.get(a), isContract = code !== "0x";
  // the contracts feed starts at its migration: an older proxy is read from its EIP-1967 slot
  const impl = c?.impl || (isContract && code.length < 4000
    ? ((s) => (/^0x0*$/.test(s) ? "" : "0x" + s.slice(-40)))(await call<string>(rpc, "eth_getStorageAt", [a, IMPL_SLOT, "latest"]).catch(() => "0x"))
    : "");
  const [tmeta, names, token] = await Promise.all([
    tokens(tfs.map((t) => t.token)), methods(rpc, txs.map((t) => ({ to: t.to || null, input: t.created ? "" : t.selector }))),
    tok ? tokenSection(rpc, a, tok) : Promise.resolve(html``),
  ]);
  const title = tok ? `${tok.name || tok.symbol || "Token"} (${tok.symbol})` : isContract ? "Contract" : "Address";
  return { status: 200, title: `${title} ${short(a)}`, refresh: cov.from && !txb && !tfb ? 60 : undefined, body: html`
<h1>${title}</h1><p class="mono wrap">${a}</p>
<dl><dt>Balance</dt><dd>${eth(big(bal))}</dd>
<dt>Type</dt><dd>${isContract ? html`Contract${c?.kind ? html` <span class="tag">${c.kind}</span>` : ""}` : "Account (EOA)"}</dd>
${impl ? html`<dt>Implementation</dt><dd>${link("address", impl, impl)}</dd>` : ""}
${c?.deployer ? html`<dt>Deployed by</dt><dd>${link("address", c.deployer, c.deployer)} in block ${link("block", c.block)}</dd>` : ""}
${isContract ? html`<dt>Code</dt><dd>${(code.length - 2) / 2} bytes</dd>` : ""}</dl>
${token}
<h2>ETH funding <span class="muted small">(direct transfers that happened, ${cov.from ? html`since block ${link("block", String(cov.from))}` : "all"}; not ETH sent by contracts)</span></h2>
<dl><dt>Received</dt><dd>${side(fund.inSide, "from")}</dd><dt>Sent</dt><dd>${side(fund.outSide, "to")}</dd></dl>
${fund.first.length ? html`<h3>First funders</h3>${edges(fund.first, fund.hash, (e) => html`${link("address", e.peer)}${fund.hubs.get(e.peer) ? html` <span class="muted small">funded ${fund.hubs.get(e.peer)!.toLocaleString("en-US")} wallet${fund.hubs.get(e.peer) === 1 ? "" : "s"}</span>` : ""}`)}` : ""}
${fund.funded.length ? html`<h3>First wallets it funded</h3>${edges(fund.funded, fund.hash, (e) => link("address", e.peer))}` : ""}
<h2>Transactions <span class="muted small">(${cov.from ? html`all since block ${link("block", String(cov.from))}` : "all"})</span></h2>
${cov.from ? html`<p class="loading"><span class="spin"></span> ${cov.scan == null
  ? html`Older ones (before block ${cov.from}) are indexed once our node has finished syncing.`
  : html`Older ones are being indexed from our node, newest first: ${(100 * (cov.golive - cov.scan) / cov.golive).toFixed(1)}% done.`} This page refreshes itself.</p>` : ""}
${txs.length ? html`<div class="tw"><table><tr><th>Tx</th><th>Time (UTC)</th><th>Method</th><th>From → To</th><th>Value</th></tr>
${txs.map((t) => html`<tr${t.status ? "" : html` class="failed"`}><td>${link("tx", t.hash)}</td><td>${when(t.ts)}</td><td><span class="tag">${method(t.to || null, t.created ? "" : t.selector, names)}</span></td>
<td>${t.from === a ? html`<b>self</b>` : link("address", t.from)} → ${t.created ? "new contract" : t.to === a ? html`<b>self</b>` : t.to ? link("address", t.to) : "—"}</td><td>${value(t.v)}</td></tr>`)}</table></div>
${txs.length === 25 ? html`<nav class="pager"><a href="/address/${a}?txb=${txs.at(-1)!.block}${tfb ? `&tfb=${tfb}` : ""}">older →</a></nav>` : ""}` : html`<p class="muted">None${cov.from ? " since then" : ""}.</p>`}
<h2>Token transfers <span class="muted small">(ERC-20, since our history starts)</span></h2>
${tfs.length ? html`<div class="tw"><table><tr><th>Tx</th><th>Time (UTC)</th><th>Token</th><th>From → To</th><th>Amount</th></tr>
${tfs.map((t) => { const m = tmeta.get(t.token); return html`<tr><td>${link("tx", t.tx_hash)}</td><td>${when(t.ts)}</td><td>${link("address", t.token, sym(m, t.token))}</td>
<td>${t.from === a ? html`<b>self</b>` : link("address", t.from)} → ${t.to === a ? html`<b>self</b>` : link("address", t.to)}</td><td>${m ? units(t.amt, m.decimals) : t.amt}</td></tr>`; })}</table></div>
${tfs.length === 25 ? html`<nav class="pager"><a href="/address/${a}?tfb=${tfs.at(-1)!.block}${txb ? `&txb=${txb}` : ""}">older →</a></nav>` : ""}` : html`<p class="muted">None.</p>`}` };
}

const side = (x: Side | undefined, dir: string) => (Number(x?.edges ?? 0)
  ? html`${eth(x!.wei)} in ${Number(x!.edges).toLocaleString("en-US")} transfers ${dir} ${Number(x!.wallets).toLocaleString("en-US")} wallets <span class="muted small">(approximate counts)</span>`
  : html`<span class="muted">none</span>`);
const edges = (es: Edge[], hash: Map<string, string>, who: (e: Edge) => Html | string) => html`<div class="tw"><table><tr><th>Tx</th><th>Time (UTC)</th><th>Address</th><th>Value</th></tr>
${es.map((e) => { const h = hash.get(`${e.block}:${e.tx_index}`); return html`<tr><td>${h ? link("tx", h) : link("block", e.block)}</td><td>${when(e.ts)}</td>
<td>${who(e)}${BRIDGE[e.type] ? html` <span class="tag">${BRIDGE[e.type]}</span>` : ""}</td><td>${value(e.v)}</td></tr>`; })}</table></div>`;

// A token card (cards.ts) as the explorer shows it
type View = {
  complete: boolean; circulating_supply: string | null; locked_supply: string | null; burned_supply: string | null;
  top10: { pct: number | null } | null; creator: string | null; launchpad: string | null; launch_block: number | null;
  main_pool: { pool: string; venue: string; quote: string; verified: boolean; created_block: number | null; price_usd: number | null;
    liquidity_usd: number | null; liquidity_quote_usd: number | null } | null;
  h24: { volume_usd: number; volume_raw_usd: number; buys: number; sells: number; buyers: number; sellers: number; top_wallet: { wallet: string; share: number } | null };
};
const upOf = (rpc: Rpc) => ({ call: <T>(m: string, p: unknown[]) => call<T>(rpc, m, p) });
const money = (v: number | null | undefined) => (v == null ? "—" : usd(v));
// wash: most of the gross is same-tx round trips; one-sided: almost none of the pool's tokens are what a seller receives
const washy = (net: number, raw: number) => raw > 1_000 && raw > 2 * net;
type Early = { launch_block: number; launch_source: string; deployer: string | null; closed: boolean; skipped: number;
  buyers: { rank: number; block: number; tx_hash: string; wallet: string; signer: string | null; via: string; pct: number | null; usd_in: number | null;
    sold: boolean; sold_out: boolean; first_out_block: number | null; first_sell_block: number | null;
    groups: { same_tx: number | null; same_block: number | null; same_signer: number | null };
    funding: { funder: string; funder_peers: number; funder_is_deployer: boolean; funder_shared_with_deployer: boolean } | null }[] };
const EARLY_BLOCKS = 300; // ~31 s at 104 ms blocks
const QUOTES: Record<string, string> = { [USDG]: "USDG", [WETH]: "WETH", [NATIVE_ETH]: "ETH" };

async function tokenSection(rpc: Rpc, t: string, tok: Token): Promise<Html> {
  const [card, holders, pools, own, early] = await Promise.all([
    cards(upOf(rpc), [t]).then((m) => (m.get(t) ?? null) as View | null),
    rows<{ holder: string; bal: string }>(
      `SELECT holder, toString(sum(balance)) AS bal FROM agg_balances WHERE token = {t:String} AND holder != {z:String} GROUP BY holder HAVING sum(balance) > 0
       ORDER BY sum(balance) DESC LIMIT 20`, { t, z: ZERO }),
    rows<{ pl: string; v: string; q: string; vol: number; raw: number; hk: string; vf: number }>(
      `SELECT n.pool AS pl, toString(p.venue) AS v, n.q AS q, n.nv AS vol, n.rv AS raw, p.hooks AS hk, p.verified AS vf
       FROM (${NET24}) AS n INNER JOIN (SELECT * FROM pools FINAL) AS p ON p.pool = n.pool ORDER BY vol DESC, raw DESC LIMIT 10`, { t: [t] }),
    rows<{ pool: string; hooks: string }>("SELECT pool, hooks FROM pools FINAL WHERE token0 = {t:String} OR token1 = {t:String}", { t }),
    earlyBuyers(upOf(rpc), t, EARLY_BLOCKS, 20).then((r) => (r.status === 200 ? r.body as Early : null)).catch(() => null),
  ]);
  const mp = card?.main_pool ?? null, d = card?.h24;
  const chartPool = mp?.pool ?? pools.find((p) => p.vf === 1)?.pl;
  const chart = chartPool ? await rows<{ h: number; c: number }>(
    `SELECT toUnixTimestamp(toStartOfHour(m)) AS h, argMax(cu, m) AS c FROM (
       SELECT minute AS m, argMaxMerge(close_usd) AS cu FROM agg_candles_1m WHERE token = {t:String} AND pool = {p:String}
         AND minute > now() - INTERVAL 7 DAY GROUP BY minute) WHERE cu > 0 GROUP BY h ORDER BY h`, { t, p: chartPool }) : [];
  const supply = BigInt(tok.supply || "0"), amt = (v: string | null) => (v == null ? "—" : units(BigInt(v), tok.decimals, 2));
  const ownSet = new Set(own.flatMap((p) => [p.pool, p.hooks]));
  const quote = (q: string) => (QUOTES[q] ? link("address", q, QUOTES[q]) : link("address", q));
  const oneSided = mp?.liquidity_usd != null && mp.liquidity_quote_usd != null && mp.liquidity_usd > 1_000 && mp.liquidity_quote_usd < 0.05 * mp.liquidity_usd;
  const wash = d ? washy(d.volume_usd, d.volume_raw_usd) : false;
  const one = d?.top_wallet && d.top_wallet.share >= 0.5 && d.volume_usd > 10_000 ? d.top_wallet : null; // one wallet makes the market
  const what = (a: string) => { const e = PROTOCOL.get(a); return e ? html`<span class="tag">${e.label}</span>` : ownSet.has(a) ? html`<span class="tag">pool</span>` : a === t ? html`<span class="tag">token contract</span>` : ""; };
  const tile = (v: unknown, k: unknown) => html`<div><b>${v}</b><span>${k}</span></div>`;
  return html`<h2>Token</h2>
<div class="stats">${tile(money(mp?.price_usd), "price, main pool")}
${tile(money(mp?.liquidity_quote_usd), html`sell-side liquidity${oneSided ? html` <span class="bad">one-sided</span>` : ""}`)}
${tile(money(d?.volume_usd), html`24 h volume${wash ? html` <span class="bad">wash: ${usd(d!.volume_raw_usd)} gross</span>` : one ? html` <span class="bad">${Math.round(one.share * 100)}% one wallet</span>` : ""}`)}
${tile(Number(tok.holder_count).toLocaleString("en-US"), card?.complete ? "holders" : "holders (since our history)")}
${card?.top10?.pct != null ? tile(`${card.top10.pct.toFixed(2)}%`, "held by the top 10") : ""}</div>
${oneSided || wash || one ? html`<p class="note small">${oneSided ? html`<b>One-sided pool:</b> it holds ${usd(mp!.liquidity_usd!)} in all, but only ${usd(mp!.liquidity_quote_usd!)} of it is ${QUOTES[mp!.quote] ?? "the quote asset"}, which is what a seller receives. ` : ""}${wash
  ? html`<b>Wash trading:</b> ${usd(d!.volume_raw_usd)} of swaps in 24 h, but buys and sells inside the same transactions cancel out to ${usd(d!.volume_usd)}. ` : ""}${one
  ? html`<b>One wallet:</b> ${link("address", one.wallet)} made ${(one.share * 100).toFixed(1)}% of the 24 h trading.` : ""}</p>` : ""}
<dl><dt>Name</dt><dd>${tok.name}</dd><dt>Symbol</dt><dd>${tok.symbol}</dd><dt>Decimals</dt><dd>${tok.decimals}</dd>
<dt>Total supply</dt><dd>${units(supply, tok.decimals, 2)}</dd>
${card?.complete ? html`<dt>Circulating</dt><dd>${amt(card.circulating_supply)} <span class="muted small">(locked ${amt(card.locked_supply)}, burned ${amt(card.burned_supply)})</span></dd>`
  : html`<dt>Circulating</dt><dd><span class="muted small">Holders are counted from our history; circulating supply and the top 10 come once the token's older history is indexed.</span></dd>`}
${card?.launch_block ? html`<dt>Launched</dt><dd>${card.launchpad ? html`<span class="tag">${card.launchpad}</span> ` : ""}in block ${link("block", card.launch_block)}${card.creator ? html` by ${link("address", card.creator)}` : ""}</dd>` : ""}
${mp ? html`<dt>Main pool</dt><dd><span class="mono">${short(mp.pool)}</span> <span class="tag">${mp.venue}</span> against ${quote(mp.quote)}${mp.verified ? "" : html` <span class="bad small">unverified</span>`}
<span class="muted small">liquidity ${money(mp.liquidity_usd)} in all, ${money(mp.liquidity_quote_usd)} on the sell side</span></dd>` : ""}
${d ? html`<dt>Trades, 24 h</dt><dd>${d.buys.toLocaleString("en-US")} buys by ${d.buyers.toLocaleString("en-US")} wallets, ${d.sells.toLocaleString("en-US")} sells by ${d.sellers.toLocaleString("en-US")}${d.top_wallet
  ? html` <span class="muted small">(largest trader ${link("address", d.top_wallet.wallet)}: ${(d.top_wallet.share * 100).toFixed(1)}%)</span>` : ""}</dd>` : ""}</dl>
${chart.length ? html`<h3>Price, last 7 days <span class="muted small">(hourly close, pool ${short(chartPool!)})</span></h3>${sparkline(chart.map((r) => [r.h, r.c]))}` : ""}
${pools.length ? html`<h3>Pools (24 h)</h3><div class="tw"><table><tr><th>Pool</th><th>Venue</th><th>Quote</th><th class="num">Volume</th><th class="num">Gross</th><th></th></tr>
${pools.map((p) => html`<tr><td class="mono">${short(p.pl)}</td><td>${p.v}</td><td>${quote(p.q)}</td><td class="num">${usd(p.vol)}</td><td class="num muted">${usd(p.raw)}</td>
<td>${p.pl === mp?.pool ? html`<span class="tag">main</span> ` : ""}${p.vf ? "" : html`<span class="bad small">unverified</span> `}${washy(p.vol, p.raw) ? html`<span class="bad small">wash</span> ` : ""}${p.hk && !/^0x0*$/.test(p.hk) ? html`<span class="tag">hook</span>` : ""}</td></tr>`)}</table></div>
<p class="muted small">Volume is net: a transaction's buys and sells in one pool cancel, so round trips (wash trading) count for nothing; Gross counts every swap. Sell-side liquidity is the ETH or USDG a seller can receive from the main pool within ×/÷10,000 of the price.</p>` : ""}
${early?.buyers.length ? earlyTable(early) : ""}
${holders.length ? html`<h3>Top holders</h3><div class="tw"><table><tr><th>Holder</th><th></th><th>Balance</th><th>Share</th></tr>
${holders.map((h) => html`<tr><td>${link("address", h.holder)}</td><td>${what(h.holder)}</td><td>${units(h.bal, tok.decimals, 2)}</td><td>${supply > 0n ? `${(Number((BigInt(h.bal) * 10000n) / supply) / 100).toFixed(2)}%` : ""}</td></tr>`)}</table></div>
<p class="muted small">The top 10 share leaves out pools, lockers, burn addresses and other protocol contracts.</p>` : ""}`;
}

function earlyTable(e: Early): Html {
  const now = (b: Early["buyers"][number]) => b.sold_out ? html`<span class="bad small">sold out</span>` : b.sold ? html`<span class="small">sold some</span>` : html`<span class="ok small">holds</span>`;
  const tags = (b: Early["buyers"][number]) => html`${b.groups.same_tx ? html`<span class="tag" title="same transaction as #${b.groups.same_tx}">tx #${b.groups.same_tx}</span> ` : ""}${b.groups.same_signer
    ? html`<span class="tag" title="same signer as #${b.groups.same_signer}">signer #${b.groups.same_signer}</span> ` : ""}${b.groups.same_block && !b.groups.same_tx ? html`<span class="tag" title="same block as #${b.groups.same_block}">block #${b.groups.same_block}</span> ` : ""}${b.first_out_block && !b.first_sell_block
    ? html`<span class="tag" title="sent tokens out without selling">moved out</span>` : ""}`;
  const fund = (b: Early["buyers"][number]) => !b.funding ? html`<span class="muted">—</span>` : html`${link("address", b.funding.funder)}${b.funding.funder_is_deployer
    ? html` <span class="bad small">deployer</span>` : b.funding.funder_shared_with_deployer ? html` <span class="bad small">deployer's funder</span>` : ""}${b.funding.funder_peers > 1 ? html` <span class="muted small">funded ${b.funding.funder_peers.toLocaleString("en-US")}</span>` : ""}`;
  return html`<h3>Early buyers <span class="muted small">(first ${EARLY_BLOCKS} blocks after the ${e.launch_source === "pool" ? "first pool" : e.launch_source === "mint" ? "first mint" : `${e.launch_source} launch`} in block ${link("block", e.launch_block)}${e.closed ? "" : ", still open"})</span></h3>
<div class="tw"><table><tr><th>#</th><th>Wallet</th><th>Via</th><th class="num">Paid</th><th class="num">Supply</th><th>Now</th><th>Funded by</th><th></th></tr>
${e.buyers.map((b) => html`<tr><td>${link("tx", b.tx_hash, String(b.rank))}</td><td>${link("address", b.wallet)}${b.wallet === e.deployer ? html` <span class="bad small">deployer</span>` : ""}</td><td>${b.via}</td>
<td class="num">${money(b.usd_in)}</td><td class="num">${b.pct == null ? "" : `${b.pct.toFixed(2)}%`}</td><td>${now(b)}</td><td>${fund(b)}</td><td>${tags(b)}</td></tr>`)}</table></div>
<p class="muted small">Wallets that received the token and kept a net positive amount in the window, curve and pool buys alike; pools, curves, protocol contracts and ${e.skipped} other market addresses aren't buyers. Same-number tags mark wallets that bought in one transaction, with one signer, or in one block. "Moved out" sent tokens away without selling (a side wallet, often).</p>`;
}

// --- search ---

export async function search(rpc: Rpc, q: string): Promise<Page> {
  const s = q.trim();
  if (/^\d{1,12}$/.test(s)) return { status: 302, title: "", body: html``, redirect: `/block/${Number(s)}` };
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return { status: 302, title: "", body: html``, redirect: `/address/${s.toLowerCase()}` };
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) {
    const h = s.toLowerCase();
    const t = await call<unknown>(rpc, "eth_getTransactionByHash", [h]).catch(() => null);
    return { status: 302, title: "", body: html``, redirect: t ? `/tx/${h}` : `/block/${h}` };
  }
  if (s.length < 2 || s.length > 64) return { status: 400, title: "Search", body: html`<h1>Search</h1><p>Type a block number, a tx or block hash, an address, or 2–64 characters of a token's name or symbol.</p>` };
  const hits = await rows<{ token: string; name: string; symbol: string; holder_count: string }>(
    `SELECT token, name, symbol, holder_count FROM serve_tokens FINAL
     WHERE positionCaseInsensitiveUTF8(symbol, {s:String}) > 0 OR positionCaseInsensitiveUTF8(name, {s:String}) > 0
     ORDER BY lower(symbol) = lower({s:String}) DESC, holder_count DESC LIMIT 25`, { s });
  return { status: 200, title: `Search: ${s}`, body: html`<h1>Tokens matching “${s}”</h1>
${hits.length ? html`<div class="tw"><table><tr><th>Token</th><th>Name</th><th>Holders</th></tr>${hits.map((h) => html`<tr><td>${link("address", h.token, h.symbol || short(h.token))}</td><td>${h.name}</td><td>${Number(h.holder_count).toLocaleString("en-US")}</td></tr>`)}</table></div>`
    : html`<p class="muted">No token matches.</p>`}` };
}
