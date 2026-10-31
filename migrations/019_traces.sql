-- Tip traces (TRACES=tip, src/ingest/traces.ts, 2026-10-31). Our node keeps ~1,200 blocks of state, so a trace not taken
-- at the tip is lost for good. Every call frame of every tx (failed txs and reverted frames too), flattened in call order:
-- idx is the frame's position in its tx, depth 0 the tx itself. Kept RAW_TTL_DAYS, like the other raw tables; the
-- stream replays them and /v1/tx/{hash}/trace serves them. Every block has ArbOS's own tx, so a traced block always has
-- rows here: no rows means not traced (aged out, or a gap in ctl_trace_gaps).
CREATE TABLE IF NOT EXISTS raw_traces (
  block UInt64, tx_index UInt32, tx_hash FixedString(66), idx UInt32, depth UInt16, type LowCardinality(String),
  `from` FixedString(42), `to` String, value UInt256, selector LowCardinality(String), error String, time DateTime
) ENGINE = MergeTree PARTITION BY toYYYYMMDD(time) ORDER BY (block, tx_index, idx)
TTL time + INTERVAL ${RAW_TTL_DAYS} DAY
SETTINGS ttl_only_drop_parts = 1, non_replicated_deduplication_window = 10000;

-- Blocks the tracer skipped because it fell too far behind our node's state window (or our node was down)
CREATE TABLE IF NOT EXISTS ctl_trace_gaps (from_block UInt64, to_block UInt64, at DateTime DEFAULT now())
ENGINE = ReplacingMergeTree ORDER BY from_block;
