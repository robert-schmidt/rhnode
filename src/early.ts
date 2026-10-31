// Early buyers of a token: who received it in the first `blocks` after launch, what they paid, what they did since, who
// funded them. Read by the API (GET /v1/tokens/{t}/early-buyers) and the explorer's token pages.
// Built from Transfer logs, not trades, so a bonding-curve buy counts like a pool buy: every ERC-20 transfer is kept
// forever (kept_transfers, live and history), so this answers for any token back to genesis.
// - not a buyer: the zero address, the token, protocol addresses (chain/protocol.ts), the token's pools, hooks and
//   curve, and the markets deduced from the window's tape (an address on one side of ≥40% of its txs, as the client's
//   trade tape does); a contract left holding ≥1% at window close (a launcher or vault; an EIP-7702 wallet stays);
// - bought: what the wallet received in the window; net: received minus sent in it (a buyer that flipped in-window
//   isn't counted at its peak); buyers are the net-positive recipients, in order of their first receipt;
// - paid: the ETH the signer sent with each tx the wallet received in (split by tokens received when a tx served
//   several buyers) plus the WETH, USDG and launch pair token (a Pons curve can be paired with e.g. a stock token)
//   the wallet sent in those txs; each priced at its last 1-minute close before launch, usd_in null if one isn't;
// - wallet_first_block: the wallet's first tx, only when it is known to be its first (nonce 0);
// - since: max_held and the first outflow (any, and to a market) from every later transfer; sold = balance below
//   max held, sold_out = below 10% of it;
// - funding: the wallet's first ETH funder (native_edges), the funder's hub stats, and its links to the deployer;
// - minutes (optional): the first N minutes after launch as a series of new buyers and net inflow into buyers.
import { rows } from "./ch.ts";
import { PROTOCOL } from "./chain/protocol.ts";
import { NATIVE_ETH, USDG, WETH } from "./chain/constants.ts";
import type { Up } from "./cards.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const MAX_WINDOW_ROWS = 50_000, MAX_LATER_ROWS = 300_000;

export type Tf = { block: number; tx_index: number; log_index: number; tx_hash: string; from: string; to: string; amount: bigint; ts: number };
export type Fold = {
  wallet: string; block: number; tx_index: number; log_index: number; tx_hash: string; from: string;
  bought: bigint; net: bigint; txs: Map<string, bigint>; // tx_hash → tokens received in it
};

/** PURE. The addresses on one side of ≥40% of the tape's txs, unless the known markets already explain half of them. */
export function deduceMarkets(tfs: Tf[], known: Set<string>): Set<string> {
  const out = new Set<string>(), txs = new Set(tfs.map((t) => t.tx_hash));
  if (txs.size < 4) return out; // too little tape
  const explained = new Set(tfs.filter((t) => known.has(t.from) || known.has(t.to)).map((t) => t.tx_hash));
  if (explained.size / txs.size >= 0.5) return out;
  const seen = new Map<string, Set<string>>();
  for (const t of tfs) for (const a of [t.from, t.to]) if (a !== ZERO) seen.set(a, (seen.get(a) ?? new Set()).add(t.tx_hash));
  for (const [a, hs] of seen) if (hs.size / txs.size >= 0.4) out.add(a);
  return out;
}

/** PURE. Net-positive recipients of the window (ordered tape), in order of their first receipt. */
export function foldWindow(tfs: Tf[], skip: Set<string>): Fold[] {
  const by = new Map<string, Fold>();
  for (const t of tfs) {
    if (!skip.has(t.to)) {
      let f = by.get(t.to);
      if (!f) by.set(t.to, f = { wallet: t.to, block: t.block, tx_index: t.tx_index, log_index: t.log_index, tx_hash: t.tx_hash, from: t.from, bought: 0n, net: 0n, txs: new Map() });
      f.bought += t.amount; f.net += t.amount; f.txs.set(t.tx_hash, (f.txs.get(t.tx_hash) ?? 0n) + t.amount);
    }
    if (!skip.has(t.from)) by.get(t.from) && (by.get(t.from)!.net -= t.amount);
  }
  return [...by.values()].filter((f) => f.net > 0n);
}

/** PURE. Per minute after t0 (launch time): wallets receiving for the first time, and the net flow into non-skipped
 *  wallets (a transfer between two of them nets out). */
