-- Trades without a price (2026-11-02): a wallet's balance change next to a swap the projector couldn't price (a
-- token/token pool without a bridge, unknown decimals) is a trade too; priced = 0 says its usd/eth (written 0) are
-- unknown. Rows from before keep the default 1. agg_wallet_token's average cost sums priced trades only.
ALTER TABLE ev_trades ADD COLUMN IF NOT EXISTS priced UInt8 DEFAULT 1;
ALTER TABLE kept_trades ADD COLUMN IF NOT EXISTS priced UInt8 DEFAULT 1;
ALTER TABLE hist_trades ADD COLUMN IF NOT EXISTS priced UInt8 DEFAULT 1;
ALTER TABLE all_trades ADD COLUMN IF NOT EXISTS priced UInt8 DEFAULT 1;
ALTER TABLE mv_wallet_token MODIFY QUERY
SELECT wallet, token,
  if(side = 'buy', amount, 0) * sign AS bought, if(side = 'sell', -amount, 0) * sign AS sold,
  if(side = 'buy', usd, 0) * sign AS usd_in, if(side = 'sell', usd, 0) * sign AS usd_out,
  if(side = 'buy', eth, 0) * sign AS eth_in, if(side = 'sell', eth, 0) * sign AS eth_out,
  if(side = 'buy', sign, 0) AS buys, if(side = 'sell', sign, 0) AS sells,
  block AS first_block, block AS last_block
FROM ev_trades WHERE priced = 1;
