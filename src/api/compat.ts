// Etherscan/Blockscout-compatible subset (ARCHITECTURE §6): the v1 `/api?module=…&action=…` calls and the v2 token
// card apps already make, answered from ClickHouse when the answer is exact. When it isn't (a window that starts
// before our data, holders of a token older than go-live), the request is proxied to Blockscout if
// BLOCKSCOUT_API_KEY is set, else answered 503, which clients read as "unknown" (never as "empty").
import { cfg } from "../config.ts";
import { insert, rows } from "../ch.ts";
import { coverage } from "./coverage.ts";
import { handle, up } from "./rpc.ts";

export type Reply = { status: number; body: unknown };
const ok = (result: unknown[]): Reply => ({ status: 200, body: result.length ? { status: "1", message: "OK", result } : { status: "0", message: "No transactions found", result: [] } });
const bad = (msg: string): Reply => ({ status: 200, body: { status: "0", message: "NOTOK", result: msg } });
const ADDR = /^0x[0-9a-f]{40}$/;
const PRO = "https://api.blockscout.com/4663";

/** Not answerable exactly here: Blockscout when configured, else 503 with the reason. */
async function fallback(path: string, q: URLSearchParams, why: string): Promise<Reply> {
  if (!cfg.api.blockscoutKey) return { status: 503, body: { status: "0", message: "NOTOK", result: `rhnode: ${why}` } };
  const qs = new URLSearchParams(q);
  qs.set("apikey", cfg.api.blockscoutKey);
  const r = await fetch(`${PRO}${path}?${qs}`, { signal: AbortSignal.timeout(15_000) });
  return { status: r.status, body: await r.json().catch(() => ({ status: "0", message: "NOTOK", result: `blockscout: HTTP ${r.status}` })) };
}

/** A paged window [start, end] is exact when it lies inside raw coverage, or (newest first) when the page fills up
 *  before the window leaves coverage. `fullFrom`: the entity's whole history is held from that block on. */
async function windowed<T>(q: URLSearchParams, fullFrom: number, fetchPage: (lo: number, hi: number, desc: boolean, limit: number, skip: number) => Promise<T[]>) {
  const cov = await coverage();
  const start = Number(q.get("startblock") ?? 0), end = Number(q.get("endblock") ?? 9e15);
  const page = Math.max(1, Number(q.get("page") ?? 1)), offset = Math.min(10_000, Math.max(1, Number(q.get("offset") ?? 10_000)));
  const desc = q.get("sort") === "desc";
  const lo = Math.max(start, cov.rawFrom), hi = Math.min(end, cov.ingested);
  const covered = start >= Math.min(cov.rawFrom, fullFrom);
  if (!covered && !desc) return null;
  const got = hi >= lo ? await fetchPage(lo, hi, desc, offset, (page - 1) * offset) : [];
  return covered || got.length === offset ? got : null;
}

/** Queue a token older than go-live for promotion (src/promoter), once. Returns its promotion status ("" if none). */
const promoState = new Map<string, { status: string; at: number }>();
async function promotion(token: string, enqueue: boolean): Promise<string> {
  const c = promoState.get(token);
  if (c && (["done", "skipped", "notoken"].includes(c.status) || (Date.now() - c.at < 10_000 && (c.status || !enqueue)))) return c.status;
  const [r] = await rows<{ status: string }>("SELECT status FROM ctl_promotions FINAL WHERE token = {t:String}", { t: token });
  let status = r?.status ?? "";
  if (!status && enqueue) {
    await insert("ctl_promotions", [{ token, status: "queued", transfers: 0, note: "", version: Date.now() }], `queue:${token}`);
    status = "queued";
  }
  promoState.set(token, { status, at: Date.now() });
  return status;
}
const refused = (status: string) =>
  status === "skipped" ? "too many transfers before rhnode started indexing to hold its history"
  : status === "notoken" ? "no ERC-20 transfers at this address"
  : status === "incomplete" || status === "failed" ? `history before rhnode started indexing: promotion ${status}`
  : "history before rhnode started indexing is being fetched (promotion queued); ask again in a few minutes";

type Tx = { block: string; ts: number; tx_hash: string; log_index: number; tx_index: number; token: string; from: string; to: string; amount: string; name: string | null; symbol: string | null; decimals: number | null };

