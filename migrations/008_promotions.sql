-- Tokens older than go-live, promoted on demand (ARCHITECTURE §3.1): their Transfer history before go-live is fetched
-- once into ev_transfers (balances) and kept_transfers (forever), then they're watched. status: queued → done |
-- incomplete (minted ≠ totalSupply after the backfill: a non-standard mint) | skipped (too many transfers) | failed.
CREATE TABLE ctl_promotions (
  token FixedString(42), status LowCardinality(String), transfers UInt64, note String,
  queued_at DateTime DEFAULT now(), version UInt64
) ENGINE = ReplacingMergeTree(version) ORDER BY token;
