import { createClient } from "@clickhouse/client";
import { cfg } from "./config.ts";

export const ch = createClient({ ...cfg.clickhouse, request_timeout: 60_000 });

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

export async function rows<T>(query: string, query_params?: Record<string, unknown>): Promise<T[]> {
  return (await ch.query({ query, query_params, format: "JSONEachRow" })).json<T>();
}
