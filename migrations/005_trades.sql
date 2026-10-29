-- M2b: trades by the wallet that acted (src/projector/trades.ts) and per-wallet-per-token sums (§3.4).
-- amount: the wallet's net raw balance change of the token (+ buy, − sell). usd / eth: what the swaps behind it
-- were worth (eth = the ETH-quoted part only). via: swap (signer) | userop (ERC-4337 sender) | relay (fill recipient).
-- keep: the tx's keep bits (raw_txs.keep), so a watched wallet's trades also live in kept_trades forever.
CREATE TABLE ev_trades (
  block UInt64, tx_index UInt32, tx_hash FixedString(66), time DateTime,
  wallet FixedString(42), token FixedString(42), side Enum8('buy' = 1, 'sell' = 2), amount Int256, usd Float64, eth Float64,
  via LowCardinality(String), keep UInt16, sign Int8
) ENGINE = MergeTree PARTITION BY toYYYYMMDD(time) ORDER BY (wallet, block, tx_index, token)
TTL time + INTERVAL ${RAW_TTL_DAYS} DAY
SETTINGS ttl_only_drop_parts = 1, non_replicated_deduplication_window = 10000;

CREATE TABLE kept_trades AS ev_trades ENGINE = ReplacingMergeTree PARTITION BY toYYYYMM(time) ORDER BY (wallet, block, tx_index, token)
SETTINGS non_replicated_deduplication_window = 10000;
CREATE MATERIALIZED VIEW mv_kept_trades TO kept_trades AS SELECT * FROM ev_trades WHERE keep != 0;

-- Forever. Average-cost PnL from sums: avg_in = usd_in / bought; realized = usd_out − sold × avg_in.
-- ponytail: first/last block can't be taken back by a reorg (min/max); sums and counts can.
CREATE TABLE agg_wallet_token (
  wallet FixedString(42), token FixedString(42),
  bought Int256, sold Int256, usd_in Float64, usd_out Float64, eth_in Float64, eth_out Float64, buys Int64, sells Int64,
  first_block SimpleAggregateFunction(min, UInt64), last_block SimpleAggregateFunction(max, UInt64)
) ENGINE = SummingMergeTree ORDER BY (wallet, token)
SETTINGS non_replicated_deduplication_window = 10000;

CREATE MATERIALIZED VIEW mv_wallet_token TO agg_wallet_token AS
SELECT wallet, token,
  if(side = 'buy', amount, 0) * sign AS bought, if(side = 'sell', -amount, 0) * sign AS sold,
  if(side = 'buy', usd, 0) * sign AS usd_in, if(side = 'sell', usd, 0) * sign AS usd_out,
  if(side = 'buy', eth, 0) * sign AS eth_in, if(side = 'sell', eth, 0) * sign AS eth_out,
  if(side = 'buy', sign, 0) AS buys, if(side = 'sell', sign, 0) AS sells,
  block AS first_block, block AS last_block
FROM ev_trades;
