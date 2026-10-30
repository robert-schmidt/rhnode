-- 009's view and copy kept nothing: in `SELECT * REPLACE (bitOr(keep, 512) AS keep) ... WHERE keep = 0` the WHERE sees the
-- alias (keep | 512), never 0. bitAnd(keep, 511) = 0 holds for the column and the alias alike. Rows the walk or other keep
-- rules already wrote are the same (token, block, log_index, batch_index) key, so ReplacingMergeTree folds any overlap.
DROP VIEW IF EXISTS mv_kept_transfers_all;

CREATE MATERIALIZED VIEW mv_kept_transfers_all TO kept_transfers AS
SELECT * REPLACE (bitOr(keep, 512) AS keep) FROM ev_transfers WHERE standard = 'erc20' AND bitAnd(keep, 511) = 0;

INSERT INTO kept_transfers SELECT * REPLACE (bitOr(keep, 512) AS keep) FROM ev_transfers WHERE standard = 'erc20' AND bitAnd(keep, 511) = 0;