export function perMinute(tfs: Tf[], skip: Set<string>, t0: number, minutes: number) {
  const out = Array.from({ length: minutes }, (_, minute) => ({ minute, new_buyers: 0, net_inflow: 0n, txs: new Set<string>() })), seen = new Set<string>();
  for (const t of tfs) {
    const m = out[Math.floor((t.ts - t0) / 60)];
    if (!m) continue;
    if (!skip.has(t.to)) { m.net_inflow += t.amount; if (!seen.has(t.to)) { seen.add(t.to); m.new_buyers++; } m.txs.add(t.tx_hash); }
    if (!skip.has(t.from)) { m.net_inflow -= t.amount; m.txs.add(t.tx_hash); }
  }
  return out.map((m) => ({ minute: m.minute, new_buyers: m.new_buyers, net_inflow: m.net_inflow.toString(), txs: m.txs.size }));
}

/** PURE. From every transfer of the wallets since launch (ordered): max held, first outflow, first outflow to a market. */
export function since(tfs: Tf[], wallets: Set<string>, markets: Set<string>) {
  const s = new Map<string, { bal: bigint; max: bigint; out: number | null; sell: number | null }>();
  const get = (w: string) => s.get(w) ?? (s.set(w, { bal: 0n, max: 0n, out: null, sell: null }), s.get(w)!);
  for (const t of tfs) {
    if (wallets.has(t.to)) { const w = get(t.to); w.bal += t.amount; if (w.bal > w.max) w.max = w.bal; }
    if (wallets.has(t.from)) {
      const w = get(t.from); w.bal -= t.amount;
      if (w.out == null) w.out = t.block;
      if (w.sell == null && markets.has(t.to)) w.sell = t.block;
    }
  }
  return s;
}

const tf = (r: { block: string; tx_index: number; log_index: number; tx_hash: string; from: string; to: string; amount: string; ts: number }): Tf =>
  ({ block: Number(r.block), tx_index: r.tx_index, log_index: r.log_index, tx_hash: r.tx_hash, from: r.from, to: r.to, amount: BigInt(r.amount), ts: r.ts });
// UInt64/UInt256 arrive as JSON strings; never re-alias a column under its own name (it shadows it in WHERE/ORDER BY)
const TF_COLS = "block, tx_index, log_index, tx_hash, `from`, `to`, amount, toUnixTimestamp(time) AS ts";
const pct = (a: bigint, of: bigint) => (of > 0n ? Number((a * 1_000_000n) / of) / 10_000 : null);

export type Reply = { status: number; body: unknown };

// memoised 30 s per query, shared by the API and the explorer. ponytail: a closed window could be cached for good, but
// balances and funding move; split the two if this ever shows up as load.
const memo = new Map<string, { at: number; p: Promise<Reply> }>();
export function earlyBuyers(up: Up, t: string, blocks: number, n: number, minutes = 0): Promise<Reply> {
  const k = `${t}:${blocks}:${n}:${minutes}`, m = memo.get(k);
  if (m && Date.now() - m.at < 30_000) return m.p;
  if (memo.size > 5_000) memo.clear();
  const p = build(up, t, blocks, n, minutes);
  memo.set(k, { at: Date.now(), p });
  p.catch(() => memo.delete(k));
  return p;
}

