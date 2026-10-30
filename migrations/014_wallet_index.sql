-- Wallets someone asked about, in the explorer or the API (src/watch.ts), are indexed: watched from then on, and their
-- txs still in raw_txs copied into kept_txs, so every tx from/to/created by them since `floor` lives forever.
-- status: queued → indexed | busy (more txs a day than WALLET_MAX_TXS_DAY: a router or a bot) | failed.
CREATE TABLE IF NOT EXISTS ctl_wallet_index (
  wallet FixedString(42), status LowCardinality(String), floor UInt64, txs UInt64, note String,
  requested_at DateTime DEFAULT now(), version UInt64
) ENGINE = ReplacingMergeTree(version) ORDER BY wallet;

-- An indexed wallet's txs are read from kept_txs by from/to/created, as raw_txs is (migrations 006, 011).
ALTER TABLE kept_txs ADD INDEX IF NOT EXISTS ix_from `from` TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE kept_txs ADD INDEX IF NOT EXISTS ix_to `to` TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE kept_txs ADD INDEX IF NOT EXISTS ix_created created TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE kept_txs MATERIALIZE INDEX ix_from;
ALTER TABLE kept_txs MATERIALIZE INDEX ix_to;
ALTER TABLE kept_txs MATERIALIZE INDEX ix_created;
