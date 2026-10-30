-- account.txlist filters `from = w OR to = w OR created = w`: skip indexes only prune when every OR branch has one, so
-- without an index on `created` it read all of raw_txs (3.72M rows, p50 114 ms, measured 2026-10-30).
ALTER TABLE raw_txs ADD INDEX IF NOT EXISTS ix_created created TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE raw_txs MATERIALIZE INDEX ix_created;
