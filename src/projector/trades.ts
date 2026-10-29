// Trades: which wallet ACTED, what its balance of a token did, and what the swaps that did it were worth
// (ARCHITECTURE §3.3 ev_trades). Facts only; opinions (maybe-buy, copy gates) stay in the apps.
//
// Who acted, without traces:
// - a plain tx: its signer;
// - an ERC-4337 bundle (EntryPoint): each userOp's sender. The EntryPoint emits an op's own logs and then its
//   UserOperationEvent, so an op owns the logs after the previous UserOperationEvent up to its own;
// - a Relay fill: the recipient (they paid on another chain; ev_relay says how much in USDG/WETH).
// A trade needs both: a priced swap of the token in the actor's segment AND a net change in the actor's own
// balance of it. A router or solver moving tokens for someone else changes nothing of its own and isn't a trade.
import { insert, rows } from "../ch.ts";
import { USDG } from "../chain/constants.ts";

export const USER_OP_EVENT = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";

type Transfer = { log_index: number; token: string; from: string; to: string; amount: string };
type Price = { log_index: number; token: string; quote: string; token_delta: string; usd: number; quote_amount: number };
type UserOp = { log_index: number; sender: string };
export type Trade = { wallet: string; token: string; amount: bigint; usd: number; eth: number; via: "swap" | "userop" };

/** PURE. One tx → its trades. */
export function tradesOfTx(signer: string, transfers: Transfer[], prices: Price[], userOps: UserOp[]): Trade[] {
  const segments = userOps.length
    ? userOps.map((op, i) => ({ actor: op.sender, via: "userop" as const, lo: i ? userOps[i - 1].log_index : -1, hi: op.log_index }))
    : [{ actor: signer, via: "swap" as const, lo: -1, hi: Infinity }];
  const out: Trade[] = [];
  for (const seg of segments) {
    const inSeg = (l: { log_index: number }) => l.log_index > seg.lo && l.log_index < seg.hi;
    const swaps = prices.filter(inSeg);
    for (const token of new Set(swaps.map((p) => p.token))) {
      let delta = 0n;
      for (const t of transfers) {
        if (!inSeg(t) || t.token !== token) continue;
        if (t.to === seg.actor) delta += BigInt(t.amount);
        if (t.from === seg.actor) delta -= BigInt(t.amount);
      }
      if (delta === 0n) continue;
      // Value: the swaps of this token in this segment that went the same way as the wallet's balance.
      const same = swaps.filter((p) => p.token === token && (BigInt(p.token_delta) > 0n) === delta > 0n);
      out.push({
        wallet: seg.actor, token, amount: delta, via: seg.via,
        usd: same.reduce((a, p) => a + p.usd, 0),
        eth: same.filter((p) => p.quote !== USDG).reduce((a, p) => a + p.quote_amount, 0),
      });
    }
  }
  return out;
}

/** Trades for every tx in (from, to] with a priced swap, plus Relay fills. */
export async function deriveTrades(from: number, to: number): Promise<number> {
  const r = { from, to };
  const txs = await rows<{ block: string; tx_index: number; tx_hash: string; time: string; signer: string; keep: number }>(
    `SELECT block, tx_index, hash AS tx_hash, time, \`from\` AS signer, keep FROM raw_txs
     WHERE block > {from:UInt64} AND block <= {to:UInt64} AND hash IN (SELECT tx_hash FROM ev_prices WHERE block > {from:UInt64} AND block <= {to:UInt64})`, r);
  const byTx = <T extends { tx_hash: string }>(xs: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of xs) (m.get(x.tx_hash) ?? m.set(x.tx_hash, []).get(x.tx_hash)!).push(x);
    return m;
  };
  const inRange = "block > {from:UInt64} AND block <= {to:UInt64} AND tx_hash IN (SELECT tx_hash FROM ev_prices WHERE block > {from:UInt64} AND block <= {to:UInt64})";
  const transfers = byTx(await rows<Transfer & { tx_hash: string }>(
    `SELECT tx_hash, log_index, token, \`from\`, \`to\`, toString(amount) AS amount FROM ev_transfers WHERE standard = 'erc20' AND sign = 1 AND ${inRange}`, r));
  const prices = byTx(await rows<Price & { tx_hash: string }>(
    `SELECT tx_hash, log_index, token, quote, toString(token_delta) AS token_delta, usd, quote_amount FROM ev_prices WHERE sign = 1 AND ${inRange}`, r));
  const ops = byTx(await rows<UserOp & { tx_hash: string }>(
    `SELECT tx_hash, log_index, concat('0x', substring(topic2, 27)) AS sender FROM raw_logs WHERE topic0 = {uoe:String} AND ${inRange} ORDER BY log_index`,
    { ...r, uoe: USER_OP_EVENT }));

  const out: object[] = [];
  for (const tx of txs) {
    for (const t of tradesOfTx(tx.signer, transfers.get(tx.tx_hash) ?? [], prices.get(tx.tx_hash) ?? [], ops.get(tx.tx_hash) ?? [])) {
      out.push({ block: tx.block, tx_index: tx.tx_index, tx_hash: tx.tx_hash, time: tx.time, wallet: t.wallet, token: t.token,
        side: t.amount > 0n ? "buy" : "sell", amount: t.amount.toString(), usd: t.usd, eth: t.eth, via: t.via, keep: tx.keep, sign: 1 });
    }
  }
  // Relay fills: the recipient bought, paid in USDG and/or WETH on the solver's side.
  const ethUsd = Number((await rows<{ p: number }>("SELECT eth_usd AS p FROM ev_prices WHERE block <= {to:UInt64} AND eth_usd > 0 ORDER BY block DESC LIMIT 1", r))[0]?.p ?? 0);
  for (const f of await rows<{ block: string; tx_index: number; tx_hash: string; time: string; recipient: string; token: string; amount: string; usdg_in: string; weth_in: string; keep: number }>(
    `SELECT block, tx_index, tx_hash, time, recipient, token, toString(amount) AS amount, toString(usdg_in) AS usdg_in, toString(weth_in) AS weth_in, keep
     FROM ev_relay WHERE block > {from:UInt64} AND block <= {to:UInt64} AND sign = 1`, r)) {
    const eth = Number(f.weth_in) / 1e18;
    out.push({ block: f.block, tx_index: f.tx_index, tx_hash: f.tx_hash, time: f.time, wallet: f.recipient, token: f.token, side: "buy",
      amount: f.amount, usd: Number(f.usdg_in) / 1e6 + eth * ethUsd, eth, via: "relay", keep: f.keep, sign: 1 });
  }
  await insert("ev_trades", out, `trades:${from}-${to}`);
  return out.length;
}
