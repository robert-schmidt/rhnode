// Explorer pages. Blocks, txs and receipts come from the node (the permanent archive, through the caller's cached
// JSON-RPC); lists, tokens, pools and prices from ClickHouse (14 days raw, kept_* and agg_* forever).
// Every id reaching a query has passed the regexes in index.ts, and every query takes bound parameters.
import { rows } from "../ch.ts";
import { ago, eth, html, link, short, sparkline, units, usd, utc, when, type Html } from "./html.ts";
import { bare, lookup } from "./names.ts";

export type Rpc = (method: string, params: unknown[]) => Promise<{ result?: unknown; error?: { message: string } }>;
export type Page = { status: number; title: string; body: Html; immutable?: boolean; redirect?: string };

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x" + "0".repeat(40);
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"; // EIP-1967
const DEEP = 64; // blocks below the head that we treat as final
const big = (h: unknown) => BigInt((h as string) || "0x0");
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
const method = (input: string, names: Map<string, string>) => {
  if (!input || input === "0x") return "transfer";
  const s = input.slice(0, 10).toLowerCase(), n = names.get(s);
  return n ? bare(n) : s;
};
export const notFound = (what: string): Page => ({ status: 404, title: "Not found", body: html`<h1>Not found</h1><p>${what}</p>` });

// --- home ---

export async function home(): Promise<Page> {
  const head = await headBlock();
  const [blocks, txs, [st]] = await Promise.all([
    rows<{ number: string; hash: string; ts: number; tx_count: number; gas_used: string }>(
      `SELECT number, hash, toUnixTimestamp(time) AS ts, tx_count, gas_used FROM raw_blocks
       WHERE number > {lo:UInt64} AND sign = 1 ORDER BY number DESC LIMIT 12`, { lo: head - 200 }),
    rows<{ hash: string; block: string; from: string; to: string; v: string; selector: string; status: number; created: string; ts: number }>(
      `SELECT hash, block, \`from\`, \`to\`, toString(value) AS v, selector, status, created, toUnixTimestamp(time) AS ts FROM raw_txs
       WHERE block > {lo:UInt64} AND sign = 1 ORDER BY block DESC, tx_index DESC LIMIT 15`, { lo: head - 50 }),
    rows<{ n: string; s: number }>(`SELECT count() AS n, max(toUnixTimestamp(time)) - min(toUnixTimestamp(time)) AS s FROM raw_txs
       WHERE block > {lo:UInt64} AND sign = 1`, { lo: head - 600 }),
  ]);
  const names = await lookup(txs.map((t) => t.selector));
  const tps = st && st.s > 0 ? (Number(st.n) / st.s).toFixed(1) : "?";
  return { status: 200, title: "Latest blocks and transactions", body: html`
<h1>Robinhood Chain</h1>
<div class="stats"><div><b>${head.toLocaleString("en-US")}</b><span>latest block</span></div><div><b>${tps}</b><span>tx/s (last minute)</span></div>
<div><b>~0.1 s</b><span>block time</span></div></div>
<div class="cols"><section><h2>Latest blocks</h2><table><tr><th>Block</th><th>Age</th><th>Txs</th><th>Gas used</th></tr>
${blocks.map((b) => html`<tr><td>${link("block", b.number)}</td><td>${when(b.ts)}</td><td>${b.tx_count}</td><td>${Number(b.gas_used).toLocaleString("en-US")}</td></tr>`)}
</table></section>
<section><h2>Latest transactions</h2><table><tr><th>Tx</th><th>Method</th><th>From → To</th><th>Value</th></tr>
${txs.map((t) => html`<tr${t.status ? "" : html` class="failed"`}><td>${link("tx", t.hash)}</td><td><span class="tag">${method(t.created ? "" : t.selector, names)}</span></td>
<td>${link("address", t.from)} → ${t.created ? link("address", t.created, "new contract") : t.to ? link("address", t.to) : "—"}</td><td>${eth(t.v)}</td></tr>`)}
</table></section></div>` };
}

