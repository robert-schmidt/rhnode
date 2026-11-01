-- Candles before go-live (2026-11-02): src/tools/hist-candles.ts prices the swaps the history pass keeps (kept_swaps) with
-- the live projector's own priceSwap and inserts the rows here. Like migration 017's hist_* tables this keeps nothing
-- (Null engine; ev_prices' 14-day TTL would drop old rows at once); its view writes agg_candles_1m with mv_candles_1m's
-- expression (migration 004), so history and live candles can't differ.
CREATE TABLE IF NOT EXISTS hist_prices AS ev_prices ENGINE = Null;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_hist_candles_1m TO agg_candles_1m AS
SELECT token, pool, quote, toStartOfMinute(time) AS minute,
  argMinStateIf(price, block * 1000000 + log_index, sign = 1) AS open, argMaxStateIf(price, block * 1000000 + log_index, sign = 1) AS close,
  maxOrNullIf(price, sign = 1) AS high, minOrNullIf(price, sign = 1) AS low,
  argMaxStateIf(price_usd, block * 1000000 + log_index, sign = 1) AS close_usd,
  sum(quote_amount * sign) AS volume_quote, sum(usd * sign) AS volume_usd,
  sum(if(token_delta > 0, sign, 0)) AS buys, sum(if(token_delta < 0, sign, 0)) AS sells
FROM hist_prices GROUP BY token, pool, quote, minute;
