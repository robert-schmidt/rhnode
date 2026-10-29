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
    clickhouse_settings: { insert_deduplication_token: `${table}:${token}`, deduplicate_blocks_in_dependent_materialized_views: 1 },
  });
}

export async function rows<T>(query: string, query_params?: Record<string, unknown>): Promise<T[]> {
  return (await ch.query({ query, query_params, format: "JSONEachRow" })).json<T>();
}