// --- block ---

type RpcTx = { hash: string; from: string; to: string | null; value: string; input: string; nonce: string; gas: string; transactionIndex: string; type: string };
type RpcBlock = { number: string; hash: string; parentHash: string; timestamp: string; gasUsed: string; gasLimit: string; baseFeePerGas?: string; l1BlockNumber?: string; transactions: RpcTx[]; size?: string };

export async function block(rpc: Rpc, id: string): Promise<Page> {
  const b = id.startsWith("0x")
    ? await call<RpcBlock | null>(rpc, "eth_getBlockByHash", [id, true])
    : await call<RpcBlock | null>(rpc, "eth_getBlockByNumber", ["0x" + BigInt(id).toString(16), true]);
  if (!b) return notFound(`No block ${id} (yet).`);
  const n = num(b.number), head = await headBlock(), ts = num(b.timestamp);
  const names = await lookup(b.transactions.map((t) => t.input.slice(0, 10)));
  return { status: 200, title: `Block ${n.toLocaleString("en-US")}`, immutable: n < head - DEEP, body: html`
<h1>Block <span class="mono">${n.toLocaleString("en-US")}</span></h1>
<nav class="pager">${n > 0 ? link("block", n - 1, "← previous") : ""} ${n < head ? link("block", n + 1, "next →") : ""}</nav>
<dl><dt>Hash</dt><dd class="mono">${b.hash}</dd><dt>Parent</dt><dd>${n > 0 ? link("block", b.parentHash, b.parentHash) : "—"}</dd>
<dt>Time</dt><dd>${utc(ts)} (${ago(ts)})</dd><dt>Transactions</dt><dd>${b.transactions.length}</dd>
<dt>Gas used</dt><dd>${num(b.gasUsed).toLocaleString("en-US")} of ${num(b.gasLimit).toLocaleString("en-US")}</dd>
${b.baseFeePerGas ? html`<dt>Base fee</dt><dd>${units(big(b.baseFeePerGas), 9, 4)} gwei</dd>` : ""}
${b.l1BlockNumber ? html`<dt>L1 block</dt><dd>${num(b.l1BlockNumber).toLocaleString("en-US")}</dd>` : ""}</dl>
<h2>Transactions</h2><table><tr><th>#</th><th>Tx</th><th>Method</th><th>From</th><th>To</th><th>Value</th></tr>
${b.transactions.map((t) => html`<tr><td>${num(t.transactionIndex)}</td><td>${link("tx", t.hash)}</td><td><span class="tag">${t.to ? method(t.input, names) : "create"}</span></td>
<td>${link("address", t.from)}</td><td>${t.to ? link("address", t.to) : "—"}</td><td>${eth(big(t.value))}</td></tr>`)}</table>` };
}

// --- tx ---

