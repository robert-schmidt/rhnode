-- The history pass (src/promoter/history.ts, 2026-10-30, Robert: "single pass with full decoding"): every block from
-- go-live down to genesis is decoded once by ingest's own decoder, and its rows are inserted here. These tables keep
-- nothing (Null engine); their views write what lives forever, with the same expressions as the live views on
-- raw_txs/ev_* (migrations 001, 010, 015, 016), so history and live data can't differ. agg_balances is summed by the
-- pass itself (it leaves out tokens that token promotion already backfilled). Raw logs (but ERC-4337 UserOperationEvent)
-- and full tx rows aren't kept: the node is the archive. Prices, candles and trades before go-live are derived from
-- what's kept here, by the projector, with no further reads of the node.
CREATE TABLE IF NOT EXISTS hist_txs AS raw_txs ENGINE = Null;
CREATE TABLE IF NOT EXISTS hist_transfers AS ev_transfers ENGINE = Null;
CREATE TABLE IF NOT EXISTS hist_swaps AS ev_swaps ENGINE = Null;
CREATE TABLE IF NOT EXISTS hist_launches AS ev_launches ENGINE = Null;
CREATE TABLE IF NOT EXISTS hist_pools AS ev_pools ENGINE = Null;
CREATE TABLE IF NOT EXISTS hist_relay AS ev_relay ENGINE = Null;
CREATE TABLE IF NOT EXISTS hist_logs AS raw_logs ENGINE = Null; -- only ERC-4337 UserOperationEvent logs are sent here

-- txs: every wallet's tx pointers (015), ETH transfers that happened (016), each sender's first tx
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_hist_idx_wallet_txs TO idx_wallet_txs AS
SELECT w AS wallet, block, tx_index FROM hist_txs
ARRAY JOIN arrayDistinct(arrayFilter(x -> x != '', [toString(`from`), `to`, created])) AS w
WHERE sign = 1 AND type != 106;
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_hist_native_edges TO native_edges AS
SELECT toFixedString(if(`to` = '', created, `to`), 42) AS dst, `from` AS src, value, block, tx_index, '' AS path, type, time FROM hist_txs
WHERE sign = 1 AND value > 0 AND status = 1 AND type != 106;
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_hist_wallet_first TO agg_wallet_first AS
SELECT `from` AS wallet, (block, tx_index, nonce, time, hash) AS first FROM hist_txs WHERE sign = 1;

-- events, kept forever with the HISTORY bit (512); no WHERE on keep, so the REPLACE alias can't be misread (010)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_hist_transfers TO kept_transfers AS
SELECT * REPLACE (bitOr(keep, 512) AS keep) FROM hist_transfers WHERE standard = 'erc20';
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_hist_swaps TO kept_swaps AS SELECT * REPLACE (bitOr(keep, 512) AS keep) FROM hist_swaps;
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_hist_launches TO kept_launches AS SELECT * REPLACE (bitOr(keep, 512) AS keep) FROM hist_launches;
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_hist_pools TO kept_pools AS SELECT * REPLACE (bitOr(keep, 512) AS keep) FROM hist_pools;
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_hist_relay TO kept_relay AS SELECT * REPLACE (bitOr(keep, 512) AS keep) FROM hist_relay;
-- ERC-4337 UserOperationEvent logs: the projector attributes a smart wallet's trades to its sender with them
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_hist_userops TO kept_logs AS SELECT * REPLACE (bitOr(keep, 512) AS keep) FROM hist_logs
WHERE topic0 = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';
-- pool identities, as mv_pools does for live pools
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_hist_pools_table TO pools AS
SELECT pool, venue, if(venue = 'v4', '0x8366a39cc670b4001a1121b8f6a443a643e40951', pool) AS manager, token0, token1, fee, tick_spacing, hooks,
  '' AS factory, block AS created_block, time AS created_time, 'event' AS source, 1 AS verified, 1 AS ok, toUInt64(block) AS version
FROM hist_pools WHERE sign = 1;
