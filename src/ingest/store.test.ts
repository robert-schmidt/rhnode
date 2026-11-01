// Against a real ClickHouse (skipped when none answers), in its own database rhnode_test (dropped after):
// - a batch written twice lands once, in raw/ev AND the kept_* MVs (crash replay / re-run idempotency);
// - a synthetic fork: rollback leaves no rows and zero balances, twice in a row, and the new branch counts once.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@clickhouse/client";
import type { Client } from "../chain/upstream.ts";

process.env.CLICKHOUSE_DB = "rhnode_test";
const admin = createClient({
  url: process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123",
  username: process.env.CLICKHOUSE_USER ?? "rhnode",
  password: process.env.CLICKHOUSE_PASSWORD ?? "",
});
const skip = !(await admin.ping()).success && "no ClickHouse at CLICKHOUSE_URL";

const { ch, insert, rows, workload } = await import("../ch.ts");
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

test("curve payouts: a rerun writes nothing; a row stored without USD is written again once it has a price", { skip }, async () => {
  const { ERC20_PAYOUTS } = await import("../discovery.ts");
  const { WETH } = await import("../chain/constants.ts");
  const curve = "0x" + "c".repeat(40), time = new Date().toISOString().slice(0, 19).replace("T", " ");
  await insert("token_markets", [{ token: "0x" + "a".repeat(40), curve, version: 1 }], "t-payout-market");
  await insert("kept_transfers", [{ block: 7, tx_hash: "0x" + "1".repeat(64), time, token: WETH, from: curve, to: "0x" + "b".repeat(40),
    amount: "1000000000000000000", standard: "erc20", keep: 1, sign: 1 }], "t-payout-transfer");
  const run = async () => { await ch.command({ query: ERC20_PAYOUTS }); await ch.command({ query: ERC20_PAYOUTS }); return n("curve_payouts"); };
  assert.equal(await run(), 1); // no ETH/USD yet: stored once, usd null
  await insert("ev_prices", [{ block: 7, time, token: "0x" + "a".repeat(40), quote: WETH, venue: "v2", eth_usd: 3000, verified: 1, sign: 1 }], "t-payout-price");
  assert.equal(await run(), 2); // the priced row, once
  assert.deepEqual(await rows("SELECT usd FROM curve_payouts FINAL"), [{ usd: 3000 }]);
});

test("contracts: tx and factory creations are created; a reverted one isn't there; one first seen by a log is never first of its kind", { skip }, async () => {
  const { deriveContracts } = await import("../projector/contracts.ts");
  const A = (c: string) => "0x" + c.repeat(40), H = (c: string) => "0x" + c.repeat(64);
  const time = new Date().toISOString().slice(0, 19).replace("T", " ");
  const code: Record<string, string> = { [A("1")]: "11111111", [A("2")]: "22222222", [A("3")]: "33333333", [A("9")]: "22222222" };
  const up = { call: async (m: string, [a]: [string]) => m === "eth_getCode" && code[a] ? `0x63${code[a]}14` : "0x" } as unknown as Client;
  await insert("raw_txs", [
    { block: 10, hash: H("a"), time, from: A("e"), created: A("1"), status: 1 }, // a deployment
    { block: 11, hash: H("b"), time, from: A("e"), status: 1 }, // calls a factory
    { block: 12, hash: H("c"), time, from: A("e"), status: 0 }, // reverted
  ], "t-contracts-txs");
  await insert("creations", [
    { created: A("1"), creator: A("e"), type: "CREATE", block: 10, tx_hash: H("a"), time },
    { created: A("2"), creator: A("f"), type: "CREATE2", block: 11, tx_hash: H("b"), time }, // never logs
    { created: A("3"), creator: A("f"), type: "CREATE2", block: 11, tx_hash: H("b"), time },
    { created: A("4"), creator: A("f"), type: "CREATE", block: 12, tx_hash: H("c"), time },
  ], "t-contracts-creations");
  await insert("raw_logs", [
    { block: 9, tx_hash: H("d"), time, address: A("9") }, // an old contract, first seen now; same kind as 0x22…
    { block: 11, tx_hash: H("b"), time, address: A("3") },
  ], "t-contracts-logs");
  assert.equal(await deriveContracts(up, 8, 12), 4);
  const got = await rows<{ address: string; created: number; deployer: string; factory: string; first_of_kind: number }>(
    "SELECT address, created, deployer, factory, first_of_kind FROM contracts FINAL WHERE block BETWEEN 9 AND 12 ORDER BY address");
  assert.deepEqual(got, [
    { address: A("1"), created: 1, deployer: A("e"), factory: "", first_of_kind: 1 },
    { address: A("2"), created: 1, deployer: A("e"), factory: A("f"), first_of_kind: 0 }, // its kind was seen at 0x99… first
    { address: A("3"), created: 1, deployer: A("e"), factory: A("f"), first_of_kind: 1 },
    { address: A("9"), created: 0, deployer: "", factory: "", first_of_kind: 0 },
  ]);
});