type Log = { address: string; topics: string[]; data: string; logIndex: string };
type Receipt = { status: string; blockNumber: string; gasUsed: string; effectiveGasPrice?: string; contractAddress: string | null; logs: Log[]; gasUsedForL1?: string };

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
  const [meta, names] = await Promise.all([
    tokens(transfers.map((l) => l.address.toLowerCase())),
    lookup([t.input.slice(0, 10), ...r.logs.map((l) => l.topics[0]).filter(Boolean)]),
  ]);
  const fee = big(r.gasUsed) * big(r.effectiveGasPrice ?? t.gasPrice ?? "0x0");
  const ok = num(r.status) === 1;
  const addr = (topic: string) => "0x" + topic.slice(26);
  return { status: 200, title: `Tx ${short(hash)}`, immutable: n < head - DEEP, body: html`
<h1>Transaction</h1>
<dl><dt>Hash</dt><dd class="mono">${hash}</dd>
<dt>Status</dt><dd>${ok ? html`<span class="ok">Success</span>` : html`<span class="bad">Failed</span>`}</dd>
<dt>Block</dt><dd>${link("block", n)}${ts ? html` · ${utc(ts)} (${ago(ts)})` : ""}</dd>
<dt>From</dt><dd>${link("address", t.from, t.from)}</dd>
<dt>To</dt><dd>${t.to ? link("address", t.to, t.to) : r.contractAddress ? html`${link("address", r.contractAddress, r.contractAddress)} (created)` : "—"}</dd>
<dt>Method</dt><dd><span class="tag">${t.to ? method(t.input, names) : "create"}</span> ${names.get(t.input.slice(0, 10).toLowerCase()) ? html`<span class="muted mono small">${names.get(t.input.slice(0, 10).toLowerCase())}</span>` : ""}</dd>
<dt>Value</dt><dd>${eth(big(t.value))}</dd><dt>Fee</dt><dd>${units(fee, 18, 12)} ETH</dd>
<dt>Gas used</dt><dd>${num(r.gasUsed).toLocaleString("en-US")} of ${num(t.gas).toLocaleString("en-US")}</dd><dt>Nonce</dt><dd>${num(t.nonce)}</dd></dl>
${transfers.length ? html`<h2>Token transfers</h2><table><tr><th>Token</th><th>From</th><th>To</th><th>Amount</th></tr>
${transfers.map((l) => { const a = l.address.toLowerCase(), m = meta.get(a); return html`<tr><td>${link("address", a, sym(m, a))}</td><td>${link("address", addr(l.topics[1]))}</td>
<td>${link("address", addr(l.topics[2]))}</td><td>${l.topics.length === 4 ? `#${big(l.topics[3]).toString()}` : m ? units(big(l.data), m.decimals) : big(l.data).toString()}</td></tr>`; })}</table>` : ""}
<h2>Logs (${r.logs.length})</h2>
${r.logs.map((l) => html`<details class="log"><summary><span class="muted">#${num(l.logIndex)}</span> ${link("address", l.address)} <span class="tag">${names.has(l.topics[0] ?? "") ? bare(names.get(l.topics[0])!) : short(l.topics[0] ?? "anonymous")}</span></summary>
<dl>${l.topics.map((tp, i) => html`<dt>topic${i}</dt><dd class="mono wrap">${tp}</dd>`)}<dt>data</dt><dd class="mono wrap">${l.data}</dd></dl></details>`)}
<details><summary>Input data (${(t.input.length - 2) / 2} bytes)</summary><p class="mono wrap">${t.input}</p></details>` };
}

// --- address (and token) ---

export async function address(rpc: Rpc, a: string, q: URLSearchParams): Promise<Page> {
  const txb = /^\d{1,12}$/.test(q.get("txb") ?? "") ? Number(q.get("txb")) : 0;
  const tfb = /^\d{1,12}$/.test(q.get("tfb") ?? "") ? Number(q.get("tfb")) : 0;
  const [bal, code, [c], meta, txs, tfs] = await Promise.all([
    call<string>(rpc, "eth_getBalance", [a, "latest"]),
    call<string>(rpc, "eth_getCode", [a, "latest"]),
    rows<{ kind: string; impl: string; deployer: string; block: string; created: number; fingerprint: string }>(
      "SELECT kind, impl, deployer, block, created, fingerprint FROM contracts FINAL WHERE address = {a:String}", { a }),
    tokens([a]),
    rows<{ hash: string; block: string; from: string; to: string; v: string; selector: string; status: number; created: string; ts: number }>(
      `SELECT hash, block, \`from\`, \`to\`, toString(value) AS v, selector, status, created, toUnixTimestamp(time) AS ts FROM raw_txs
       WHERE (\`from\` = {a:String} OR \`to\` = {a:String} OR created = {a:String}) AND sign = 1 ${txb ? "AND block < {txb:UInt64}" : ""}
       ORDER BY block DESC, tx_index DESC LIMIT 25`, { a, txb }),
    rows<{ tx_hash: string; block: string; token: string; from: string; to: string; amt: string; ts: number }>(
      `SELECT tx_hash, block, token, \`from\`, \`to\`, toString(amount) AS amt, toUnixTimestamp(time) AS ts FROM kept_transfers_by_wallet FINAL
       WHERE wallet = {a:String} ${tfb ? "AND block < {tfb:UInt64}" : ""} ORDER BY block DESC, log_index DESC LIMIT 25`, { a, tfb }),
  ]);
  const tok = meta.get(a), isContract = code !== "0x";
  // the contracts feed starts at its migration: an older proxy is read from its EIP-1967 slot
  const impl = c?.impl || (isContract && code.length < 4000
    ? ((s) => (/^0x0*$/.test(s) ? "" : "0x" + s.slice(-40)))(await call<string>(rpc, "eth_getStorageAt", [a, IMPL_SLOT, "latest"]).catch(() => "0x"))
    : "");
  const [tmeta, names, token] = await Promise.all([
    tokens(tfs.map((t) => t.token)), lookup(txs.map((t) => t.selector)), tok ? tokenSection(a, tok) : Promise.resolve(html``),
  ]);
  const title = tok ? `${tok.name || tok.symbol || "Token"} (${tok.symbol})` : isContract ? "Contract" : "Address";
  return { status: 200, title: `${title} ${short(a)}`, body: html`
<h1>${title}</h1><p class="mono wrap">${a}</p>
<dl><dt>Balance</dt><dd>${eth(big(bal))}</dd>
<dt>Type</dt><dd>${isContract ? html`Contract${c?.kind ? html` <span class="tag">${c.kind}</span>` : ""}` : "Account (EOA)"}</dd>
${impl ? html`<dt>Implementation</dt><dd>${link("address", impl, impl)}</dd>` : ""}
${c?.deployer ? html`<dt>Deployed by</dt><dd>${link("address", c.deployer, c.deployer)} in block ${link("block", c.block)}</dd>` : ""}
${isContract ? html`<dt>Code</dt><dd>${(code.length - 2) / 2} bytes</dd>` : ""}</dl>
${token}
<h2>Transactions <span class="muted small">(last 14 days)</span></h2>
${txs.length ? html`<table><tr><th>Tx</th><th>Age</th><th>Method</th><th>From → To</th><th>Value</th></tr>
${txs.map((t) => html`<tr${t.status ? "" : html` class="failed"`}><td>${link("tx", t.hash)}</td><td>${when(t.ts)}</td><td><span class="tag">${method(t.created ? "" : t.selector, names)}</span></td>
<td>${t.from === a ? html`<b>self</b>` : link("address", t.from)} → ${t.created ? "new contract" : t.to === a ? html`<b>self</b>` : t.to ? link("address", t.to) : "—"}</td><td>${eth(t.v)}</td></tr>`)}</table>
${txs.length === 25 ? html`<nav class="pager"><a href="/address/${a}?txb=${txs.at(-1)!.block}${tfb ? `&tfb=${tfb}` : ""}">older →</a></nav>` : ""}` : html`<p class="muted">None in the last 14 days.</p>`}
<h2>Token transfers <span class="muted small">(ERC-20, since our history starts)</span></h2>
${tfs.length ? html`<table><tr><th>Tx</th><th>Age</th><th>Token</th><th>From → To</th><th>Amount</th></tr>
${tfs.map((t) => { const m = tmeta.get(t.token); return html`<tr><td>${link("tx", t.tx_hash)}</td><td>${when(t.ts)}</td><td>${link("address", t.token, sym(m, t.token))}</td>
<td>${t.from === a ? html`<b>self</b>` : link("address", t.from)} → ${t.to === a ? html`<b>self</b>` : link("address", t.to)}</td><td>${m ? units(t.amt, m.decimals) : t.amt}</td></tr>`; })}</table>
${tfs.length === 25 ? html`<nav class="pager"><a href="/address/${a}?tfb=${tfs.at(-1)!.block}${txb ? `&txb=${txb}` : ""}">older →</a></nav>` : ""}` : html`<p class="muted">None.</p>`}` };
}

