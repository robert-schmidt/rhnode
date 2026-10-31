-- Curve payouts (2026-10-31, the owner's go relayed by the app's session, incl. this narrow forever table of internal ETH):
-- what leaves a detected curve (token_markets.curve) other than its own tokens, forever. Native ETH from tip traces
-- (raw_traces, so only since 2026-10-31 04:12 UTC: block 102274040), every value frame from the curve; ERC-20 quotes
-- (WETH, USDG, a launch's pair token) from kept_transfers, back as far as it reaches (the history pass). seller = in the
-- same tx a token went into the curve; the graduation label comes at read time (token_markets.grad_tx), since a
-- graduation is found after its payout lands. usd at write: USDG exact, ETH/WETH at that hour's ETH/USD, a pair token at
-- its last quote-asset price in the day before; null without one. src/discovery.ts writes it.
CREATE TABLE IF NOT EXISTS curve_payouts (
  curve FixedString(42), block UInt64, tx_index UInt32, idx UInt32, tx_hash FixedString(66), time DateTime,
  asset String, recipient String, amount UInt256, usd Nullable(Float64), seller UInt8, source LowCardinality(String)
) ENGINE = ReplacingMergeTree ORDER BY (curve, block, tx_index, idx, source);
