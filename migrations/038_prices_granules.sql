-- ev_prices with 256-row granules (2026-11-06), as 036/037: cards read it by a batch's tokens (NET24, 24 h of swaps, the
-- second costliest card read, 238 CPU-s per 30 min), and with 8,192-row granules each token cost a granule in each of
-- ~31 day parts. On a 2-day copy, 6 live NET24 queries: 0.6-1.6M -> 8-313K rows, CPU 45-60% lower, same results.
-- mv_candles_1m reads FROM ev_prices: an MV follows its source's name across EXCHANGE too (checked), but rows written to
-- the old table during the copy already fed the candles, so they must not be INSERTed again (they'd count twice). They
-- go through a staging table and ATTACH PARTITION, which fires no MV (checked). The bulk of the copy may be done ahead
-- by hand (`INSERT INTO ev_prices_swap SELECT * FROM ev_prices WHERE block <= B`); here only the rest is copied, and
-- on a fresh box (max of an empty table is 0) all of it. The old table stays as ev_prices_swap until checked.
CREATE TABLE IF NOT EXISTS ev_prices_swap AS ev_prices ENGINE = MergeTree PARTITION BY toYYYYMMDD(time) ORDER BY (token, block, log_index)
  TTL time + INTERVAL ${RAW_TTL_DAYS} DAY SETTINGS ttl_only_drop_parts = 1, non_replicated_deduplication_window = 10000, index_granularity = 256;
INSERT INTO ev_prices_swap SELECT * FROM ev_prices WHERE block > (SELECT max(block) FROM ev_prices_swap);
EXCHANGE TABLES ev_prices AND ev_prices_swap;
CREATE TABLE IF NOT EXISTS ev_prices_catchup AS ev_prices;
INSERT INTO ev_prices_catchup SELECT * FROM ev_prices_swap WHERE block > (SELECT max(block) - 200000 FROM ev_prices_swap)
  AND cityHash64(*) NOT IN (SELECT cityHash64(*) FROM ev_prices WHERE block > (SELECT max(block) - 200000 FROM ev_prices_swap));
ALTER TABLE ev_prices ATTACH PARTITION ALL FROM ev_prices_catchup;
DROP TABLE ev_prices_catchup;
