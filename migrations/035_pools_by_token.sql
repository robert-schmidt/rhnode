-- A token's pools (2026-11-02): pools is keyed by pool, so looking up a token's pools (a card's candidates, its official
-- pool, the pools left out of its top 10) read all 1.65M rows, four times for a cold card (~1.7 s of its ~2 s). Bloom
-- filters on token0 and token1 (2 MiB), used under FINAL too, tested on a copy: one token 185 → 15 MiB, 557 → 157 ms
-- (WETH, with the most pools, 102 ms); the official-pool lookup 275 → 4 MiB, 730 → 112 ms.
ALTER TABLE pools ADD INDEX IF NOT EXISTS ix_token0 token0 TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE pools ADD INDEX IF NOT EXISTS ix_token1 token1 TYPE bloom_filter(0.01) GRANULARITY 1;
ALTER TABLE pools MATERIALIZE INDEX ix_token0;
ALTER TABLE pools MATERIALIZE INDEX ix_token1;
