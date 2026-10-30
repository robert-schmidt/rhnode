-- Forever: the first tx rhnode saw from each sender, as (block, tx_index, nonce, time, hash). Its nonce says what it is:
-- 0 = the wallet's real first tx (exact birth as a sender); > 0 = the wallet was active before rhnode's data starts.
-- ponytail: min() can't be taken back by a reorg; a reorged-away first tx stays (rare; the replacement lands seconds later).
CREATE TABLE agg_wallet_first (
  wallet FixedString(42),
  first SimpleAggregateFunction(min, Tuple(UInt64, UInt32, UInt64, DateTime, FixedString(66)))
) ENGINE = AggregatingMergeTree ORDER BY wallet;

CREATE MATERIALIZED VIEW mv_wallet_first TO agg_wallet_first AS
SELECT `from` AS wallet, (block, tx_index, nonce, time, hash) AS first FROM raw_txs WHERE sign = 1;

-- Everything raw_txs still holds (min() makes the overlap with the view harmless).
INSERT INTO agg_wallet_first SELECT `from`, min((block, tx_index, nonce, time, hash)) FROM raw_txs WHERE sign = 1 GROUP BY `from`;
