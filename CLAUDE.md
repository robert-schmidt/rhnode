# rhnode: working notes for Claude

A self-hosted Robinhood Chain (4663) node + indexer + API: replaces paid RPC/explorer APIs (Alchemy, Blockscout) for apps
that read the chain, and gives more insight than either.

## Read first
1. `docs/ARCHITECTURE.md`: the design (keep-flag retention, ClickHouse layers, projections, APIs, milestones).
2. `README.md`: how to run it.

## Decided (2026-10-29), change only with a reason written down
- TypeScript on Node 26 for ingest and API. ClickHouse is the main store, Redis is cache/fan-out. No Postgres until there are API accounts.
- Retention: everything `RAW_TTL_DAYS` (14) in `raw_*`/`ev_*`; rows with `keep != 0` also live forever in `kept_*`; aggregates forever.
- The node is the permanent archive of blocks/receipts. Only traces are unrecoverable, so trace at the tip.
- API shapes copy the standards: Ethereum JSON-RPC (+ Alchemy extras), Etherscan/Blockscout v1/v2 subset, own `/v1` REST + stream.
- Two deployment profiles from one codebase (ARCHITECTURE §8.1): `lite` (no node, free endpoints) and `full` (own Nitro).
  Every config-dependent behavior goes behind a setting, never a fork in the code.
- One docker compose stack (`--profile node` adds Nitro), named volumes (no bind mounts for data).
- **API split (2026-10-30):** the public API (/rpc, /ws, /api, /v1, /health) is a separate private service on an edge box.
  This stack publishes ClickHouse/Redis/Nitro on `NODE_BIND` (loopback by default) and `ops/firewall.sh` admits only
  `API_HOST`. Schema changes here must stay compatible with the API's pinned core commit until it bumps.
- **Backward walk (changed 2026-10-30):** once our Nitro is synced, src/promoter also walks from go-live back to genesis,
  newest first, at idle priority on the local node. It fills only what is kept forever (kept_transfers, agg_balances). The walk's
  floor (`exactFrom` in /health) is where exact history starts. A refused wallet is promoted next and answered asynchronously
  (503 "promotion queued" until done). This supersedes the rule below as the walk advances.
- **Wallet txs, all wallets (2026-10-30):** idx_wallet_txs points every wallet at its txs
  (migration 015: from go-live by a view on raw_txs, below it by src/promoter/scan.ts, SCAN=1, one pass over our synced
  node, ~2.5 days). The explorer reads txs through it (ClickHouse, else the node).
- **Wallet index (2026-10-30):** full tx rows (kept_txs) forever only for wallets a request names (explorer pages, API
  params/paths, wallet RPC params; src/watch.ts → ctl_wallet_index). src/promoter/wallets.ts watches each (unless busier
  than WALLET_MAX_TXS_DAY) and copies its raw txs into kept_txs. Older rows come from the node through idx_wallet_txs.
- **Data from go-live forward only** (until the walk runs). No genesis backfill. The only lookups into the past are pool identities (tokens/fee/hooks
  of a pool that trades now) and **token promotion** (changed 2026-10-30, so apps can drop Blockscout): a token older than
  go-live is queued the first time the API refuses it, and src/promoter fetches its pre-go-live Transfer history once into
  kept_transfers + agg_balances (complete only if minted = totalSupply). Wallets stay go-live-forward only.

## Rules
- Free/keyless first, and measure the cost of anything that could bill.
- Secrets live only in env files, never committed or logged. Never log a URL that carries a key (log the host only).
- The chain is the source of truth. Never take prices/market caps/liquidity from DexScreener or similar.
- Measure before claiming. A probe beats a doc; record the date and method next to any number.

## Chain facts worth knowing
- ~104 ms blocks, ~10M tx/day, ~24M logs/day (measured 2026-10-29). Genesis 2026-04-30.
- v4 liquidity is fragmented across forks and decoy pools exist (an 88%-fee v4 decoy was seen): always resolve the real pool from chain.
- Pons: graduation pools are v4 with hook 0xe5e7…e044; fee terms come from the factory `getLaunchedToken(token)` + `getLaunchFeePolicy(token)`.
  Some tokens route creator fees to per-token BeaconProxy holder vaults (beacon 0xa125…fa09; the recipient bytecode keccak starts 0x136d032973) with Merkle `Claimed` events.
- Token locker PinkLock02 `0xbe0b139abc90723af76a89d3051f60ba1b64c8d9`; LP lockers in src/chain/constants.ts `LP_LOCKERS`.
- Relay: fills moved to the v3.2 router 0x0729e2a4… and proxy 0xa834e703…; Fomo-style sells go through 0x0005ea38… (selector 0xea239ef1).
- Blockscout v1 `?limit=` returns fabricated empty lists: use page/offset.
- PublicNode WS can accept a subscribe and never answer (needs a reply timeout); it caps a topic position at 1,000.
- Official RPC getLogs returns `blockTimestamp: 0x0`; Tenderly's keyless gateway caps egress at 1 GB/day (`x-tdly-egress-*` headers).
