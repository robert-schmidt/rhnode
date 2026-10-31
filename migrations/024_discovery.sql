-- Launchpad discovery from the chain itself, not a list (2026-10-31; the owner's go, relayed by the app's session: "do it
-- all and double check the logic, the final result, and what else could be impacted"). src/discovery.ts fills and reads these.
--
-- creations: every contract created since tip tracing began (raw_traces' CREATE/CREATE2 frames, 2026-10-31 04:12 UTC),
-- forever, ~17K a day (measured 2026-10-31). The promoter adds code_hash and the proxy's implementation (checked = 1).
-- ponytail: a reorg deletes the frames but not the row; a re-mined creation lands on the same address and replaces it.
CREATE TABLE IF NOT EXISTS creations (
  created FixedString(42), creator FixedString(42), type LowCardinality(String), block UInt64, tx_hash FixedString(66), time DateTime,
  code_hash String, implementation String, checked UInt8, version UInt64
) ENGINE = ReplacingMergeTree(version) ORDER BY created;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_creations TO creations AS
SELECT toFixedString(`to`, 42) AS created, `from` AS creator, type, block, tx_hash, time, '' AS code_hash, '' AS implementation, 0 AS checked, 0 AS version
FROM raw_traces WHERE type IN ('CREATE', 'CREATE2') AND error = '' AND length(`to`) = 42;

INSERT INTO creations SELECT toFixedString(`to`, 42) AS created, `from` AS creator, type, block, tx_hash, time, '' AS code_hash, '' AS implementation,
  0 AS checked, 0 AS version
FROM raw_traces WHERE type IN ('CREATE', 'CREATE2') AND error = '' AND length(`to`) = 42;

-- token_origin: each ERC-20's first mint (a Transfer from address(0)), forever, live and from the history pass. The
-- version makes the earliest mint win (the pass finds older ones as it walks down) and an enriched row (checked = 1:
-- tx_from, tx_to, the minter) beat its plain one: ((1e10 - block) * 1e6 + 999999 - (tx_index * 1000 + log_index)) * 2 + checked.
CREATE TABLE IF NOT EXISTS token_origin (
  token FixedString(42), block UInt64, tx_index UInt32, log_index UInt32, tx_hash FixedString(66), time DateTime,
  mint_recipient FixedString(42), amount UInt256, tx_from String, tx_to String, minter String, minter_source LowCardinality(String),
  checked UInt8, version UInt64
) ENGINE = ReplacingMergeTree(version) ORDER BY token;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_origin_live TO token_origin AS
SELECT token, block, tx_index, log_index, tx_hash, time, `to` AS mint_recipient, amount, '' AS tx_from, '' AS tx_to, '' AS minter, '' AS minter_source,
  0 AS checked, ((10000000000 - block) * 1000000 + 999999 - least(tx_index * 1000 + least(log_index, 999), 999999)) * 2 AS version
FROM ev_transfers WHERE `from` = '0x0000000000000000000000000000000000000000' AND standard = 'erc20' AND sign = 1;

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_origin_hist TO token_origin AS
SELECT token, block, tx_index, log_index, tx_hash, time, `to` AS mint_recipient, amount, '' AS tx_from, '' AS tx_to, '' AS minter, '' AS minter_source,
  0 AS checked, ((10000000000 - block) * 1000000 + 999999 - least(tx_index * 1000 + least(log_index, 999), 999999)) * 2 AS version
FROM hist_transfers WHERE `from` = '0x0000000000000000000000000000000000000000' AND standard = 'erc20' AND sign = 1;

INSERT INTO token_origin SELECT token, block, tx_index, log_index, tx_hash, time, `to` AS mint_recipient, amount, '' AS tx_from, '' AS tx_to,
  '' AS minter, '' AS minter_source, 0 AS checked,
  ((10000000000 - block) * 1000000 + 999999 - least(tx_index * 1000 + least(log_index, 999), 999999)) * 2 AS version
FROM (SELECT token, block, tx_index, log_index, tx_hash, time, `to`, amount FROM kept_transfers
  WHERE `from` = '0x0000000000000000000000000000000000000000' AND standard = 'erc20' AND sign = 1
  ORDER BY token, block, tx_index, log_index LIMIT 1 BY token);
