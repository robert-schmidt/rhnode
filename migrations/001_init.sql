-- M1 schema (ARCHITECTURE §3). ${RAW_TTL_DAYS} is filled in by src/migrate.ts.
-- ponytail: changing RAW_TTL_DAYS later needs `ALTER TABLE … MODIFY TTL` per raw/ev table.
--
-- Conventions:
-- * addresses and hashes are lower-case 0x-hex (FixedString(42)/(66)); v4 pools are 0x-ids (66), so `pool` is String
-- * `time` is the block timestamp in seconds (blocks are ~104 ms apart, the chain stamps whole seconds)
-- * `keep` is the retention bitmask (§3.1), per transaction: every row of a kept tx is kept, so kept_* holds whole txs
-- * `sign` is +1 on insert, -1 on a reorg rollback (M2)
-- * every raw/ev/kept table remembers 10,000 insert tokens so a re-inserted batch (crash replay, re-run) is dropped

CREATE TABLE raw_blocks (
  number UInt64, hash FixedString(66), parent_hash FixedString(66), time DateTime,
  tx_count UInt16, gas_used UInt64, base_fee UInt64, l1_block UInt64,
  keep UInt16, sign Int8
) ENGINE = MergeTree PARTITION BY toYYYYMMDD(time) ORDER BY number
TTL time + INTERVAL ${RAW_TTL_DAYS} DAY
SETTINGS ttl_only_drop_parts = 1, non_replicated_deduplication_window = 10000;

CREATE TABLE raw_txs (
  block UInt64, tx_index UInt32, hash FixedString(66), time DateTime,
  `from` FixedString(42), `to` String, value UInt256, selector LowCardinality(String), input String,
  status UInt8, gas_used UInt64, effective_gas_price UInt64, nonce UInt64, type UInt8, created String,
  keep UInt16, sign Int8
) ENGINE = MergeTree PARTITION BY toYYYYMMDD(time) ORDER BY (block, tx_index)
TTL time + INTERVAL ${RAW_TTL_DAYS} DAY
SETTINGS ttl_only_drop_parts = 1, non_replicated_deduplication_window = 10000;

-- ponytail: no by-block projection yet; add `ORDER BY (block, log_index)` as a projection when /rpc getLogs by range lands (M3).
CREATE TABLE raw_logs (
  block UInt64, tx_index UInt32, log_index UInt32, tx_hash FixedString(66), time DateTime,
  address FixedString(42), topic0 LowCardinality(String), topic1 String, topic2 String, topic3 String, data String,
  keep UInt16, sign Int8
) ENGINE = MergeTree PARTITION BY toYYYYMMDD(time) ORDER BY (address, topic0, block, log_index)
TTL time + INTERVAL ${RAW_TTL_DAYS} DAY
SETTINGS ttl_only_drop_parts = 1, non_replicated_deduplication_window = 10000;

-- ERC-20 / ERC-721 / ERC-1155. token_id is 0 for ERC-20; batch_index is the position inside a TransferBatch.
CREATE TABLE ev_transfers (
  block UInt64, tx_index UInt32, log_index UInt32, batch_index UInt16, tx_hash FixedString(66), time DateTime,
  token FixedString(42), `from` FixedString(42), `to` FixedString(42), amount UInt256, token_id UInt256,
  standard Enum8('erc20' = 1, 'erc721' = 2, 'erc1155' = 3),
  keep UInt16, sign Int8
) ENGINE = MergeTree PARTITION BY toYYYYMMDD(time) ORDER BY (token, block, log_index, batch_index)
TTL time + INTERVAL ${RAW_TTL_DAYS} DAY
SETTINGS ttl_only_drop_parts = 1, non_replicated_deduplication_window = 10000;

