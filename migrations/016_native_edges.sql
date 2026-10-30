-- Every top-level ETH transfer (a tx with value > 0), forever: the funding graph (first funder of a wallet, the wallets
-- it funded). From go-live on, the view fills it from raw_txs; below go-live, src/promoter/scan.ts writes it from the
-- blocks it reads. status: 1 ok, 0 failed, 2 unknown. Blocks carry no receipts and a third of value txs fail (225,642 of
-- 667,801 since go-live, 2026-10-30), so a reader checks a status-2 row against the node before trusting it.
-- Internal transfers (ETH a contract sends) need traces: not here. A creation's recipient is the created contract.
CREATE TABLE IF NOT EXISTS native_edges (dst FixedString(42), src FixedString(42), value UInt256, block UInt64, tx_index UInt32, status UInt8)
ENGINE = ReplacingMergeTree PARTITION BY intDiv(block, 20000000) ORDER BY (dst, block, tx_index)
SETTINGS non_replicated_deduplication_window = 10000;

-- the same rows by sender ("wallets funded by X")
CREATE TABLE IF NOT EXISTS native_edges_by_src AS native_edges
ENGINE = ReplacingMergeTree PARTITION BY intDiv(block, 20000000) ORDER BY (src, block, tx_index)
SETTINGS non_replicated_deduplication_window = 10000;
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_native_edges_by_src TO native_edges_by_src AS SELECT * FROM native_edges;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_native_edges TO native_edges AS
SELECT toFixedString(if(`to` = '', created, `to`), 42) AS dst, `from` AS src, value, block, tx_index, status FROM raw_txs
WHERE sign = 1 AND value > 0 AND type != 106;

-- what raw_txs holds already (from go-live); a row the view also wrote is merged away
INSERT INTO native_edges SELECT toFixedString(if(`to` = '', created, `to`), 42) AS dst, `from` AS src, value, block, tx_index, status FROM raw_txs
WHERE sign = 1 AND value > 0 AND type != 106;
