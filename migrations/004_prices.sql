-- M2b: a price for every swap in a resolved pool, and 1-minute candles (§3.4). Written by the projector
-- (it needs pools + decimals, which ingest doesn't have).
-- * token / quote: the pool's non-quote side, and WETH | USDG | native ETH. A WETH(or ETH)/USDG pool is
--   token = WETH|ETH, quote = USDG: that is where eth_usd comes from.
-- * token_delta / quote_delta: the TRADER's side (+ = received). Emitted amounts are pool-side on v2/v3 and
--   trader-side on v4 (measured 2026-10-29 on 54K swaps against the pool's own Transfers).
-- * price: quote per token in human units; price_usd: × eth_usd for an ETH quote (0 when unknown).
-- * quote_amount: |quote_delta| in human units; usd: the trade's USD value (0 when unknown).
-- * verified: the pool's verified flag (decoys and unconfirmed forks are 0); candles keep both, consumers filter.
CREATE TABLE ev_prices (
  block UInt64, tx_index UInt32, log_index UInt32, tx_hash FixedString(66), time DateTime,
  pool String, venue Enum8('v2' = 2, 'v3' = 3, 'v4' = 4), token FixedString(42), quote FixedString(42),
  token_delta Int256, quote_delta Int256, quote_amount Float64, usd Float64, price Float64, price_usd Float64, eth_usd Float64,
  tx_from FixedString(42), verified UInt8, sign Int8
) ENGINE = MergeTree PARTITION BY toYYYYMMDD(time) ORDER BY (token, block, log_index)
TTL time + INTERVAL ${RAW_TTL_DAYS} DAY
SETTINGS ttl_only_drop_parts = 1, non_replicated_deduplication_window = 10000;

-- Forever. ponytail: a reorg subtracts volume/counts (sign) but can't take a ghost price back out of
-- high/low/open/close for the minutes it touched; Nitro reorgs are rare.
CREATE TABLE agg_candles_1m (
  token FixedString(42), pool String, quote FixedString(42), minute DateTime,
  open AggregateFunction(argMin, Float64, UInt64), close AggregateFunction(argMax, Float64, UInt64),
  high SimpleAggregateFunction(max, Nullable(Float64)), low SimpleAggregateFunction(min, Nullable(Float64)),
  close_usd AggregateFunction(argMax, Float64, UInt64),
  volume_quote SimpleAggregateFunction(sum, Float64), volume_usd SimpleAggregateFunction(sum, Float64),
  buys SimpleAggregateFunction(sum, Int64), sells SimpleAggregateFunction(sum, Int64)
) ENGINE = AggregatingMergeTree ORDER BY (token, pool, minute)
SETTINGS non_replicated_deduplication_window = 10000;

CREATE MATERIALIZED VIEW mv_candles_1m TO agg_candles_1m AS
SELECT token, pool, quote, toStartOfMinute(time) AS minute,
  argMinStateIf(price, block * 1000000 + log_index, sign = 1) AS open, argMaxStateIf(price, block * 1000000 + log_index, sign = 1) AS close,
  maxOrNullIf(price, sign = 1) AS high, minOrNullIf(price, sign = 1) AS low,
  argMaxStateIf(price_usd, block * 1000000 + log_index, sign = 1) AS close_usd,
  sum(quote_amount * sign) AS volume_quote, sum(usd * sign) AS volume_usd,
  sum(if(token_delta > 0, sign, 0)) AS buys, sum(if(token_delta < 0, sign, 0)) AS sells
FROM ev_prices GROUP BY token, pool, quote, minute;
