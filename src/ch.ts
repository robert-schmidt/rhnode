import { AsyncLocalStorage } from "node:async_hooks";
import { createClient } from "@clickhouse/client";
import { cfg } from "./config.ts";

// Idle sockets live 8 s (the client default is 2.5 s, the server's keep_alive_timeout 10 s): a quiet API caller then
// reuses the connection instead of paying a new one (~4 ms over the LAN, measured 2026-10-30).
export const ch = createClient({ ...cfg.clickhouse, request_timeout: 60_000, keep_alive: { idle_socket_ttl: 8000 } });

/** Insert with a dedup token: the same token twice (crash replay, a re-run of the same aligned
 *  batch) is dropped by ClickHouse, in the table and in the MVs it feeds. */
export async function insert(table: string, values: object[], token: string): Promise<void> {
  if (!values.length) return;
  await ch.insert({
    table,
    values,
    format: "JSONEachRow",
    // async_insert is on by default since ClickHouse 26.x; its path crashes when the token drops every row
    // ("Invalid partition key size: 0", seen 2026-10-29 on a replayed batch). We batch ourselves, so insert synchronously.
    clickhouse_settings: { async_insert: 0, insert_deduplication_token: `${table}:${token}`, deduplicate_blocks_in_dependent_materialized_views: 1 },
  });
}

/** The ClickHouse CPU workload (migration 030) of the queries run inside `workload.run(name, f)`: "bulk" for heavy
 *  reads apps make in volume (cards, pool reports, discovery), which then get a quarter of the CPU while anything else
 *  wants it, and all of it when nothing does. Everything else runs in "default". */
export const workload = new AsyncLocalStorage<string>();

export async function rows<T>(query: string, query_params?: Record<string, unknown>): Promise<T[]> {
  const w = workload.getStore();
  return (await ch.query({ query, query_params, format: "JSONEachRow", ...(w ? { clickhouse_settings: { workload: w } } : {}) })).json<T>();
}

/** The time span {t0, t1} of blocks (from, to], for `inSpan()`: raw/ev tables are partitioned by day on `time` and sorted by
 *  token or pool, so a block range alone reads nearly every granule; with the time bound each part's min/max skips it.
 *  Unknown blocks give no bound. Memoized for the last range (one lookup per projector tick). */
let spanMemo = { key: "", t: { t0: 0, t1: 4294967295 } };
export async function span(from: number, to: number): Promise<{ t0: number; t1: number }> {
  const key = `${from}-${to}`;
  if (spanMemo.key === key) return spanMemo.t;
  const [s] = await rows<{ n: string; t0: number; t1: number }>(
    "SELECT uniqExact(number) AS n, toUInt32(min(time)) AS t0, toUInt32(max(time)) AS t1 FROM raw_blocks WHERE number IN ({a:UInt64}, {b:UInt64})",
    { a: from + 1, b: to });
  spanMemo = { key, t: Number(s?.n) === (from + 1 === to ? 1 : 2) ? { t0: s.t0, t1: s.t1 } : { t0: 0, t1: 4294967295 } };
  return spanMemo.t;
}
export const inSpan = (col = "time") => `${col} BETWEEN toDateTime({t0:UInt32}) AND toDateTime({t1:UInt32})`;
