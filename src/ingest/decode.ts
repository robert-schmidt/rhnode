// One block + its receipts → rows for every raw/ev table. PURE: the tip follower, backfill and the
// tests all go through here, so their outputs match (ARCHITECTURE §4). Rows are ClickHouse
// JSONEachRow: lower-case hex, big numbers as decimal strings.
import { decodeAbiParameters } from "viem";
import { decodeChainLog, registryEntries, type RawLog } from "../chain/registry.ts";
import { decodeSwap } from "../chain/swaplog.ts";
import { fillOf, RELAY_ROUTERS } from "../chain/relay.ts";
import { KEEP, type KeepCtx } from "./keep.ts";

export type RpcTx = { hash: string; from: string; to: string | null; value: string; input: string; nonce: string; type: string; transactionIndex: string };
export type RpcBlock = {
  number: string; hash: string; parentHash: string; timestamp: string; gasUsed: string;
  baseFeePerGas?: string; l1BlockNumber?: string; transactions: RpcTx[];
};
export type RpcLog = { address: string; topics: string[]; data: string; logIndex: string; transactionHash: string; blockNumber: string; blockHash: string };
export type RpcReceipt = {
  transactionHash: string; blockHash: string; status?: string; gasUsed: string; effectiveGasPrice?: string;
  contractAddress: string | null; logs: RpcLog[];
};

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TRANSFER_SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
const TRANSFER_BATCH = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";
const PAD = "0x000000000000000000000000";
const REGISTRY = new Set(registryEntries.map((e) => `${e.address}:${e.topic0}`));

const num = (h: string | undefined | null) => (h ? Number(BigInt(h)) : 0);
const big = (h: string | undefined | null) => (h && h !== "0x" ? BigInt(h).toString() : "0");
/** First 32-byte word of `data`, 0 when empty (some tokens log `0x`). */
const word0 = (data: string) => (data.length >= 66 ? BigInt(data.slice(0, 66)).toString() : "0");
const topicAddr = (t: string | undefined) => (t && t.length === 66 ? "0x" + t.slice(26) : "");
const int24 = (w: string) => { const v = BigInt("0x" + w); return Number(v >= 1n << 255n ? v - (1n << 256n) : v); };
const lc = (s: string) => s.toLowerCase();

export type Rows = ReturnType<typeof emptyRows>;
export const emptyRows = () => ({
  raw_blocks: [] as object[], raw_txs: [] as object[], raw_logs: [] as object[],
  ev_transfers: [] as object[], ev_native: [] as object[], ev_swaps: [] as object[], ev_relay: [] as object[],
  ev_pools: [] as ({ pool: string; token0: string; token1: string; time: number } & Record<string, unknown>)[],
  ev_launches: [] as ({ kind: string; token: string; time: number; detail: string } & Record<string, unknown>)[],
});

/** The tx's keep bits: anything it touches (from/to/created, log emitters, address topics, v4 pool ids). */
export function txKeep(tx: RpcTx, rc: RpcReceipt, ctx: KeepCtx, time: number): number {
  let k = ctx.txs.get(lc(tx.hash)) ?? 0;
  const see = (a: string | null | undefined) => {
    if (!a) return;
    k |= ctx.watch.get(a) ?? 0;
    const t = ctx.recent.get(a);
    if (t !== undefined && time - t <= ctx.windowSec) k |= KEEP.LAUNCH;
  };
  see(lc(tx.from)); see(tx.to && lc(tx.to)); see(rc.contractAddress && lc(rc.contractAddress));
  for (const l of rc.logs) {
    const address = lc(l.address);
    see(address);
    if (REGISTRY.has(`${address}:${lc(l.topics[0] ?? "")}`)) k |= KEEP.LAUNCH;
    for (let i = 1; i < l.topics.length; i++) {
      const t = lc(l.topics[i]);
      see(t.startsWith(PAD) ? "0x" + t.slice(26) : t);
    }
  }
  return k;
}

