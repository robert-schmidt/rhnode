-- serve_tokens with 256-row granules (2026-11-02): lookups by a list of tokens (cards, the API's names, the projector's
-- decimals) run several times a second, and with 8,192-row granules each token cost one whole granule: a 100-token
-- FINAL lookup read 2.73M rows, 130 MiB, 545–741 ms, of a 2M-row table. On a copy with 256: 53K rows, 2.5 MiB,
-- 137–158 ms; the primary index grows to ~270 KiB. index_granularity can't be altered, so: copy, swap, then the rows
-- written to the old table during the copy (a later version). The old table stays as serve_tokens_swap until checked.
CREATE TABLE IF NOT EXISTS serve_tokens_swap AS serve_tokens ENGINE = ReplacingMergeTree(version) ORDER BY token SETTINGS index_granularity = 256;
INSERT INTO serve_tokens_swap SELECT * FROM serve_tokens;
EXCHANGE TABLES serve_tokens AND serve_tokens_swap;
INSERT INTO serve_tokens SELECT * FROM serve_tokens_swap WHERE version > (SELECT max(version) FROM serve_tokens);
