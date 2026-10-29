// Against a real ClickHouse (skipped when none answers), in its own database rhnode_test (dropped after):
// - a batch written twice lands once, in raw/ev AND the kept_* MVs (crash replay / re-run idempotency);
// - a synthetic fork: rollback leaves no rows and zero balances, twice in a row, and the new branch counts once.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@clickhouse/client";

process.env.CLICKHOUSE_DB = "rhnode_test";
const admin = createClient({
  url: process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123",
  username: process.env.CLICKHOUSE_USER ?? "rhnode",
  password: process.env.CLICKHOUSE_PASSWORD ?? "",
});
const skip = !(await admin.ping()).success && "no ClickHouse at CLICKHOUSE_URL";

const { ch, insert, rows } = await import("../ch.ts");
const { migrate } = await import("../migrate.ts");
const { decodeBlock } = await import("./decode.ts");
const { emptyCtx, KEEP } = await import("./keep.ts");
const { rollback, negate, drop, findFork } = await import("./reorg.ts");

const fixture = () => {
  const fx = JSON.parse(readFileSync(new URL("./fixtures/block.json", import.meta.url), "utf8"));
  fx.block.timestamp = "0x" + Math.floor(Date.now() / 1000).toString(16); // inside the raw TTL whenever the test runs
  return fx;
};
const n = async (t: string) => Number((await rows<{ n: string }>(`SELECT count() AS n FROM ${t}`))[0].n);
const balances = async () => rows<{ token: string; holder: string; b: string }>(
  "SELECT token, holder, toString(sum(balance)) AS b FROM agg_balances GROUP BY token, holder HAVING sum(balance) != 0 ORDER BY token, holder",
);
const write = async (out: object, token: string) => { for (const [t, rs] of Object.entries(out)) await insert(t, rs as object[], token); };

before(async () => {
  if (skip) return;
  await admin.command({ query: "DROP DATABASE IF EXISTS rhnode_test" });
  await admin.command({ query: "CREATE DATABASE rhnode_test" });
  await migrate();
});
after(async () => {
  if (!skip) await admin.command({ query: "DROP DATABASE IF EXISTS rhnode_test" });
  await ch.close();
  await admin.close();
});

test("a batch inserted twice is stored once, raw and kept", { skip }, async () => {
  const fx = fixture();
  const ctx = emptyCtx();
  ctx.watch.set(fx.block.transactions[1].from.toLowerCase(), KEEP.WATCH_WALLET);
  const out = decodeBlock(fx.block, fx.receipts, ctx);
  await write(out, "test-batch");
  // The replay differs (a watchlist changed in between, so keep bits differ): only the token can drop it.
  await write(decodeBlock(fx.block, fx.receipts, emptyCtx()), "test-batch");

  assert.equal(await n("raw_logs"), out.raw_logs.length);
  assert.equal(await n("raw_txs"), out.raw_txs.length);
  assert.equal(await n("ev_swaps"), out.ev_swaps.length);
  const keptTxs = (out.raw_txs as { keep: number }[]).filter((r) => r.keep).length;
  assert.ok(keptTxs > 0);
  assert.equal(await n("kept_txs"), keptTxs);
  assert.equal(await n("kept_logs"), (out.raw_logs as { keep: number }[]).filter((r) => r.keep).length);
  assert.ok((await balances()).length > 0, "the fixture's transfers move balances");
});

test("synthetic fork: rollback empties the block and zeroes balances, idempotently; the new branch counts once", { skip }, async () => {
  const before = await balances();
  const block = Number(fixture().block.number);
  await negate(block, "fork-a");
  await negate(block, "fork-a"); // crashed after the -1 insert and replayed: the token must drop it
  await drop(block);
  await rollback(block, "fork-a"); // a whole rollback replayed changes nothing
  for (const t of ["raw_blocks", "raw_txs", "raw_logs", "ev_transfers", "ev_swaps", "kept_txs", "kept_logs"]) assert.equal(await n(t), 0, `${t} after rollback`);
  assert.deepEqual(await balances(), [], "every balance the block moved is undone");

  const fx = fixture();
  fx.block.hash = "0x" + "f".repeat(64); // the new branch's block (same txs, other hash)
  for (const r of fx.receipts) r.blockHash = fx.block.hash;
  await write(decodeBlock(fx.block, fx.receipts, emptyCtx()), `branch-b`);
  assert.deepEqual(await balances(), before, "re-ingested once, balances are what one copy gives");
});

test("findFork: the highest block whose stored hash matches the chain, skipping blocks no longer stored", async () => {
  const stored: Record<number, string> = { 98: "a", 99: "b", 100: "x" }; // 101 was already deleted
  const chain: Record<number, string> = { 98: "a", 99: "b", 100: "c", 101: "d" };
  assert.equal(await findFork(101, async (k) => stored[k] ?? null, async (k) => chain[k]), 99);
  assert.equal(await findFork(101, async () => "z", async (k) => chain[k], 5), null);
});