async function tokentx(q: URLSearchParams): Promise<Reply> {
  const wallet = q.get("address")?.toLowerCase(), token = q.get("contractaddress")?.toLowerCase();
  if ((wallet && !ADDR.test(wallet)) || (token && !ADDR.test(token)) || (!wallet && !token)) return bad("address or contractaddress required");
  // History from block 0 is held for a promoted token, or one launched inside the raw window (its whole life is in raw).
  // Not "complete" balances: those only say the supply was 0 at go-live, not that nothing happened before (wRDDT).
  let fullFrom = Infinity;
  if (token && !wallet && (await promotion(token, false)) === "done") return tokentxKept(q, token);
  if (token && !wallet) {
    const [t] = await rows<{ launched: string }>("SELECT min(block) AS launched FROM kept_launches WHERE token = {t:String} AND kind = 'launch'", { t: token });
    if (Number(t?.launched) && Number(t.launched) >= (await coverage()).rawFrom) fullFrom = 0;
  }
  const got = await windowed<Tx>(q, fullFrom, (lo, hi, desc, limit, skip) => rows<Tx>(
    `SELECT t.block, toUnixTimestamp(t.time) AS ts, t.tx_hash, t.log_index, t.tx_index, t.token, t.\`from\` AS \`from\`, t.\`to\` AS \`to\`, toString(t.amount) AS amount, s.name, s.symbol, s.decimals
     FROM ev_transfers AS t LEFT JOIN (SELECT token, name, symbol, decimals FROM serve_tokens FINAL) AS s ON s.token = t.token
     WHERE t.standard = 'erc20' AND t.sign = 1 AND t.block BETWEEN {lo:UInt64} AND {hi:UInt64}
       ${token ? "AND t.token = {token:String}" : ""} ${wallet ? "AND (t.\`from\` = {wallet:String} OR t.\`to\` = {wallet:String})" : ""}
     ORDER BY t.block ${desc ? "DESC" : "ASC"}, t.log_index ${desc ? "DESC" : "ASC"}, t.batch_index LIMIT {limit:UInt32} OFFSET {skip:UInt32}
     SETTINGS join_use_nulls = 1`, { lo, hi, limit, skip, token: token ?? "", wallet: wallet ?? "" }));
  if (!got) return fallback("/api", q, token && !wallet ? refused(await promotion(token, true)) : "this window starts before the data rhnode holds");
  return ok(await txRows(got));
}

/** A promoted token: its whole history is in kept_transfers (backfill + everything kept since). */
async function tokentxKept(q: URLSearchParams, token: string): Promise<Reply> {
  const cov = await coverage();
  const lo = Number(q.get("startblock") ?? 0), hi = Math.min(Number(q.get("endblock") ?? 9e15), cov.ingested);
  const page = Math.max(1, Number(q.get("page") ?? 1)), offset = Math.min(10_000, Math.max(1, Number(q.get("offset") ?? 10_000)));
  const desc = q.get("sort") === "desc" ? "DESC" : "ASC";
  const got = await rows<Tx>(
    `SELECT t.block, toUnixTimestamp(t.time) AS ts, t.tx_hash, t.log_index, t.tx_index, t.token, t.\`from\` AS \`from\`, t.\`to\` AS \`to\`, toString(t.amount) AS amount, s.name, s.symbol, s.decimals
     FROM (SELECT * FROM kept_transfers FINAL WHERE token = {token:String} AND standard = 'erc20' AND block BETWEEN {lo:UInt64} AND {hi:UInt64}) AS t
     LEFT JOIN (SELECT token, name, symbol, decimals FROM serve_tokens FINAL WHERE token = {token:String}) AS s ON s.token = t.token
     WHERE t.sign = 1 ORDER BY t.block ${desc}, t.log_index ${desc}, t.batch_index LIMIT {limit:UInt32} OFFSET {skip:UInt32}
     SETTINGS join_use_nulls = 1`, { token, lo, hi, limit: offset, skip: (page - 1) * offset });
  return ok(await txRows(got));
}

