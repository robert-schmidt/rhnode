-- Every ETH transfer that happened, forever: the funding graph (first funders of a wallet, the wallets it funded, hubs).
-- Only txs that succeeded: a third of value txs fail (225,642 of 667,801 since go-live, measured 2026-10-30), and a failed
-- one moves nothing. From go-live on, the view fills it from raw_txs; below go-live, src/promoter/scan.ts writes it from
-- the blocks it reads and the receipts of their value txs. path '' is the tx's own value; internal transfers (ETH a
-- contract sends; needs traces, TRACES=tip) go in the same table with their call path, which is why path is in the key.
-- type is the tx type: 100 (L1 deposit), 104/105 (retryables) are bridge funding, not a wallet funding another.
-- A creation's recipient is the created contract. Addresses are lower-case.
CREATE TABLE IF NOT EXISTS native_edges (
  dst FixedString(42), src FixedString(42), value UInt256, block UInt64, tx_index UInt32, path String, type UInt8, time DateTime
) ENGINE = ReplacingMergeTree PARTITION BY intDiv(block, 20000000) ORDER BY (dst, block, tx_index, path)
SETTINGS non_replicated_deduplication_window = 10000;

-- the same rows by sender ("wallets funded by X")
CREATE TABLE IF NOT EXISTS native_edges_by_src AS native_edges
ENGINE = ReplacingMergeTree PARTITION BY intDiv(block, 20000000) ORDER BY (src, block, tx_index, path)
SETTINGS non_replicated_deduplication_window = 10000;
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_native_edges_by_src TO native_edges_by_src AS SELECT * FROM native_edges;

-- Hub stats per sender and per recipient (a funder of thousands is an exchange, solver, bridge or faucet, not an
-- operator). n counts distinct edges, so a row written twice isn't counted twice; total (a sum) could be, only for rows
-- both the view and the copy below wrote. ponytail: that overlap is the few seconds the copy runs.
CREATE TABLE IF NOT EXISTS agg_native_src (
  src FixedString(42), n AggregateFunction(uniq, Tuple(UInt64, UInt32, String)), peers AggregateFunction(uniq, FixedString(42)),
  first_block SimpleAggregateFunction(min, UInt64), last_block SimpleAggregateFunction(max, UInt64), total SimpleAggregateFunction(sum, UInt256)
) ENGINE = AggregatingMergeTree ORDER BY src;
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_agg_native_src TO agg_native_src AS
SELECT src, uniqState((block, tx_index, path)) AS n, uniqState(dst) AS peers, min(block) AS first_block, max(block) AS last_block, sum(value) AS total
FROM native_edges GROUP BY src;

CREATE TABLE IF NOT EXISTS agg_native_dst (
  dst FixedString(42), n AggregateFunction(uniq, Tuple(UInt64, UInt32, String)), peers AggregateFunction(uniq, FixedString(42)),
  first_block SimpleAggregateFunction(min, UInt64), last_block SimpleAggregateFunction(max, UInt64), total SimpleAggregateFunction(sum, UInt256)
) ENGINE = AggregatingMergeTree ORDER BY dst;
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_agg_native_dst TO agg_native_dst AS
SELECT dst, uniqState((block, tx_index, path)) AS n, uniqState(src) AS peers, min(block) AS first_block, max(block) AS last_block, sum(value) AS total
FROM native_edges GROUP BY dst;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_native_edges TO native_edges AS
SELECT toFixedString(if(`to` = '', created, `to`), 42) AS dst, `from` AS src, value, block, tx_index, '' AS path, type, time FROM raw_txs
WHERE sign = 1 AND value > 0 AND status = 1 AND type != 106;

-- what raw_txs held before the view existed (the view has the rest)
INSERT INTO native_edges SELECT toFixedString(if(`to` = '', created, `to`), 42) AS dst, `from` AS src, value, block, tx_index, '' AS path, type, time FROM raw_txs
WHERE sign = 1 AND value > 0 AND status = 1 AND type != 106
  AND block < (SELECT if(count() = 0, 18446744073709551615, min(block)) FROM native_edges);