export function decodeBlock(b: RpcBlock, receipts: RpcReceipt[], ctx: KeepCtx): Rows {
  const n = num(b.number), time = num(b.timestamp), bhash = lc(b.hash);
  if (receipts.length !== b.transactions.length) throw new Error(`block ${n}: ${receipts.length} receipts for ${b.transactions.length} txs`);
  const out = emptyRows();
  let rangeBits = 0;
  for (const r of ctx.ranges) if (n >= r.from && n <= r.to) rangeBits |= r.bits;
  let blockKeep = rangeBits;

  b.transactions.forEach((tx, i) => {
    const rc = receipts[i];
    const hash = lc(tx.hash);
    if (lc(rc.transactionHash) !== hash || lc(rc.blockHash) !== bhash) throw new Error(`block ${n}: receipt ${i} is not for tx ${hash} in ${bhash}`);
    const keep = txKeep(tx, rc, ctx, time) | rangeBits;
    const txIndex = num(tx.transactionIndex);
    const from = lc(tx.from), to = tx.to ? lc(tx.to) : "", created = rc.contractAddress ? lc(rc.contractAddress) : "";
    const base = { block: n, tx_index: txIndex, time, keep, sign: 1 };
    out.raw_txs.push({
      ...base, hash, from, to, value: big(tx.value), selector: tx.input.length >= 10 ? lc(tx.input.slice(0, 10)) : "", input: tx.input,
      status: num(rc.status), gas_used: num(rc.gasUsed), effective_gas_price: num(rc.effectiveGasPrice), nonce: num(tx.nonce), type: num(tx.type), created,
    });
    if (BigInt(tx.value) > 0n) out.ev_native.push({ ...base, path: "", tx_hash: hash, from, to: to || created, value: big(tx.value) });

    for (const l of rc.logs) {
      const topics = l.topics.map(lc);
      const address = lc(l.address), data = lc(l.data);
      const lb = { ...base, log_index: num(l.logIndex), tx_hash: hash };
      out.raw_logs.push({ ...lb, address, topic0: topics[0] ?? "", topic1: topics[1] ?? "", topic2: topics[2] ?? "", topic3: topics[3] ?? "", data });

      const t0 = topics[0];
      if (t0 === TRANSFER && topics.length === 3) {
        out.ev_transfers.push({ ...lb, batch_index: 0, token: address, from: topicAddr(topics[1]), to: topicAddr(topics[2]), amount: word0(data), token_id: "0", standard: "erc20" });
      } else if (t0 === TRANSFER && topics.length === 4) {
        out.ev_transfers.push({ ...lb, batch_index: 0, token: address, from: topicAddr(topics[1]), to: topicAddr(topics[2]), amount: "1", token_id: big(topics[3]), standard: "erc721" });
      } else if (t0 === TRANSFER_SINGLE && topics.length === 4 && data.length >= 130) {
        out.ev_transfers.push({ ...lb, batch_index: 0, token: address, from: topicAddr(topics[2]), to: topicAddr(topics[3]), amount: BigInt("0x" + data.slice(66, 130)).toString(), token_id: BigInt(data.slice(0, 66)).toString(), standard: "erc1155" });
      } else if (t0 === TRANSFER_BATCH && topics.length === 4) {
        try {
          const [ids, values] = decodeAbiParameters([{ type: "uint256[]" }, { type: "uint256[]" }], data as `0x${string}`);
          ids.forEach((id, j) => out.ev_transfers.push({ ...lb, batch_index: j, token: address, from: topicAddr(topics[2]), to: topicAddr(topics[3]), amount: (values[j] ?? 0n).toString(), token_id: id.toString(), standard: "erc1155" }));
        } catch { /* malformed batch: the raw log still has it */ }
      }

      const s = decodeSwap({ address, topics, data });
      if (s) {
        out.ev_swaps.push({
          ...lb, venue: s.venue, pool: s.pool, emitter: address, sender: s.sender, recipient: s.recipient ?? "", tx_from: from,
          amount0: s.amount0.toString(), amount1: s.amount1.toString(), sqrt_price_x96: (s.sqrtPriceX96 ?? 0n).toString(),
          liquidity: (s.liquidity ?? 0n).toString(), tick: s.tick ?? 0, fee: s.fee ?? 0,
        });
      }

      registryRow({ ...l, address, topics, data }, lb, out);
    }

    let f = null;
    for (const r of RELAY_ROUTERS) if ((f = fillOf(hash, rc.logs, r))) break;
    if (f) out.ev_relay.push({ ...base, tx_hash: hash, recipient: f.recipient, token: f.token, amount: f.raw.toString(), usdg_in: f.usdgIn.toString(), weth_in: f.wethIn.toString() });
    blockKeep |= keep;
  });

  out.raw_blocks.push({
    number: n, hash: bhash, parent_hash: lc(b.parentHash), time, tx_count: b.transactions.length,
    gas_used: num(b.gasUsed), base_fee: num(b.baseFeePerGas), l1_block: num(b.l1BlockNumber), keep: blockKeep, sign: 1,
  });
  return out;
}

/** A registry log (launchpad event, v2/v3/v4 pool creation) → its ev_pools / ev_launches row. */
export function registryRow(l: RpcLog, lb: Record<string, unknown>, out: Pick<Rows, "ev_pools" | "ev_launches">): void {
  const address = lc(l.address), topics = l.topics.map(lc), data = lc(l.data), t0 = topics[0];
  if (!REGISTRY.has(`${address}:${t0}`)) return;
  let d;
  try { d = decodeChainLog({ ...l, address, topics, data } as RawLog); } catch { d = null; }
  if (!d) return;
  const ev = d.event;
  const time = lb.time as number;
  if (ev.kind === "pool") {
    const v3 = ev.poolKind === "v3";
    out.ev_pools.push({
      ...lb, time, venue: ev.poolKind, pool: (ev.pool ?? ev.poolId ?? "").toLowerCase(), token0: ev.token0, token1: ev.token1,
      // registry.ts keeps v3's fee/tickSpacing out of the event; they're topic 3 and data word 0.
      fee: v3 ? num(topics[3]) : (ev.fee ?? 0), tick_spacing: v3 ? int24(data.slice(2, 66)) : (ev.tickSpacing ?? 0),
      hooks: ev.hooks ?? "", source: ev.source,
    });
  } else {
    out.ev_launches.push({
      ...lb, time, kind: ev.kind, source: ev.source, token: ev.token, deployer: ev.kind === "launch" ? ev.deployer : "",
      detail: JSON.stringify(ev, (_k, x) => (typeof x === "bigint" ? x.toString() : x)),
    });
  }
}
