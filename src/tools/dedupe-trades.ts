// One-off (2026-10-31): take back the rows the projector doubled before projector_pending (a restart redid a range
// against a newer tip, so new dedup tokens), and Relay fills counted beside the same tx's swap trade. Each extra row
// gets a sign -1 copy, as a reorg does, so agg_candles_1m and agg_wallet_token subtract it through their views. Trades'
// copies carry keep 0, so mv_kept_trades skips them (kept_trades never held the duplicates: it replaces by key).
// Counted by net sign, so rows a reorg already took back aren't taken twice. `node src/tools/dedupe-trades.ts [--dry]`.
import { insert, rows } from "../ch.ts";

const dry = process.argv.includes("--dry");
type Row = Record<string, unknown> & { sign: number };
// every column of `table` as `a`.col, 128/256-bit integers as strings (JSON gives them as lossy numbers)
const cols = async (table: string, a: string) => (await rows<{ name: string; type: string }>(
  "SELECT name, type FROM system.columns WHERE database = currentDatabase() AND table = {t:String} ORDER BY position", { t: table }))
  .map((c) => (/Int(128|256)/.test(c.type) ? `toString(${a}.${c.name}) AS ${c.name}` : `${a}.${c.name}`)).join(", ");

/** One -1 copy per extra row of `table`: key groups whose sign nets above 1. */
async function extras(table: string, key: string): Promise<Row[]> {
  const got = await rows<Row & { k: string; net: string }>(
    `SELECT ${await cols(table, "t")}, concat(${key.split(", ").map((c) => `toString(t.${c})`).join(", '|', ")}) AS k, d.net AS net FROM ${table} AS t
     INNER JOIN (SELECT ${key}, sum(sign) AS net FROM ${table} GROUP BY ${key} HAVING net > 1) AS d USING (${key})
     WHERE t.sign = 1 LIMIT 1 BY k`);
  return got.flatMap(({ k: _, net, ...r }) => Array.from({ length: Number(net) - 1 }, () => ({ ...r, sign: -1, ...(table === "ev_trades" ? { keep: 0 } : {}) })));
}

const prices = await extras("ev_prices", "tx_hash, log_index");
const trades = await extras("ev_trades", "tx_hash, wallet, token, via");
// a Relay fill beside the tx's own swap trade (same wallet and token, both net 1 after the above): the relay one goes
const relay = (await rows<Row>(
  `SELECT ${await cols("ev_trades", "r")} FROM (SELECT * FROM ev_trades WHERE via = 'relay' AND sign = 1 LIMIT 1 BY tx_hash, wallet, token) AS r
   INNER JOIN (SELECT tx_hash, wallet, token FROM ev_trades WHERE via = 'swap' GROUP BY tx_hash, wallet, token HAVING sum(sign) > 0) AS s
     USING (tx_hash, wallet, token)
   WHERE (r.tx_hash, r.wallet, r.token) IN (SELECT tx_hash, wallet, token FROM ev_trades WHERE via = 'relay' GROUP BY tx_hash, wallet, token HAVING sum(sign) > 0)`))
  .map((r) => ({ ...r, sign: -1, keep: 0 }));
console.log(JSON.stringify({ prices: prices.length, trades: trades.length, relay: relay.length, dry }));
if (!dry) {
  await insert("ev_prices", prices, "dedupe-2026-10-31");
  await insert("ev_trades", [...trades, ...relay], "dedupe-2026-10-31");
}
process.exit(0);
