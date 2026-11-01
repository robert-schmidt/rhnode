-- Senders, failures and creations per hour before go-live (2026-11-01), for the explorer's charts. Below block 51,500,000
-- from the history pass (its hist_txs, as it reads every tx anyway); from there up to go-live from
-- src/tools/chain-gap-fill.ts (receipts only, into hist_chain_txs, at low priority). The boundary is a constant, so no chunk
-- is counted by both or by neither, whenever this lands; the pass was at 52.6M when it was set. det_txs counts the user txs
-- these came from: failures are a share of them, and an hour is complete when they match its head_txs (migration 028).
ALTER TABLE agg_chain_hourly ADD COLUMN IF NOT EXISTS det_txs SimpleAggregateFunction(sum, Int64) AFTER head_txs;

CREATE TABLE IF NOT EXISTS hist_chain_txs AS raw_txs ENGINE = Null;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_hist_chain_hourly_txs TO agg_chain_hourly AS
SELECT toStartOfHour(time) AS hour, count() AS det_txs, countIf(status = 0) AS failed, countIf(created != '') AS creates, uniqState(`from`) AS senders
FROM hist_txs WHERE sign = 1 AND type != 106 AND block < 51500000 GROUP BY hour;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_hist_chain_hourly_gap TO agg_chain_hourly AS
SELECT toStartOfHour(time) AS hour, count() AS det_txs, countIf(status = 0) AS failed, countIf(created != '') AS creates, uniqState(`from`) AS senders
FROM hist_chain_txs WHERE sign = 1 AND type != 106 AND block >= 51500000 GROUP BY hour;