async function build(up: Up, t: string, blocks: number, n: number, minutes: number): Promise<Reply> {
  const [[meta], [launch], pools, [created], [tip]] = await Promise.all([
    rows<{ supply: string }>("SELECT toString(total_supply) AS supply FROM serve_tokens FINAL WHERE token = {t:String}", { t }),
    rows<{ block: string; source: string; deployer: string; detail: string }>(
      "SELECT block, source, deployer, detail FROM kept_launches FINAL WHERE token = {t:String} AND kind = 'launch' AND sign = 1 ORDER BY block LIMIT 1", { t }),
    rows<{ pool: string; hooks: string; created_block: string }>(
      "SELECT pool, hooks, created_block FROM pools FINAL WHERE token0 = {t:String} OR token1 = {t:String}", { t }),
    rows<{ deployer: string; block: string }>("SELECT deployer, block FROM contracts FINAL WHERE address = {t:String}", { t }),
    rows<{ b: string }>("SELECT max(block) AS b FROM ctl_cursors FINAL WHERE name = 'tip'"),
  ]);
  if (!meta) return { status: 404, body: { error: "rhnode hasn't seen this token (no ERC-20 transfer yet)" } };
  // launch: the launchpad's event, else the first pool, else the first mint
  let from = launch ? Number(launch.block) : pools.length ? Math.min(...pools.map((p) => Number(p.created_block))) : 0, source = launch ? launch.source : "pool";
  if (!from) {
    const [m] = await rows<{ b: string }>("SELECT toString(min(block)) AS b FROM kept_transfers WHERE token = {t:String} AND `from` = {z:String}", { t, z: ZERO });
    from = Number(m?.b ?? 0); source = "mint";
  }
  if (!from) return { status: 404, body: { error: "no launch, pool or mint of this token is indexed" } };
  const to = from + blocks, head = Number(tip?.b ?? 0), supply = BigInt(meta.supply);
  let curve = "", pair = "";
  try { const d = JSON.parse(launch?.detail ?? "{}"); curve = String(d.curve ?? "").toLowerCase(); pair = String(d.pairToken ?? "").toLowerCase(); } catch { /* no detail */ }
  const quoteTokens = [...new Set([WETH, USDG, ...(/^0x[0-9a-f]{40}$/.test(pair) && pair !== ZERO ? [pair] : [])])];
  const deployer = (launch?.deployer || created?.deployer || "").toLowerCase() || null;

  // the tape: the block window, and the first `minutes` after launch when asked for (one read covers both)
  const t0 = await blockTime(up, from);
  const tape = (await rows<Parameters<typeof tf>[0]>(
    `SELECT ${TF_COLS} FROM kept_transfers FINAL WHERE token = {t:String} AND block >= {a:UInt64} AND (block <= {b:UInt64} OR time < toDateTime({te:UInt64}))
     AND standard = 'erc20' AND sign = 1 ORDER BY block, log_index LIMIT {m:UInt32}`, { t, a: from, b: to, te: t0 + minutes * 60, m: MAX_WINDOW_ROWS + 1 })).map(tf);
  const truncated = tape.length > MAX_WINDOW_ROWS;
  if (truncated) tape.length = MAX_WINDOW_ROWS;
  const win = tape.filter((x) => x.block <= to);
  const known = new Set([...PROTOCOL.keys(), ...pools.flatMap((p) => [p.pool, p.hooks]), ...(curve ? [curve] : [])].filter((a) => /^0x[0-9a-f]{40}$/.test(a)));
  const markets = new Set([...known, ...deduceMarkets(win, known)]);
  const skip = new Set([ZERO, t, ...markets]);
  let folds = foldWindow(win, skip);

  // a contract left holding ≥1% at window close is a launcher or vault (an EIP-7702 wallet has 0xef0100… code and stays)
  const code = new Map<string, boolean>();
  const isContract = async (ws: string[]) => {
    const got = await Promise.all(ws.map((a) => up.call<string>("eth_getCode", [a, "latest"]).catch(() => null)));
    ws.forEach((a, i) => { const c = got[i]; if (c != null) code.set(a, c !== "0x" && !c.startsWith("0xef0100")); });
  };
  const big = folds.filter((f) => f.net * 100n >= supply).map((f) => f.wallet);
  await isContract(big);
  const vaults = new Set(big.filter((a) => code.get(a)));
  folds = folds.filter((f) => !vaults.has(f.wallet));
  const skipped = [...new Set(win.flatMap((x) => [x.from, x.to]))].filter((a) => skip.has(a) || vaults.has(a)).length;
  const buyers = folds.slice(0, n), ws = buyers.map((b) => b.wallet), wset = new Set(ws);
  const txh = [...new Set(buyers.flatMap((b) => [...b.txs.keys()]))];

  const [later, bals, signers, funders, firsts, quotes, prices, decs] = await Promise.all([
    ws.length ? rows<Parameters<typeof tf>[0]>(
      `SELECT ${TF_COLS} FROM kept_transfers FINAL WHERE token = {t:String} AND block >= {a:UInt64} AND standard = 'erc20' AND sign = 1
       AND (\`from\` IN {w:Array(String)} OR \`to\` IN {w:Array(String)}) ORDER BY block, log_index LIMIT {m:UInt32}`, { t, a: from, w: ws, m: MAX_LATER_ROWS }).then((r) => r.map(tf)) : [],
    ws.length ? rows<{ holder: string; b: string }>(
      "SELECT holder, toString(sum(balance)) AS b FROM agg_balances WHERE token = {t:String} AND holder IN {w:Array(String)} GROUP BY holder", { t, w: ws }) : [],
    txSigners(up, txh),
    ws.length || deployer ? rows<{ dst: string; src: string; block: string }>(
      `SELECT dst, src, block FROM native_edges FINAL WHERE dst IN {w:Array(String)} ORDER BY block, tx_index, path LIMIT 1 BY dst`,
      { w: [...ws, ...(deployer ? [deployer] : [])] }) : [],
    ws.length ? rows<{ wallet: string; b: string; nonce: string }>(
      "SELECT wallet, toString(min(first).1) AS b, toString(min(first).3) AS nonce FROM agg_wallet_first WHERE wallet IN {w:Array(String)} GROUP BY wallet", { w: ws }) : [],
    txh.length ? rows<{ token: string; from: string; tx_hash: string; amount: string }>(
      `SELECT token, \`from\`, tx_hash, amount FROM kept_transfers FINAL WHERE token IN {q:Array(String)} AND block >= {a:UInt64} AND block <= {b:UInt64}
       AND tx_hash IN {h:Array(String)} AND sign = 1`, { q: quoteTokens, a: from, b: to, h: txh }) : [],
    rows<{ token: string; p: number }>(`SELECT token, argMaxMerge(close_usd) AS p FROM agg_candles_1m WHERE token IN {q:Array(String)}
      AND minute <= toDateTime({at:UInt64}) AND minute >= toDateTime({at:UInt64}) - 3600 GROUP BY token`, { q: [NATIVE_ETH, ...quoteTokens], at: t0 }),
    rows<{ token: string; decimals: number }>("SELECT token, decimals FROM serve_tokens FINAL WHERE token IN {q:Array(String)}", { q: quoteTokens }),
  ]);
  const px = new Map(prices.filter((r) => r.p > 0).map((r) => [r.token, Number(r.p)]));
  const ethUsd = px.get(NATIVE_ETH) ?? px.get(WETH) ?? null;
  px.set(USDG, 1); if (ethUsd != null) { px.set(NATIVE_ETH, ethUsd); px.set(WETH, ethUsd); }
  const dec = new Map<string, number>([[NATIVE_ETH, 18], [WETH, 18], [USDG, 6], ...decs.map((d) => [d.token, d.decimals] as [string, number])]);

  // ETH the signers sent with each tx, then split among the buyers by tokens received in it
  const sig = new Map(signers.map((s) => [s.hash, s]));
  const recvd = new Map<string, bigint>(); // tx → tokens all buyers received in it
  for (const b of buyers) for (const [h, a] of b.txs) recvd.set(h, (recvd.get(h) ?? 0n) + a);
  const fund = new Map(funders.map((f) => [f.dst, f]));
  const hubs = funders.length ? new Map((await rows<{ src: string; edges: string; wallets: string }>(
    "SELECT src, toString(uniqMerge(n)) AS edges, toString(uniqMerge(peers)) AS wallets FROM agg_native_src WHERE src IN {s:Array(String)} GROUP BY src",
    { s: [...new Set(funders.map((f) => f.src))] })).map((h) => [h.src, h])) : new Map<string, { edges: string; wallets: string }>();
  const deployerFunder = deployer ? fund.get(deployer)?.src ?? null : null;
  await isContract(ws.filter((a) => !code.has(a)));
  const s = since(later, wset, markets), bal = new Map(bals.map((b) => [b.holder, BigInt(b.b)]));
  const first = new Map(firsts.filter((f) => f.nonce === "0").map((f) => [f.wallet, Number(f.b)]));

  // groups: the rank of the first buyer sharing the tx / block / signer, when more than one does
  const group = (key: (b: Fold) => string | undefined) => {
    const firstOf = new Map<string, number>(), count = new Map<string, number>();
    buyers.forEach((b, i) => { const k = key(b); if (k) { if (!firstOf.has(k)) firstOf.set(k, i + 1); count.set(k, (count.get(k) ?? 0) + 1); } });
    return (b: Fold) => { const k = key(b); return k && count.get(k)! > 1 ? firstOf.get(k)! : null; };
  };
  const gTx = group((b) => b.tx_hash), gBlock = group((b) => String(b.block)), gSigner = group((b) => sig.get(b.tx_hash)?.from);
  const via = (b: Fold) => (b.from === curve ? "curve" : PROTOCOL.get(b.from)?.kind === "relay" ? "relay"
    : markets.has(b.from) ? "pool" : b.from === ZERO ? "mint" : "transfer");

  return { status: 200, body: {
    token: t, launch_block: from, launch_source: source, window: { from_block: from, to_block: to }, closed: to <= head,
    total_supply: supply.toString(), deployer, deployer_first_funder: deployerFunder, skipped, truncated, pair_token: pair && pair !== ZERO ? pair : null,
    eth_usd: ethUsd, launch_time: t0 || null,
    ...(minutes ? { minutes: perMinute(tape, new Set([...skip, ...vaults]), t0, minutes) } : {}),
    buyers: buyers.map((b, i) => {
      const raw = new Map<string, bigint>();
      for (const [h, a] of b.txs) {
        const v = sig.get(h)?.value ?? 0n, all = recvd.get(h) ?? a;
        if (v > 0n && all > 0n) raw.set(NATIVE_ETH, (raw.get(NATIVE_ETH) ?? 0n) + (v * a) / all);
        for (const q of quotes) if (q.tx_hash === h && q.from === b.wallet) raw.set(q.token, (raw.get(q.token) ?? 0n) + BigInt(q.amount));
      }
      const paid = [...raw].map(([token, r]) => {
        const d = dec.get(token), amount = d == null ? null : Number(r) / 10 ** d, p = px.get(token);
        return { token, raw: r.toString(), amount, usd: amount != null && p != null ? amount * p : null };
      });
      const w = s.get(b.wallet), now = bal.get(b.wallet) ?? 0n;
      const f = fund.get(b.wallet), hub = f && hubs.get(f.src);
      return {
        rank: i + 1, block: b.block, tx_index: b.tx_index, log_index: b.log_index, tx_hash: b.tx_hash, signer: sig.get(b.tx_hash)?.from ?? null,
        wallet: b.wallet, via: via(b), from: b.from, bought: b.bought.toString(), net: b.net.toString(), pct: pct(b.net, supply),
        paid, usd_in: paid.some((x) => x.usd == null) ? null : paid.reduce((a, x) => a + x.usd!, 0),
        balance: now.toString(), max_held: (w?.max ?? b.net).toString(), sold: now < (w?.max ?? b.net), sold_out: now * 10n < (w?.max ?? b.net),
        first_out_block: w?.out ?? null, first_sell_block: w?.sell ?? null,
        groups: { same_tx: gTx(b), same_block: gBlock(b), same_signer: gSigner(b) },
        funding: f ? { funder: f.src, block: Number(f.block), funder_n: Number(hub?.edges ?? 0), funder_peers: Number(hub?.wallets ?? 0),
          funder_is_deployer: !!deployer && f.src === deployer, funder_shared_with_deployer: !!deployerFunder && f.src === deployerFunder } : null,
        wallet_first_block: first.get(b.wallet) ?? null, is_contract: code.get(b.wallet) ?? null,
      };
    }),
    block: head,
  } };
}

