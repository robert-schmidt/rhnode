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

-- The curves' pools rows: migration 022.