test("agg_chain_hourly: blocks and user txs per hour; a rollback's rows take the counts back out", { skip }, async () => {
  const time = "2026-11-01 05:20:00", H = (c: string) => "0x" + c.repeat(64), A = (c: string) => "0x" + c.repeat(40);
  await insert("raw_blocks", [{ number: 900, hash: H("1"), time, tx_count: 3, gas_used: 1000, base_fee: 20, sign: 1 },
    { number: 901, hash: H("2"), time, tx_count: 1, gas_used: 500, base_fee: 30, sign: 1 }], "t-hourly-blocks");
  await insert("raw_txs", [{ block: 900, tx_index: 0, hash: H("3"), time, from: A("1"), type: 106, status: 1, sign: 1 }, // internal: not a user tx
    { block: 900, tx_index: 1, hash: H("4"), time, from: A("2"), type: 2, status: 1, gas_used: 10, effective_gas_price: 20, created: A("9"), sign: 1 },
    { block: 900, tx_index: 2, hash: H("5"), time, from: A("2"), type: 2, status: 0, gas_used: 5, effective_gas_price: 20, sign: 1 }], "t-hourly-txs");
  await insert("raw_blocks", [{ number: 901, hash: H("2"), time, tx_count: 1, gas_used: 500, base_fee: 30, sign: -1 }], "t-hourly-rollback");
  const [h] = await rows<Record<string, string | number>>(`SELECT toString(min(t0)) AS a, toString(max(t1)) AS z, sum(blocks) AS n_blocks, sum(gas_used) AS n_gas, sum(base_fee_sum) AS n_bf,
    sum(txs) AS n_txs, sum(failed) AS n_failed, sum(creates) AS n_creates, toString(sum(fees)) AS n_fees, uniqMerge(senders) AS n_senders FROM agg_chain_hourly WHERE hour = '2026-11-01 05:00:00'`);
  assert.deepEqual(Object.fromEntries(Object.entries(h).map(([k, v]) => [k, k === "a" || k === "z" ? v : Number(v)])),
    { a: time, z: time, n_blocks: 1, n_gas: 1000, n_bf: 20, n_txs: 2, n_failed: 1, n_creates: 1, n_fees: 300, n_senders: 1 });
});

test("agg_chain_hourly from headers (028): user txs as tx_count - 1, fees at the base fee, one gas price per user tx; a retried chunk counts once", { skip }, async () => {
  const time = "2026-05-01 07:10:00", H = (c: string) => "0x" + c.repeat(64);
  const chunk = [{ number: 50, hash: H("a"), time, tx_count: 4, gas_used: 900, base_fee: 10, sign: 1 },
    { number: 51, hash: H("b"), time, tx_count: 1, gas_used: 0, base_fee: 40, sign: 1 }];
  await insert("hist_blocks", chunk, "hourly:t-50");
  await insert("hist_blocks", chunk, "hourly:t-50");
  const [h] = await rows<Record<string, string | number | number[]>>(`SELECT sum(blocks) AS n_blocks, sum(head_txs) AS n_head, sum(txs) AS n_txs, toString(sum(fees)) AS n_fees,
    quantilesTDigestMerge(0.1, 0.5, 0.9)(gas_price) AS gp FROM agg_chain_hourly WHERE hour = '2026-05-01 07:00:00'`);
  assert.deepEqual({ ...h, n_blocks: Number(h.n_blocks), n_head: Number(h.n_head), n_txs: Number(h.n_txs), n_fees: Number(h.n_fees) },
    { n_blocks: 2, n_head: 3, n_txs: 0, n_fees: 9000, gp: [10, 10, 10] }); // block 51 has only its internal tx: no gas price
});

test("agg_chain_hourly details before go-live (029): the history pass below 51.5M, the gap pass from it; neither counts the other's side", { skip }, async () => {
  const time = "2026-06-01 03:10:00", A = (c: string) => "0x" + c.repeat(40);
  const tx = (block: number, i: number, from: string, status: number, type = 2) => ({ block, tx_index: i, time, from, type, status, created: "", sign: 1 });
  await insert("hist_txs", [tx(51_499_999, 0, A("1"), 1, 106), tx(51_499_999, 1, A("1"), 0), tx(51_499_999, 2, A("2"), 1), tx(51_500_000, 1, A("3"), 0)], "t-029-hist");
  await insert("hist_chain_txs", [tx(51_500_000, 1, A("3"), 0), tx(51_500_000, 2, A("3"), 1), tx(51_499_999, 1, A("1"), 0)], "t-029-gap");
  const [h] = await rows<Record<string, string | number>>(`SELECT sum(det_txs) AS n_det, sum(failed) AS n_failed, uniqMerge(senders) AS n_senders, sum(txs) AS n_txs
    FROM agg_chain_hourly WHERE hour = '2026-06-01 03:00:00'`);
  assert.deepEqual(Object.fromEntries(Object.entries(h).map(([k, v]) => [k, Number(v)])), { n_det: 4, n_failed: 2, n_senders: 3, n_txs: 0 });
});

test("findFork: the highest block whose stored hash matches the chain, skipping blocks no longer stored", async () => {
  const stored: Record<number, string> = { 98: "a", 99: "b", 100: "x" }; // 101 was already deleted
  const chain: Record<number, string> = { 98: "a", 99: "b", 100: "c", 101: "d" };
  assert.equal(await findFork(101, async (k) => stored[k] ?? null, async (k) => chain[k]), 99);
  assert.equal(await findFork(101, async () => "z", async (k) => chain[k], 5), null);
});

test("workloads (030): queries inside workload.run('bulk') run in bulk, others in default; both exist", { skip }, async () => {
  const w = async () => (await rows<{ w: string }>("SELECT getSetting('workload') AS w"))[0].w;
  assert.equal(await workload.run("bulk", w), "bulk");
  assert.equal(await w(), "default");
  const names = (await rows<{ name: string }>("SELECT name FROM system.workloads ORDER BY name")).map((r) => r.name);
  for (const x of ["all", "bulk", "default"]) assert.ok(names.includes(x), x);
});