/** Signer and ETH value of txs by hash: raw/kept txs, else the node. */
async function txSigners(up: Up, hashes: string[]): Promise<{ hash: string; from: string; value: bigint }[]> {
  if (!hashes.length) return [];
  const got = await rows<{ hash: string; from: string; value: string }>(
    "SELECT hash, `from`, value FROM raw_txs WHERE hash IN {h:Array(String)} UNION ALL SELECT hash, `from`, value FROM kept_txs WHERE hash IN {h:Array(String)}", { h: hashes });
  const m = new Map(got.map((r) => [r.hash, { hash: r.hash, from: r.from, value: BigInt(r.value) }]));
  await Promise.all(hashes.filter((h) => !m.has(h)).map(async (h) => {
    const x = await up.call<{ from: string; value: string } | null>("eth_getTransactionByHash", [h]).catch(() => null);
    if (x) m.set(h, { hash: h, from: x.from.toLowerCase(), value: BigInt(x.value) });
  }));
  return [...m.values()];
}

async function blockTime(up: Up, b: number): Promise<number> {
  const [r] = await rows<{ ts: number }>("SELECT toUnixTimestamp(time) AS ts FROM raw_blocks WHERE number = {b:UInt64} UNION ALL SELECT toUnixTimestamp(time) FROM kept_blocks WHERE number = {b:UInt64} LIMIT 1", { b });
  if (r) return r.ts;
  const x = await up.call<{ timestamp: string } | null>("eth_getBlockByNumber", ["0x" + b.toString(16), false]).catch(() => null);
  return x ? Number(x.timestamp) : 0;
}
