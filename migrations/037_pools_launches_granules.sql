-- pools and kept_launches with 256-row granules (2026-11-06), as 036 did for serve_tokens: both are read by lists of
-- keys (cards, the API's pools/depth/risk, the official pool), and with 8,192-row granules each key cost a whole granule.
-- Replayed on copies, the latest live query of each kind (5 runs, median CPU): pools by key 127K -> 3.6K rows; depth
-- 0.21 -> 0.09 s; a token's pools 3.3M -> 0.23M rows, 0.48 -> 0.15 s; kept_launches by token 709K -> 37K rows.
-- Bloom-filtered batch scans got ~15-30% dearer (more index granules), so cards' top 10 now reads pools by key instead.
-- The MVs writing TO these tables follow the name across EXCHANGE (checked on scratch tables, ClickHouse 26.3).
-- After the swap, the rows written to the old table during the copy: pools' version is a block for 'event'/'curve' rows
-- and a ms timestamp for 'lookup' rows, so each kind is caught up from its own max (a re-copied row only repeats a version).
-- The old tables stay as pools_swap / kept_launches_swap until checked.
CREATE TABLE IF NOT EXISTS pools_swap AS pools ENGINE = ReplacingMergeTree(version) ORDER BY pool SETTINGS index_granularity = 256;
INSERT INTO pools_swap SELECT * FROM pools;
EXCHANGE TABLES pools AND pools_swap;
INSERT INTO pools SELECT * FROM pools_swap WHERE (source = 'lookup' AND version >= (SELECT max(version) FROM pools WHERE source = 'lookup'))
  OR (source != 'lookup' AND version >= (SELECT max(version) FROM pools WHERE source != 'lookup'));
CREATE TABLE IF NOT EXISTS kept_launches_swap AS kept_launches ENGINE = ReplacingMergeTree PARTITION BY toYYYYMM(time) ORDER BY (token, block, log_index)
  SETTINGS non_replicated_deduplication_window = 10000, index_granularity = 256;
INSERT INTO kept_launches_swap SELECT * FROM kept_launches;
EXCHANGE TABLES kept_launches AND kept_launches_swap;
INSERT INTO kept_launches SELECT * FROM kept_launches_swap WHERE block >= (SELECT max(block) FROM kept_launches);
