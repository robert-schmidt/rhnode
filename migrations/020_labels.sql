-- Address labels (src/labels.ts, 2026-10-31): who an address belongs to (an exchange, a bridge or solver, a flagged
-- address), from free sources. One row per address and source, the latest check wins; a check that found nothing is a
-- row with name '' so it isn't asked again for 30 days. source 'blockscout' is Blockscout's keyless metadata service
-- (it carries the Open Labels Initiative's labels): chain is where the tags came from, 4663 first; another chain's
-- tags are kept only for an address without code here (the same key is the same owner; a contract isn't).
CREATE TABLE IF NOT EXISTS labels (
  address String, source LowCardinality(String), kind LowCardinality(String), name String, chain UInt32,
  tags Array(String), checked DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(checked) ORDER BY (address, source);
