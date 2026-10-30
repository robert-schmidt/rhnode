-- Every wallet's txs, forever (2026-10-30: one pass, all wallets): a pointer (wallet, block, tx_index) for each
-- tx's sender, recipient and created contract. ArbOS's start-of-block tx (type 0x6a) is left out. From go-live on, the
-- view fills it from raw_txs; below go-live, src/promoter/scan.ts reads every block of our node, newest first.
-- The tx itself comes from raw_txs/kept_txs or the node.
CREATE TABLE IF NOT EXISTS idx_wallet_txs (wallet FixedString(42), block UInt64, tx_index UInt32)
ENGINE = ReplacingMergeTree PARTITION BY intDiv(block, 20000000) ORDER BY (wallet, block, tx_index)
SETTINGS non_replicated_deduplication_window = 10000;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_idx_wallet_txs TO idx_wallet_txs AS
SELECT w AS wallet, block, tx_index FROM raw_txs
ARRAY JOIN arrayDistinct(arrayFilter(x -> x != '', [toString(`from`), `to`, created])) AS w
WHERE sign = 1 AND type != 106;

-- what raw_txs holds already (from go-live, until the TTL takes it); a row the view also wrote is merged away
INSERT INTO idx_wallet_txs SELECT w AS wallet, block, tx_index FROM raw_txs
ARRAY JOIN arrayDistinct(arrayFilter(x -> x != '', [toString(`from`), `to`, created])) AS w
WHERE sign = 1 AND type != 106;
