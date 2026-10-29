-- M3: skip indexes for the API's wallet and topic lookups. The sort keys serve token (ev_transfers), block
-- (raw_txs) and address (raw_logs) reads; a wallet's tokentx/txlist and a topic-only eth_getLogs (e.g. Transfers
-- to 1,700 wallets) would otherwise read every granule of the range. bloom_filter at 1% false positives.
ALTER TABLE ev_transfers ADD INDEX IF NOT EXISTS ix_from `from` TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE ev_transfers ADD INDEX IF NOT EXISTS ix_to `to` TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE raw_txs ADD INDEX IF NOT EXISTS ix_from `from` TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE raw_txs ADD INDEX IF NOT EXISTS ix_to `to` TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE raw_logs ADD INDEX IF NOT EXISTS ix_t1 topic1 TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE raw_logs ADD INDEX IF NOT EXISTS ix_t2 topic2 TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE raw_logs ADD INDEX IF NOT EXISTS ix_block block TYPE minmax GRANULARITY 1;
ALTER TABLE ev_transfers MATERIALIZE INDEX ix_from;
ALTER TABLE ev_transfers MATERIALIZE INDEX ix_to;
ALTER TABLE raw_txs MATERIALIZE INDEX ix_from;
ALTER TABLE raw_txs MATERIALIZE INDEX ix_to;
ALTER TABLE raw_logs MATERIALIZE INDEX ix_t1;
ALTER TABLE raw_logs MATERIALIZE INDEX ix_t2;
ALTER TABLE raw_logs MATERIALIZE INDEX ix_block;
