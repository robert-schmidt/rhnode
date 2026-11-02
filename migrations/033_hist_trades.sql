-- Trades before go-live (2026-11-02): src/tools/hist-trades.ts derives them from the kept history with the projector's
-- attribution and writes them here, not to ev_trades: no views on this table, so agg_wallet_token's forever sums and
-- kept_trades stay go-live-forward. Same columns, engine and TTL as ev_trades (RAW_TTL_DAYS on each row's time), so a
-- derived week expires like the real ones. all_trades reads both (GET /v1/trades).
CREATE TABLE IF NOT EXISTS hist_trades AS ev_trades;
CREATE TABLE IF NOT EXISTS all_trades AS ev_trades ENGINE = Merge(currentDatabase(), '^(ev|hist)_trades$');
