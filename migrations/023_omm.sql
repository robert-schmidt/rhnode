-- Metric OMM swaps (2026-10-31): venue 'omm' (src/chain/swaplog.ts), metadata only as in 021.
ALTER TABLE ev_swaps MODIFY COLUMN venue Enum8('v2' = 2, 'v3' = 3, 'v4' = 4, 'curve' = 5, 'omm' = 6);
ALTER TABLE kept_swaps MODIFY COLUMN venue Enum8('v2' = 2, 'v3' = 3, 'v4' = 4, 'curve' = 5, 'omm' = 6);
ALTER TABLE hist_swaps MODIFY COLUMN venue Enum8('v2' = 2, 'v3' = 3, 'v4' = 4, 'curve' = 5, 'omm' = 6);
ALTER TABLE ev_pools MODIFY COLUMN venue Enum8('v2' = 2, 'v3' = 3, 'v4' = 4, 'curve' = 5, 'omm' = 6);
ALTER TABLE kept_pools MODIFY COLUMN venue Enum8('v2' = 2, 'v3' = 3, 'v4' = 4, 'curve' = 5, 'omm' = 6);
ALTER TABLE hist_pools MODIFY COLUMN venue Enum8('v2' = 2, 'v3' = 3, 'v4' = 4, 'curve' = 5, 'omm' = 6);
ALTER TABLE pools MODIFY COLUMN venue Enum8('v2' = 2, 'v3' = 3, 'v4' = 4, 'curve' = 5, 'omm' = 6);
ALTER TABLE ev_prices MODIFY COLUMN venue Enum8('v2' = 2, 'v3' = 3, 'v4' = 4, 'curve' = 5, 'omm' = 6);