async function tokenSection(t: string, tok: Token): Promise<Html> {
  const [holders, pools] = await Promise.all([
    rows<{ holder: string; bal: string }>(
      `SELECT holder, toString(sum(balance)) AS bal FROM agg_balances WHERE token = {t:String} AND holder != {z:String} GROUP BY holder HAVING sum(balance) > 0
       ORDER BY sum(balance) DESC LIMIT 20`, { t, z: ZERO }),
    rows<{ pl: string; v: string; q: string; vol: number; hk: string; vf: number }>(
      `SELECT c.pool AS pl, toString(p.venue) AS v, c.q AS q, c.vol AS vol, p.hooks AS hk, p.verified AS vf
       FROM (SELECT pool, any(quote) AS q, sum(volume_usd) AS vol FROM agg_candles_1m WHERE token = {t:String} AND minute > now() - INTERVAL 1 DAY GROUP BY pool) AS c
       INNER JOIN (SELECT * FROM pools FINAL) AS p ON p.pool = c.pool ORDER BY vol DESC LIMIT 10`, { t }),
  ]);
  const best = pools.find((p) => p.vf === 1);
  const chart = best ? await rows<{ h: number; c: number }>(
    `SELECT toUnixTimestamp(toStartOfHour(m)) AS h, argMax(cu, m) AS c FROM (
       SELECT minute AS m, argMaxMerge(close_usd) AS cu FROM agg_candles_1m WHERE token = {t:String} AND pool = {p:String}
         AND minute > now() - INTERVAL 7 DAY GROUP BY minute) WHERE cu > 0 GROUP BY h ORDER BY h`, { t, p: best.pl }) : [];
  const supply = BigInt(tok.supply || "0");
  return html`<h2>Token</h2><dl><dt>Name</dt><dd>${tok.name}</dd><dt>Symbol</dt><dd>${tok.symbol}</dd><dt>Decimals</dt><dd>${tok.decimals}</dd>
<dt>Total supply</dt><dd>${units(supply, tok.decimals, 2)}</dd><dt>Holders</dt><dd>${Number(tok.holder_count).toLocaleString("en-US")}${tok.complete ? "" : html` <span class="muted small">(counted from our history; incomplete for tokens older than it)</span>`}</dd>
${chart.length ? html`<dt>Price</dt><dd>${usd(chart.at(-1)!.c)}</dd>` : ""}</dl>
${best ? html`<h3>Price, last 7 days <span class="muted small">(hourly close, pool ${short(best.pl)})</span></h3>${sparkline(chart.map((r) => [r.h, r.c]))}` : ""}
${pools.length ? html`<h3>Pools (24 h)</h3><table><tr><th>Pool</th><th>Venue</th><th>Quote</th><th>Volume</th><th></th></tr>
${pools.map((p) => html`<tr><td class="mono">${short(p.pl)}</td><td>${p.v}</td><td>${p.q === ZERO ? "ETH" : link("address", p.q)}</td><td>${usd(p.vol)}</td>
<td>${p.vf ? "" : html`<span class="bad small">unverified</span>`} ${p.hk && !/^0x0*$/.test(p.hk) ? html`<span class="tag">hook</span>` : ""}</td></tr>`)}</table>` : ""}
${holders.length ? html`<h3>Top holders</h3><table><tr><th>Holder</th><th>Balance</th><th>Share</th></tr>
${holders.map((h) => html`<tr><td>${link("address", h.holder)}</td><td>${units(h.bal, tok.decimals, 2)}</td><td>${supply > 0n ? `${(Number((BigInt(h.bal) * 10000n) / supply) / 100).toFixed(2)}%` : ""}</td></tr>`)}</table>` : ""}`;
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
${hits.length ? html`<table><tr><th>Token</th><th>Name</th><th>Holders</th></tr>${hits.map((h) => html`<tr><td>${link("address", h.token, h.symbol || short(h.token))}</td><td>${h.name}</td><td>${Number(h.holder_count).toLocaleString("en-US")}</td></tr>`)}</table>`
    : html`<p class="muted">No token matches.</p>`}` };
}
