-- A creation event's pools row must outrank a lookup's. Event rows had version = block (~1e8), lookups version = Date.now()
-- (~1.8e12), so a pool looked up while it traded live, before the history pass reached its creation, kept the lookup row
-- (created_block 0, v2/v3) when the event row arrived later: 114,576 pools on 2026-11-11. Events now carry
-- block + 2^41 (2.2e12, above Date.now() until 2039); lookups keep Date.now(), which their hourly retry reads.
ALTER TABLE mv_pools MODIFY QUERY
SELECT pool, venue,
  if(venue = 'v4', '0x8366a39cc670b4001a1121b8f6a443a643e40951', pool) AS manager,
  token0, token1, fee, tick_spacing, hooks, '' AS factory,
  block AS created_block, time AS created_time, 'event' AS source, 1 AS verified, 1 AS ok, toUInt64(block) + 2199023255552 AS version
FROM ev_pools WHERE sign = 1;

ALTER TABLE mv_hist_pools_table MODIFY QUERY
SELECT pool, venue, if(venue = 'v4', '0x8366a39cc670b4001a1121b8f6a443a643e40951', pool) AS manager, token0, token1, fee, tick_spacing, hooks,
  '' AS factory, block AS created_block, time AS created_time, 'event' AS source, 1 AS verified, 1 AS ok, toUInt64(block) + 2199023255552 AS version
FROM hist_pools WHERE sign = 1;

-- The pools whose creation event is still kept get it back (9,016 on 2026-11-11); the rest need the chain (src/tools).
INSERT INTO pools
SELECT pool, venue, if(venue = 'v4', '0x8366a39cc670b4001a1121b8f6a443a643e40951', pool) AS manager, token0, token1, fee, tick_spacing, hooks,
  '' AS factory, block AS created_block, time AS created_time, 'event' AS source, 1 AS verified, 1 AS ok, toUInt64(block) + 2199023255552 AS version
FROM kept_pools
WHERE sign = 1 AND pool IN (SELECT pool FROM pools FINAL WHERE created_block = 0)
SETTINGS workload = 'bulk';