-- Top-level value transfers. Internal ones (path != '') come from traces (TRACES=tip, M6).
CREATE TABLE ev_native (
  block UInt64, tx_index UInt32, path String, tx_hash FixedString(66), time DateTime,
  `from` FixedString(42), `to` String, value UInt256,
  keep UInt16, sign Int8
) ENGINE = MergeTree PARTITION BY toYYYYMMDD(time) ORDER BY (block, tx_index, path)
TTL time + INTERVAL ${RAW_TTL_DAYS} DAY
SETTINGS ttl_only_drop_parts = 1, non_replicated_deduplication_window = 10000;

-- Amounts as emitted (swaplog.ts doctrine); v2 stores in − out per token. Prices come with M2.
-- Any contract can emit a Swap: `emitter` (the pool, or the v4 PoolManager, incl. forks' managers) is
-- joined against ev_pools in M2 to tell real pools from decoys.
CREATE TABLE ev_swaps (
  block UInt64, tx_index UInt32, log_index UInt32, tx_hash FixedString(66), time DateTime,
  venue Enum8('v2' = 2, 'v3' = 3, 'v4' = 4), pool String, emitter FixedString(42), sender FixedString(42), recipient String, tx_from FixedString(42),
  amount0 Int256, amount1 Int256, sqrt_price_x96 UInt256, liquidity UInt128, tick Int32, fee UInt32,
  keep UInt16, sign Int8
) ENGINE = MergeTree PARTITION BY toYYYYMMDD(time) ORDER BY (pool, block, log_index)
TTL time + INTERVAL ${RAW_TTL_DAYS} DAY
SETTINGS ttl_only_drop_parts = 1, non_replicated_deduplication_window = 10000;

-- Pool registry: v2 PairCreated, v3 PoolCreated, v4 Initialize. Always kept (LAUNCH bit).
CREATE TABLE ev_pools (
  block UInt64, tx_index UInt32, log_index UInt32, tx_hash FixedString(66), time DateTime,
  venue Enum8('v2' = 2, 'v3' = 3, 'v4' = 4), pool String, token0 FixedString(42), token1 FixedString(42),
  fee UInt32, tick_spacing Int32, hooks String, source LowCardinality(String),
  keep UInt16, sign Int8
) ENGINE = MergeTree PARTITION BY toYYYYMMDD(time) ORDER BY (pool, block, log_index)
TTL time + INTERVAL ${RAW_TTL_DAYS} DAY
SETTINGS ttl_only_drop_parts = 1, non_replicated_deduplication_window = 10000;

-- Launchpad events from the registry (launch | graduated | migration | feeRecipient); the full event in `detail`.
CREATE TABLE ev_launches (
  block UInt64, tx_index UInt32, log_index UInt32, tx_hash FixedString(66), time DateTime,
  kind LowCardinality(String), source LowCardinality(String), token FixedString(42), deployer String, detail String,
  keep UInt16, sign Int8
) ENGINE = MergeTree PARTITION BY toYYYYMMDD(time) ORDER BY (token, block, log_index)
TTL time + INTERVAL ${RAW_TTL_DAYS} DAY
SETTINGS ttl_only_drop_parts = 1, non_replicated_deduplication_window = 10000;

-- Relay fills on the RH side (relay-chain.ts fillOf): who received which token, paid with how much USDG/WETH.
CREATE TABLE ev_relay (
  block UInt64, tx_index UInt32, tx_hash FixedString(66), time DateTime,
  recipient FixedString(42), token FixedString(42), amount UInt256, usdg_in UInt256, weth_in UInt256,
  keep UInt16, sign Int8
) ENGINE = MergeTree PARTITION BY toYYYYMMDD(time) ORDER BY (block, tx_index)
TTL time + INTERVAL ${RAW_TTL_DAYS} DAY
SETTINGS ttl_only_drop_parts = 1, non_replicated_deduplication_window = 10000;

-- kept_*: the same columns, forever, one row per natural key (a promoted row arriving twice is one row).
CREATE TABLE kept_blocks AS raw_blocks ENGINE = ReplacingMergeTree PARTITION BY toYYYYMM(time) ORDER BY number SETTINGS non_replicated_deduplication_window = 10000;
CREATE TABLE kept_txs AS raw_txs ENGINE = ReplacingMergeTree PARTITION BY toYYYYMM(time) ORDER BY (block, tx_index) SETTINGS non_replicated_deduplication_window = 10000;
CREATE TABLE kept_logs AS raw_logs ENGINE = ReplacingMergeTree PARTITION BY toYYYYMM(time) ORDER BY (address, topic0, block, log_index) SETTINGS non_replicated_deduplication_window = 10000;
CREATE TABLE kept_transfers AS ev_transfers ENGINE = ReplacingMergeTree PARTITION BY toYYYYMM(time) ORDER BY (token, block, log_index, batch_index) SETTINGS non_replicated_deduplication_window = 10000;
CREATE TABLE kept_native AS ev_native ENGINE = ReplacingMergeTree PARTITION BY toYYYYMM(time) ORDER BY (block, tx_index, path) SETTINGS non_replicated_deduplication_window = 10000;
CREATE TABLE kept_swaps AS ev_swaps ENGINE = ReplacingMergeTree PARTITION BY toYYYYMM(time) ORDER BY (pool, block, log_index) SETTINGS non_replicated_deduplication_window = 10000;
CREATE TABLE kept_pools AS ev_pools ENGINE = ReplacingMergeTree PARTITION BY toYYYYMM(time) ORDER BY (pool, block, log_index) SETTINGS non_replicated_deduplication_window = 10000;
CREATE TABLE kept_launches AS ev_launches ENGINE = ReplacingMergeTree PARTITION BY toYYYYMM(time) ORDER BY (token, block, log_index) SETTINGS non_replicated_deduplication_window = 10000;
CREATE TABLE kept_relay AS ev_relay ENGINE = ReplacingMergeTree PARTITION BY toYYYYMM(time) ORDER BY (block, tx_index) SETTINGS non_replicated_deduplication_window = 10000;

CREATE MATERIALIZED VIEW mv_kept_blocks TO kept_blocks AS SELECT * FROM raw_blocks WHERE keep != 0;
CREATE MATERIALIZED VIEW mv_kept_txs TO kept_txs AS SELECT * FROM raw_txs WHERE keep != 0;
CREATE MATERIALIZED VIEW mv_kept_logs TO kept_logs AS SELECT * FROM raw_logs WHERE keep != 0;
CREATE MATERIALIZED VIEW mv_kept_transfers TO kept_transfers AS SELECT * FROM ev_transfers WHERE keep != 0;
CREATE MATERIALIZED VIEW mv_kept_native TO kept_native AS SELECT * FROM ev_native WHERE keep != 0;
CREATE MATERIALIZED VIEW mv_kept_swaps TO kept_swaps AS SELECT * FROM ev_swaps WHERE keep != 0;
CREATE MATERIALIZED VIEW mv_kept_pools TO kept_pools AS SELECT * FROM ev_pools WHERE keep != 0;
CREATE MATERIALIZED VIEW mv_kept_launches TO kept_launches AS SELECT * FROM ev_launches WHERE keep != 0;
CREATE MATERIALIZED VIEW mv_kept_relay TO kept_relay AS SELECT * FROM ev_relay WHERE keep != 0;

-- Control state (small, mutable through versions).
CREATE TABLE ctl_cursors (name String, block UInt64, hash String, version UInt64)
ENGINE = ReplacingMergeTree(version) ORDER BY name;

-- value: a lower-case address, a v4 pool id, a tx hash, or "from-to" for a block_range.
CREATE TABLE ctl_watchlists (
  list LowCardinality(String), kind Enum8('wallet' = 1, 'token' = 2, 'pool' = 3, 'tx' = 4, 'block_range' = 5),
  value String, keep_bits UInt16, removed UInt8 DEFAULT 0, added_at DateTime DEFAULT now(), version UInt64
) ENGINE = ReplacingMergeTree(version) ORDER BY (list, kind, value);
