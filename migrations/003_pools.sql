-- M2b: what each pool is (§4.2). From two sources:
-- * `event`: a v2/v3/v4 creation event we ingested (MV below);
-- * `lookup`: a pool that existed before go-live, resolved by the projector the first time it trades
--   (v2/v3: token0/token1/fee/factory by eth_call, checked against the factory; v4: its Initialize log).
-- verified = 1 when the canonical factory/manager vouches for it (v4 Initialize in a PoolManager, or
-- factory.getPair/getPool(token0, token1, fee) == pool). A contract that merely emits Swap events is 0.
-- ok = 0: the lookup failed (not a pool, or the endpoint didn't answer); the projector retries after a while.
CREATE TABLE pools (
  pool String, venue Enum8('v2' = 2, 'v3' = 3, 'v4' = 4), manager String,
  token0 String, token1 String, fee UInt32, tick_spacing Int32, hooks String, factory String,
  created_block UInt64, created_time DateTime, source LowCardinality(String), verified UInt8, ok UInt8, version UInt64
) ENGINE = ReplacingMergeTree(version) ORDER BY pool;

-- ponytail: a rolled-back creation event leaves its pools row (ReplacingMergeTree can't subtract); reorgs that
-- undo a pool creation are rare and the row stays true for the re-mined block.
CREATE MATERIALIZED VIEW mv_pools TO pools AS
SELECT pool, venue,
  if(venue = 'v4', '0x8366a39cc670b4001a1121b8f6a443a643e40951', pool) AS manager,
  token0, token1, fee, tick_spacing, hooks, '' AS factory,
  block AS created_block, time AS created_time, 'event' AS source, 1 AS verified, 1 AS ok, toUInt64(block) AS version
FROM ev_pools WHERE sign = 1;
