import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeBlock, type RpcBlock, type RpcReceipt } from "./decode.ts";
import { emptyCtx, KEEP, learn } from "./keep.ts";
import { decodeSwap } from "../chain/swaplog.ts";

const { block, receipts } = JSON.parse(readFileSync(new URL("./fixtures/block.json", import.meta.url), "utf8")) as { block: RpcBlock; receipts: RpcReceipt[] };
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const logs = receipts.flatMap((r) => r.logs);

test("a real block: one row per tx and log, every Transfer and Swap decoded, nothing kept by default", () => {
  const out = decodeBlock(block, receipts, emptyCtx());
  assert.equal(out.raw_blocks.length, 1);
  assert.equal(out.raw_txs.length, block.transactions.length);
  assert.equal(out.raw_logs.length, logs.length);
  assert.equal(out.ev_transfers.length, logs.filter((l) => l.topics[0] === TRANSFER && (l.topics.length === 3 || l.topics.length === 4)).length);
  assert.equal(out.ev_swaps.length, logs.filter((l) => decodeSwap(l)).length);
  assert.ok(out.ev_swaps.length > 0);
  for (const rows of Object.values(out)) for (const r of rows as { keep: number }[]) assert.equal(r.keep, 0);
  assert.deepEqual(decodeBlock(block, receipts, emptyCtx()), out, "decode is deterministic");
  JSON.stringify(out); // no bigint left in a row: JSONEachRow would throw
});

test("keep is per tx: a watched signer keeps its tx whole and nothing else", () => {
  const tx = block.transactions.find((t, i) => receipts[i].logs.length > 0)!;
  const ctx = emptyCtx();
  ctx.watch.set(tx.from.toLowerCase(), KEEP.WATCH_WALLET);
  const out = decodeBlock(block, receipts, ctx);
  const hash = tx.hash.toLowerCase();
  for (const r of out.raw_logs as { tx_hash: string; keep: number }[]) assert.equal(r.keep, r.tx_hash === hash ? KEEP.WATCH_WALLET : 0);
  for (const r of out.raw_txs as { hash: string; keep: number }[]) assert.equal(r.keep, r.hash === hash ? KEEP.WATCH_WALLET : 0);
  assert.equal((out.raw_blocks[0] as { keep: number }).keep, KEEP.WATCH_WALLET);
});

test("keep: a token's Transfer counterparty (an address topic) matches, a pinned range keeps everything", () => {
  const t = logs.find((l) => l.topics[0] === TRANSFER && l.topics.length === 3)!;
  const ctx = emptyCtx();
  ctx.watch.set("0x" + t.topics[2].slice(26), KEEP.OWN);
  const out = decodeBlock(block, receipts, ctx);
  assert.ok((out.ev_transfers as { tx_hash: string; keep: number }[]).some((r) => r.tx_hash === t.transactionHash && r.keep === KEEP.OWN));

  const pinned = emptyCtx();
  pinned.ranges.push({ from: Number(block.number), to: Number(block.number), bits: KEEP.PINNED });
  for (const r of decodeBlock(block, receipts, pinned).raw_logs as { keep: number }[]) assert.equal(r.keep, KEEP.PINNED);
});

test("learn: a new token's pools join its launch window; a watched token's pools become tracked", () => {
  const ctx = emptyCtx(3600);
  const tok = "0x1111111111111111111111111111111111111111", weth = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
  ctx.watch.set(tok, KEEP.WATCH_TOKEN);
  learn(ctx, { ev_launches: [{ kind: "launch", token: tok, time: 100, detail: "{}" }], ev_pools: [{ pool: "0x" + "ab".repeat(32), token0: weth, token1: tok, time: 150 }] });
  assert.equal(ctx.recent.get("0x" + "ab".repeat(32)), 100, "the pool inherits the token's launch time");
  assert.equal(ctx.watch.get("0x" + "ab".repeat(32)), KEEP.TRACKED_POOL);
});

test("a receipt from another block is refused, not mixed in", () => {
  const bad = receipts.map((r, i) => (i === 0 ? { ...r, blockHash: "0x" + "0".repeat(64) } : r));
  assert.throws(() => decodeBlock(block, bad, emptyCtx()), /receipt 0/);
});
