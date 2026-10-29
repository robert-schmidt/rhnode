-- M2a: exact ERC-20 balances and the token projection (ARCHITECTURE §3.4, §3.5).
-- Aggregates only see transfers inserted after this MV exists: a token is exact when its whole
-- history was ingested (serve_tokens.complete says so).

-- Every holder of every token, Σ(amount × sign). 0x0 goes negative by the minted supply.
-- ponytail: amounts ≥ 2^255 wrap in toInt256 (spam tokens only).
CREATE TABLE agg_balances (token FixedString(42), holder FixedString(42), balance Int256)
ENGINE = SummingMergeTree ORDER BY (token, holder)
SETTINGS non_replicated_deduplication_window = 10000;

CREATE MATERIALIZED VIEW mv_agg_balances TO agg_balances AS
SELECT token, h.1 AS holder, h.2 AS balance FROM ev_transfers
ARRAY JOIN [(`from`, -toInt256(amount) * sign), (`to`, toInt256(amount) * sign)] AS h
WHERE standard = 'erc20';

-- One row per token, rewritten by the projector when the token was touched.
-- complete = 1 when the supply we saw minted (−balance of 0x0) equals totalSupply() at `block`,
-- i.e. we hold the token's whole history and holder numbers are exact.
-- decimals = -1: the token didn't answer decimals() (not retried).
CREATE TABLE serve_tokens (
  token FixedString(42), name String, symbol String, decimals Int16, total_supply UInt256,
  holder_count UInt64, top10 UInt256, minted Int256, complete UInt8,
  block UInt64, version UInt64
) ENGINE = ReplacingMergeTree(version) ORDER BY token;
