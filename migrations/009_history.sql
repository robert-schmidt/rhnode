-- Exact history (CLAUDE.md "Backward walk", 2026-10-30): every ERC-20 transfer is kept forever. The walk (src/promoter/walk.ts)
-- writes those before go-live; this view keeps the live ones that no other keep rule kept (bit 512 = KEEP.HISTORY), and the
-- copy below brings in what is already in raw. Size: ~0.6M transfers/day at ~59 bytes ≈ 35 MB/day (measured 2026-10-30).
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_kept_transfers_all TO kept_transfers AS
SELECT * REPLACE (bitOr(keep, 512) AS keep) FROM ev_transfers WHERE standard = 'erc20' AND keep = 0;

INSERT INTO kept_transfers SELECT * REPLACE (bitOr(keep, 512) AS keep) FROM ev_transfers WHERE standard = 'erc20' AND keep = 0;

-- Wallet reads over all of history: tokentx by from/to, token-balances by holder.
ALTER TABLE kept_transfers ADD INDEX IF NOT EXISTS ix_from `from` TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE kept_transfers ADD INDEX IF NOT EXISTS ix_to `to` TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE agg_balances ADD INDEX IF NOT EXISTS ix_holder holder TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE kept_transfers MATERIALIZE INDEX ix_from;
ALTER TABLE kept_transfers MATERIALIZE INDEX ix_to;
ALTER TABLE agg_balances MATERIALIZE INDEX ix_holder;
