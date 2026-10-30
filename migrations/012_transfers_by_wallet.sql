-- account.tokentx by wallet over kept history: kept_transfers is sorted by token, so `from = w OR to = w` with FINAL read
-- every granule the bloom filters let through (322 ms, 6.3M rows for one wallet, measured 2026-10-30). This copy has one row
-- per side of each ERC-20 transfer, sorted by wallet: a key lookup. Fed from kept_transfers (so also by the walk and token
-- promotion); src/ingest/reorg.ts deletes from it like every kept_* table.
CREATE TABLE IF NOT EXISTS kept_transfers_by_wallet
ENGINE = ReplacingMergeTree PARTITION BY toYYYYMM(time) ORDER BY (wallet, block, log_index, batch_index, token)
SETTINGS non_replicated_deduplication_window = 10000
AS SELECT `from` AS wallet, * FROM kept_transfers WHERE 0;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_kept_transfers_by_wallet TO kept_transfers_by_wallet AS
SELECT wallet, * FROM kept_transfers ARRAY JOIN [`from`, `to`] AS wallet WHERE standard = 'erc20';

INSERT INTO kept_transfers_by_wallet SELECT wallet, * FROM kept_transfers ARRAY JOIN [`from`, `to`] AS wallet WHERE standard = 'erc20';
