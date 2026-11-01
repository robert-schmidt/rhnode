-- The chain per hour before go-live (2026-11-01): src/tools/chain-hourly-fill.ts reads every block header from go-live
-- down to genesis into hist_blocks (keeps nothing). Headers give blocks, gas, base fee and fees exactly (every user tx
-- pays its block's base fee: 273,720 of 273,720 on 2026-11-01) and user txs as tx_count - 1 (one ArbitrumInternalTx a
-- block, ~0.04% more), kept apart in head_txs. Senders, failures and creations need the txs themselves: from go-live only.
ALTER TABLE agg_chain_hourly ADD COLUMN IF NOT EXISTS head_txs SimpleAggregateFunction(sum, Int64) AFTER txs;
-- a retried chunk (or an ingest batch replayed under its token) is dropped here too
ALTER TABLE agg_chain_hourly MODIFY SETTING non_replicated_deduplication_window = 10000;

CREATE TABLE IF NOT EXISTS hist_blocks AS raw_blocks ENGINE = Null;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_hist_chain_hourly TO agg_chain_hourly AS
SELECT hour, a AS t0, z AS t1, n AS blocks, g AS gas_used, bf AS base_fee_sum, u AS head_txs, f AS fees FROM (
  SELECT toStartOfHour(time) AS hour, min(time) AS a, max(time) AS z, count() AS n, sum(toInt64(gas_used)) AS g, sum(toInt128(base_fee)) AS bf,
    sum(toInt64(greatest(tx_count, 1)) - 1) AS u, sum(toInt256(gas_used) * base_fee) AS f FROM hist_blocks GROUP BY hour);

-- the gas price each user tx paid: its block's base fee, once per user tx
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_hist_chain_hourly_gas TO agg_chain_hourly AS
SELECT toStartOfHour(time) AS hour, quantilesTDigestState(0.1, 0.5, 0.9)(base_fee) AS gas_price
FROM hist_blocks ARRAY JOIN range(toUInt32(greatest(tx_count, 1) - 1)) AS i GROUP BY hour;