async function txRows(got: Tx[]) {
  const head = (await coverage()).ingested;
  return got.map((t) => ({
    blockNumber: String(t.block), timeStamp: String(t.ts), hash: t.tx_hash, nonce: "", blockHash: "", from: t.from, to: t.to,
    contractAddress: t.token, value: t.amount, tokenName: t.name ?? "", tokenSymbol: t.symbol ?? "", tokenDecimal: t.decimals == null || t.decimals < 0 ? "" : String(t.decimals),
    transactionIndex: String(t.tx_index), logIndex: String(t.log_index), gas: "", gasPrice: "", gasUsed: "", cumulativeGasUsed: "", input: "deprecated",
    confirmations: String(Math.max(0, head - Number(t.block))),
  }));
}

type Txl = { block: string; ts: number; hash: string; tx_index: number; from: string; to: string; value: string; selector: string; input: string; status: number; gas_used: string; price: string; nonce: string; created: string };

async function txlist(q: URLSearchParams): Promise<Reply> {
  const wallet = q.get("address")?.toLowerCase();
  if (!wallet || !ADDR.test(wallet)) return bad("address required");
  const got = await windowed<Txl>(q, Infinity, (lo, hi, desc, limit, skip) => rows<Txl>(
    `SELECT block, toUnixTimestamp(time) AS ts, hash, tx_index, \`from\`, \`to\`, toString(value) AS value, selector, input, status, gas_used, effective_gas_price AS price, nonce, created
     FROM raw_txs WHERE sign = 1 AND block BETWEEN {lo:UInt64} AND {hi:UInt64} AND (\`from\` = {w:String} OR \`to\` = {w:String} OR created = {w:String})
     ORDER BY block ${desc ? "DESC" : "ASC"}, tx_index ${desc ? "DESC" : "ASC"} LIMIT {limit:UInt32} OFFSET {skip:UInt32}`, { lo, hi, limit, skip, w: wallet }));
  if (!got) return fallback("/api", q, "this window starts before the data rhnode holds");
  const head = (await coverage()).ingested;
  return ok(got.map((t) => ({
    blockNumber: String(t.block), timeStamp: String(t.ts), hash: t.hash, nonce: String(t.nonce), blockHash: "", transactionIndex: String(t.tx_index),
    from: t.from, to: t.to, value: t.value, gas: "", gasPrice: String(t.price), gasUsed: String(t.gas_used), cumulativeGasUsed: "",
    isError: t.status === 1 ? "0" : "1", txreceipt_status: String(t.status), input: t.input, contractAddress: t.created, methodId: t.selector, functionName: "",
    confirmations: String(Math.max(0, head - Number(t.block))),
  })));
}

async function holders(q: URLSearchParams): Promise<Reply> {
  const token = q.get("contractaddress")?.toLowerCase();
  if (!token || !ADDR.test(token)) return bad("contractaddress required");
  const page = Math.max(1, Number(q.get("page") ?? 1)), offset = Math.min(10_000, Math.max(1, Number(q.get("offset") ?? 100)));
  const [t] = await rows<{ complete: number }>("SELECT complete FROM serve_tokens FINAL WHERE token = {t:String}", { t: token });
  if (!t?.complete) return fallback("/api", q, refused(await promotion(token, true)));
  const hs = await rows<{ holder: string; b: string }>(
    `SELECT holder, toString(sum(balance) AS bal) AS b FROM agg_balances WHERE token = {t:String} AND holder != '0x0000000000000000000000000000000000000000'
     GROUP BY holder HAVING bal > 0 ORDER BY bal DESC, holder LIMIT {limit:UInt32} OFFSET {skip:UInt32}`, { t: token, limit: offset, skip: (page - 1) * offset });
  return { status: 200, body: { status: "1", message: "OK", result: hs.map((h) => ({ address: h.holder, value: h.b })) } };
}

async function balances(q: URLSearchParams): Promise<Reply> {
  const list = (q.get("address") ?? "").toLowerCase().split(",").filter((a) => ADDR.test(a)).slice(0, 20);
  if (!list.length) return bad("address required");
  const out = await Promise.all(list.map(async (a) => ({ account: a, r: await up.forward("eth_getBalance", [a, "latest"]) })));
  if (out.some((o) => o.r.error)) return fallback("/api", q, "upstream error");
  const result = out.map((o) => ({ account: o.account, balance: BigInt(o.r.result as string).toString() }));
  return { status: 200, body: { status: "1", message: "OK", result: q.get("action") === "balance" ? result[0].balance : result } };
}

