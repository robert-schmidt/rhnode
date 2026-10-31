-- A curve's identity comes from its TokenLaunched event (the factory vouches for it): token0 the token, token1 the
-- pair token (address(0) is native ETH), verified. From kept_launches, so live and history launches both land here.
-- version = the launch block: the projector's pool lookup never touches venue 'curve', so nothing outranks it.
-- Filtered in a subquery: the output's `source` alias would shadow the launch's own column (021's first try matched none).
DROP VIEW IF EXISTS mv_curve_pools;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_curve_pools TO pools AS
SELECT c AS pool, 'curve' AS venue, c AS manager, toString(token) AS token0, pt AS token1, 0 AS fee, 0 AS tick_spacing, '' AS hooks,
  '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e' AS factory, block AS created_block, time AS created_time, 'launch' AS source,
  1 AS verified, 1 AS ok, toUInt64(block) AS version
FROM (SELECT token, block, time, JSONExtractString(detail, 'curve') AS c, JSONExtractString(detail, 'pairToken') AS pt FROM kept_launches
  WHERE source = 'pons-v2' AND kind = 'launch' AND sign = 1) WHERE length(c) = 42;

INSERT INTO pools SELECT c AS pool, 'curve' AS venue, c AS manager, toString(token) AS token0, pt AS token1, 0 AS fee, 0 AS tick_spacing, '' AS hooks,
  '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e' AS factory, block AS created_block, time AS created_time, 'launch' AS source,
  1 AS verified, 1 AS ok, toUInt64(block) AS version
FROM (SELECT token, block, time, JSONExtractString(detail, 'curve') AS c, JSONExtractString(detail, 'pairToken') AS pt FROM kept_launches FINAL
  WHERE source = 'pons-v2' AND kind = 'launch' AND sign = 1) WHERE length(c) = 42;
