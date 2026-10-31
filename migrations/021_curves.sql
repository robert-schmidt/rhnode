-- Bonding-curve trades (2026-10-31): a Pons v2 curve's Buy/Sell is a swap with venue 'curve' (src/chain/swaplog.ts),
-- so prices, candles, trades and token cards cover tokens that never left their curve. Widening an Enum8 is metadata
-- only, and the materialized views over these tables carry the new value through (tested on a scratch database).
ALTER TABLE ev_swaps MODIFY COLUMN venue Enum8('v2' = 2, 'v3' = 3, 'v4' = 4, 'curve' = 5);
ALTER TABLE kept_swaps MODIFY COLUMN venue Enum8('v2' = 2, 'v3' = 3, 'v4' = 4, 'curve' = 5);
ALTER TABLE hist_swaps MODIFY COLUMN venue Enum8('v2' = 2, 'v3' = 3, 'v4' = 4, 'curve' = 5);
ALTER TABLE ev_pools MODIFY COLUMN venue Enum8('v2' = 2, 'v3' = 3, 'v4' = 4, 'curve' = 5);
ALTER TABLE kept_pools MODIFY COLUMN venue Enum8('v2' = 2, 'v3' = 3, 'v4' = 4, 'curve' = 5);
ALTER TABLE hist_pools MODIFY COLUMN venue Enum8('v2' = 2, 'v3' = 3, 'v4' = 4, 'curve' = 5);
ALTER TABLE pools MODIFY COLUMN venue Enum8('v2' = 2, 'v3' = 3, 'v4' = 4, 'curve' = 5);
ALTER TABLE ev_prices MODIFY COLUMN venue Enum8('v2' = 2, 'v3' = 3, 'v4' = 4, 'curve' = 5);

-- A curve's identity comes from its TokenLaunched event (the factory vouches for it): token0 the token, token1 the
-- pair token (address(0) is native ETH), verified. From kept_launches, so live and history launches both land here.
-- version = the launch block: the projector's pool lookup never touches venue 'curve', so nothing outranks it.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_curve_pools TO pools AS
SELECT JSONExtractString(detail, 'curve') AS pool, 'curve' AS venue, JSONExtractString(detail, 'curve') AS manager,
  toString(token) AS token0, JSONExtractString(detail, 'pairToken') AS token1, 0 AS fee, 0 AS tick_spacing, '' AS hooks,
  '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e' AS factory, block AS created_block, time AS created_time, 'launch' AS source,
  1 AS verified, 1 AS ok, toUInt64(block) AS version
FROM kept_launches WHERE source = 'pons-v2' AND kind = 'launch' AND sign = 1 AND length(JSONExtractString(detail, 'curve')) = 42;

INSERT INTO pools SELECT JSONExtractString(detail, 'curve') AS pool, 'curve' AS venue, JSONExtractString(detail, 'curve') AS manager,
  toString(token) AS token0, JSONExtractString(detail, 'pairToken') AS token1, 0 AS fee, 0 AS tick_spacing, '' AS hooks,
  '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e' AS factory, block AS created_block, time AS created_time, 'launch' AS source,
  1 AS verified, 1 AS ok, toUInt64(block) AS version
FROM kept_launches FINAL WHERE source = 'pons-v2' AND kind = 'launch' AND sign = 1 AND length(JSONExtractString(detail, 'curve')) = 42;
