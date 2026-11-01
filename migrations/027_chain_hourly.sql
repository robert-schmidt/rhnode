-- The chain per hour, forever (2026-11-01, for the explorer's charts; read cached, never per request). Block columns come
-- from raw_blocks, so a header-only backfill can extend them to genesis; tx columns from raw_txs (user txs: Arbitrum's
-- internal type 0x6a is left out). Counts and sums carry `sign`, so a reorg's rollback takes its rows back out.
-- ponytail: the quantile and uniq states can't be taken back; a reorg on this chain is a few blocks a week at most.
CREATE TABLE IF NOT EXISTS agg_chain_hourly (
  hour DateTime,
  t0 SimpleAggregateFunction(min, Nullable(DateTime)), t1 SimpleAggregateFunction(max, Nullable(DateTime)), -- first/last block: rates over what's covered
  blocks SimpleAggregateFunction(sum, Int64),
  gas_used SimpleAggregateFunction(sum, Int64),
  base_fee_sum SimpleAggregateFunction(sum, Int128), -- / blocks = the average base fee
  txs SimpleAggregateFunction(sum, Int64),
  failed SimpleAggregateFunction(sum, Int64),
  creates SimpleAggregateFunction(sum, Int64),
  fees SimpleAggregateFunction(sum, Int256), -- wei
  gas_price AggregateFunction(quantilesTDigest(0.1, 0.5, 0.9), UInt64),
  senders AggregateFunction(uniq, FixedString(42))
) ENGINE = AggregatingMergeTree ORDER BY hour;

-- (summed under other names first: `sum(gas_used) AS gas_used` would read its own alias)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_chain_hourly_blocks TO agg_chain_hourly AS
SELECT hour, a AS t0, z AS t1, n AS blocks, g AS gas_used, bf AS base_fee_sum FROM (
  SELECT toStartOfHour(time) AS hour, minIfOrNull(time, sign = 1) AS a, maxIfOrNull(time, sign = 1) AS z, sum(sign) AS n, sum(toInt64(gas_used) * sign) AS g, sum(toInt128(base_fee) * sign) AS bf FROM raw_blocks GROUP BY hour);

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_chain_hourly_txs TO agg_chain_hourly AS
SELECT toStartOfHour(time) AS hour, sum(sign) AS txs, sumIf(sign, status = 0) AS failed, sumIf(sign, created != '') AS creates,
  sum(toInt256(gas_used) * effective_gas_price * sign) AS fees,
  quantilesTDigestStateIf(0.1, 0.5, 0.9)(effective_gas_price, sign = 1) AS gas_price, uniqStateIf(`from`, sign = 1) AS senders
FROM raw_txs WHERE type != 106 GROUP BY hour;

-- What raw_* holds already (go-live forward). Migrations run before ingest starts writing, so nothing is counted twice.
INSERT INTO agg_chain_hourly (hour, t0, t1, blocks, gas_used, base_fee_sum)
SELECT toStartOfHour(time) AS hour, minIfOrNull(time, sign = 1), maxIfOrNull(time, sign = 1), sum(sign), sum(toInt64(gas_used) * sign), sum(toInt128(base_fee) * sign) FROM raw_blocks GROUP BY hour;

INSERT INTO agg_chain_hourly (hour, txs, failed, creates, fees, gas_price, senders)
SELECT toStartOfHour(time) AS hour, sum(sign), sumIf(sign, status = 0), sumIf(sign, created != ''), sum(toInt256(gas_used) * effective_gas_price * sign),
  quantilesTDigestStateIf(0.1, 0.5, 0.9)(effective_gas_price, sign = 1), uniqStateIf(`from`, sign = 1)
FROM raw_txs WHERE type != 106 GROUP BY hour;