async function logs(q: URLSearchParams): Promise<Reply> {
  const topics = [0, 1, 2, 3].map((i) => q.get(`topic${i}`)?.toLowerCase() ?? null);
  // ponytail: only AND between topics (topicX_Y_opr=or is rare); anything else goes to the fallback.
  if ([...q.keys()].some((k) => /_opr$/.test(k) && q.get(k) !== "and")) return fallback("/api", q, "only topicX_Y_opr=and is supported");
  const num = (k: string, d: string) => { const v = q.get(k); return !v || v === "latest" ? d : "0x" + Number(v).toString(16); };
  const r = await handle("eth_getLogs", [{ fromBlock: num("fromBlock", "latest"), toBlock: num("toBlock", "latest"), address: q.get("address") ?? undefined, topics }]);
  if (r.error) return fallback("/api", q, r.error.message);
  return ok((r.result as Record<string, string>[]).map((l) => ({ ...l, timeStamp: l.blockTimestamp })));
}

// contract.getsourcecode from Sourcify (keyless; ~37% of the top-40 tokens matched on 2026-10-30). Only a match is an
// answer: "not on Sourcify" isn't "not verified" (Blockscout verifies on its own), so that's a 503 → Blockscout.
// Matches are kept (bounded, newest 1,000); a miss is remembered for a day so we don't ask again.
const SOURCIFY = "https://sourcify.dev/server/v2/contract/4663/";
const sources = new Map<string, { at: number; row: Record<string, string> | null }>();
type Sourcify = {
  match?: string | null; abi?: unknown;
  compilation?: { compilerVersion?: string; name?: string; compilerSettings?: { optimizer?: { enabled?: boolean; runs?: number }; evmVersion?: string } };
  proxyResolution?: { isProxy?: boolean; implementations?: { address: string }[] };
  sources?: Record<string, { content?: string }>;
};

// Sourcify doesn't resolve every proxy (a BeaconProxy shows isProxy false): read the EIP-1967 slots on chain then.
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const slotAddr = async (a: string, slot: string) => {
  const r = (await up.forward("eth_getStorageAt", [a, slot, "latest"])) as { result?: string };
  return r.result && BigInt(r.result) ? "0x" + r.result.slice(-40) : "";
};
async function implementation(a: string): Promise<string> {
  const impl = await slotAddr(a, IMPL_SLOT);
  if (impl) return impl;
  const beacon = await slotAddr(a, BEACON_SLOT);
  if (!beacon) return "";
  const r = (await up.forward("eth_call", [{ to: beacon, data: "0x5c60da1b" }, "latest"])) as { result?: string }; // implementation()
  return r.result && r.result.length >= 66 && BigInt(r.result) ? "0x" + r.result.slice(26, 66) : "";
}

async function sourcecode(q: URLSearchParams): Promise<Reply> {
  const a = q.get("address")?.toLowerCase();
  if (!a || !ADDR.test(a)) return bad("address required");
  let c = sources.get(a);
  if (!c || (!c.row && Date.now() - c.at > 86_400_000)) {
    const r = await fetch(`${SOURCIFY}${a}?fields=compilation,abi,proxyResolution,sources`, { signal: AbortSignal.timeout(15_000) });
    if (r.status !== 200 && r.status !== 404) return fallback("/api", q, `sourcify: HTTP ${r.status}`);
    const j = r.status === 200 ? ((await r.json()) as Sourcify) : null;
    const s = j?.match ? j : null;
    const impl = s && (s.proxyResolution?.implementations?.[0]?.address.toLowerCase() || await implementation(a).catch(() => ""));
    c = { at: Date.now(), row: s && {
      // Etherscan's multi-file convention: the standard-json input wrapped in an extra pair of braces.
      SourceCode: `{${JSON.stringify({ language: "Solidity", sources: s.sources ?? {} })}}`,
      ABI: JSON.stringify(s.abi ?? []),
      ContractName: s.compilation?.name ?? "",
      CompilerVersion: s.compilation?.compilerVersion ? `v${s.compilation.compilerVersion}` : "",
      OptimizationUsed: s.compilation?.compilerSettings?.optimizer?.enabled ? "1" : "0",
      Runs: String(s.compilation?.compilerSettings?.optimizer?.runs ?? ""),
      EVMVersion: s.compilation?.compilerSettings?.evmVersion ?? "default",
      IsProxy: s.proxyResolution?.isProxy || impl ? "true" : "false",
      ImplementationAddress: impl || "",
      ConstructorArguments: "", Library: "", LicenseType: "", SwarmSource: "",
    } };
    sources.delete(a);
    sources.set(a, c);
    for (const k of sources.keys()) { if (sources.size <= 1_000) break; sources.delete(k); }
  }
  if (!c.row) return fallback("/api", q, "not verified on Sourcify (it may still be on Blockscout)");
  return { status: 200, body: { status: "1", message: "OK", result: [c.row] } };
}

