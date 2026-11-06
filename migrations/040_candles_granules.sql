-- agg_candles_1m with 256-row granules (2026-11-06), as 036-039: it is read by (token, pool) lists (the cards' price 1 h
-- / 6 h / 24 h ago, their candidates' all-time volume, the API's candles), and with 8,192-row granules each pool cost a
-- granule in each of ~22 parts. On a full copy, live queries: price-ago 1.59M -> 77K rows, CPU 0.131 -> 0.070 s; the
-- candidates' volume 532K -> 11K rows. Only MVs write it (mv_candles_1m, mv_hist_candles_1m) and none read it, so the
-- swap goes first and the rest is copied after it: from then on the MVs write only the new table and the old one is
-- frozen, so nothing is missed or added twice (partial states of a minute in both merge, as AggregatingMergeTree does).
-- For a few seconds the newest minutes are incomplete. The bulk may be copied ahead by hand (`INSERT INTO
-- agg_candles_1m_swap SELECT * FROM agg_candles_1m WHERE minute < M`, M at least a few minutes behind the projector);
-- ctl_cursors 'candles_swap' records where that copy ended (0 on a fresh box: all is copied after the swap).
-- The old table stays as agg_candles_1m_swap until checked.
CREATE TABLE IF NOT EXISTS agg_candles_1m_swap AS agg_candles_1m ENGINE = AggregatingMergeTree ORDER BY (token, pool, minute)
  SETTINGS non_replicated_deduplication_window = 10000, index_granularity = 256;
INSERT INTO ctl_cursors SELECT 'candles_swap' AS name, toUInt64(toUnixTimestamp(max(minute))) AS block, '' AS hash, toUInt64(toUnixTimestamp64Milli(now64())) AS version FROM agg_candles_1m_swap;
EXCHANGE TABLES agg_candles_1m AND agg_candles_1m_swap;
INSERT INTO agg_candles_1m SELECT * FROM agg_candles_1m_swap WHERE toUnixTimestamp(minute) > (SELECT block FROM ctl_cursors FINAL WHERE name = 'candles_swap');
