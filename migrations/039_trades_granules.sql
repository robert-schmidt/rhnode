-- ev_trades with 256-row granules and a projection by token (2026-11-06), as 038 for ev_prices: it is ordered by wallet,
-- so the cards' reads by a batch's tokens (24 h buys/sells/buyers/sellers and the top wallet, 276 CPU-s per 30 min)
-- read two whole days. On a 2-day copy, 6 live card queries: 921K -> 14-42K rows, CPU 45-80% lower, same results (the
-- projection is chosen by itself); a wallet's day 141K -> 2K rows. mv_kept_trades and the PnL views read FROM ev_trades,
-- so the rows written during the copy go through staging + ATTACH PARTITION (fires no MV; the staging table copies the
-- projection, which ATTACH needs). Bulk copy ahead by hand as in 038. The old table stays as ev_trades_swap until checked.
-- A projection refuses lightweight DELETEs (and in 'rebuild' mode its reads still saw masked rows), so the reorg drop
-- (src/ingest/reorg.ts) deletes from ev_trades with a mutation.
CREATE TABLE IF NOT EXISTS ev_trades_swap AS ev_trades ENGINE = MergeTree PARTITION BY toYYYYMMDD(time) ORDER BY (wallet, block, tx_index, token)
  TTL time + INTERVAL ${RAW_TTL_DAYS} DAY SETTINGS ttl_only_drop_parts = 1, non_replicated_deduplication_window = 10000, index_granularity = 256;
ALTER TABLE ev_trades_swap ADD PROJECTION IF NOT EXISTS p_token (SELECT * ORDER BY token, time);
INSERT INTO ev_trades_swap SELECT * FROM ev_trades WHERE block > (SELECT max(block) FROM ev_trades_swap);
EXCHANGE TABLES ev_trades AND ev_trades_swap;
CREATE TABLE IF NOT EXISTS ev_trades_catchup AS ev_trades;
INSERT INTO ev_trades_catchup SELECT * FROM ev_trades_swap WHERE block > (SELECT max(block) - 200000 FROM ev_trades_swap)
  AND cityHash64(*) NOT IN (SELECT cityHash64(*) FROM ev_trades WHERE block > (SELECT max(block) - 200000 FROM ev_trades_swap));
ALTER TABLE ev_trades ATTACH PARTITION ALL FROM ev_trades_catchup;
DROP TABLE ev_trades_catchup;