export async function v1(q: URLSearchParams): Promise<Reply> {
  const m = `${q.get("module")}.${q.get("action")}`;
  switch (m) {
    case "block.eth_block_number": return { status: 200, body: { jsonrpc: "2.0", id: 1, result: (await handle("eth_blockNumber")).result } };
    case "token.getTokenHolders": return holders(q);
    case "account.tokentx": return tokentx(q);
    case "account.txlist": return txlist(q);
    case "account.balancemulti": case "account.balance": return balances(q);
    case "logs.getLogs": return logs(q);
    case "contract.getsourcecode": return sourcecode(q);
    default: return fallback("/api", q, `${m} isn't served by rhnode`);
  }
}

export async function v2(path: string, q: URLSearchParams): Promise<Reply> {
  const m = path.match(/^\/api\/v2\/tokens\/(0x[0-9a-fA-F]{40})$/);
  if (!m) return fallback(path, q, `${path} isn't served by rhnode`);
  const [t] = await rows<{ token: string; name: string; symbol: string; decimals: number; supply: string; holders: string; complete: number }>(
    "SELECT token, name, symbol, decimals, toString(total_supply) AS supply, toString(holder_count) AS holders, complete FROM serve_tokens FINAL WHERE token = {t:String}",
    { t: m[1].toLowerCase() });
  if (!t?.complete) return fallback(path, q, refused(await promotion(m[1].toLowerCase(), true)));
  return { status: 200, body: {
    address: t.token, address_hash: t.token, name: t.name, symbol: t.symbol, decimals: t.decimals < 0 ? null : String(t.decimals), total_supply: t.supply,
    holders_count: t.holders, holders: t.holders, type: "ERC-20", exchange_rate: null,
  } };
}

// GET /v1/wallets/{a}/first: the first tx rhnode saw this wallet send (agg_wallet_first, kept forever) and what it
// means. born "exact": nonce 0, the wallet's real first tx; "before": it sent txs before rhnode's data starts (dataFrom);
// "unknown": it hasn't sent a tx since then (it may only have received).
let dataFrom: { block: number; timeStamp: number } | null = null;
export async function walletFirst(wallet: string): Promise<Reply> {
  const w = wallet.toLowerCase();
  if (!ADDR.test(w)) return { status: 400, body: { error: "bad address" } };
  if (!dataFrom) {
    const [d] = await rows<{ b: string; t: number }>("SELECT min(tupleElement(first, 1)) AS b, toUnixTimestamp(min(tupleElement(first, 4))) AS t FROM agg_wallet_first");
    if (Number(d?.b)) dataFrom = { block: Number(d.b), timeStamp: d.t };
  }
  const [r] = await rows<{ block: string; nonce: string; ts: number; hash: string }>(
    `SELECT tupleElement(f, 1) AS block, tupleElement(f, 3) AS nonce, toUnixTimestamp(tupleElement(f, 4)) AS ts, tupleElement(f, 5) AS hash
     FROM (SELECT min(first) AS f FROM agg_wallet_first WHERE wallet = {w:String} HAVING count() > 0)`, { w });
  return { status: 200, body: {
    wallet: w, dataFrom,
    firstTx: r ? { block: Number(r.block), timeStamp: r.ts, hash: r.hash, nonce: Number(r.nonce) } : null,
    born: !r ? "unknown" : Number(r.nonce) === 0 ? "exact" : "before",
  } };
}
