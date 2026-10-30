-- New contracts, for apps that watch what gets deployed (src/projector/contracts.ts). Forever, one row per address.
-- * created = 1: made by a tx (raw_txs.created); 0: first seen emitting a log (made by a factory, or before go-live). Until
--   we trace at the tip, a factory-made contract is only seen once it emits (a token at its mint, a pool at Initialize).
-- * fingerprint: the contract's kind, so a consumer can look at unique ones only: a hash of its dispatcher's selectors
--   (same interface = same kind, whatever the compiler metadata), "1167:<impl>" for a minimal-proxy clone,
--   "1967:<impl>" for an upgradeable proxy. first_of_kind = 1 on the first contract with that fingerprint.
-- * kind: erc20 | erc721 | v2pair | v3pool | eip1167 | eip1967 | contract; '' for the seeded rows (code never read).
CREATE TABLE IF NOT EXISTS contracts (
  address FixedString(42), block UInt64, time DateTime, tx_hash String, deployer String, created UInt8,
  kind LowCardinality(String), impl String, code_size UInt32, code_hash String, fingerprint String, selectors Array(String),
  first_of_kind UInt8, version UInt64
) ENGINE = ReplacingMergeTree(version) ORDER BY address;

-- Everything that emitted a log since go-live is known already: seeded without code, so the feed starts from now.
INSERT INTO contracts (address, block, time, tx_hash, deployer, created, kind, version)
SELECT created, block, time, hash, `from`, 1, '', 0 FROM raw_txs WHERE created != '' AND status = 1 AND created NOT IN (SELECT address FROM contracts);
INSERT INTO contracts (address, block, time, created, kind, version)
SELECT address, min(block), min(time), 0, '', 0 FROM raw_logs WHERE address NOT IN (SELECT address FROM contracts) GROUP BY address;
