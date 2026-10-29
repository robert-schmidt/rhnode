# rhnode

A self-hosted **Robinhood Chain** (chain id 4663) indexer and data API, with an optional own Nitro node later.
It follows the chain tip from free public RPC endpoints, decodes everything into ClickHouse, and derives the
facts trading apps usually buy from Alchemy or Blockscout: exact token balances and holders, pools, a price for
every swap, 1-minute candles, and per-wallet trades with PnL inputs.

No API keys, no paid providers. One `docker compose` stack.

## What's built

| Milestone | Status |
|---|---|
| M0 scaffold: compose (ClickHouse + Redis), config profiles, migrations | ✅ |
| M1 tip ingest of every block → `raw_*` + decoded `ev_*` (transfers, swaps, pools, launches, Relay fills), keep bits, reorg rollback | ✅ |
| M2 projector: balances/holders (`agg_balances`, `serve_tokens`), pool identities, prices + 1m candles, wallet trades | in progress |
| M3 `/rpc` + `/ws` proxy, Etherscan/Blockscout-compatible `/api` | planned |
| M4 `/v1/stream` with resume, watchlists | planned |
| M5 `/v1` insights REST | planned |
| M6 own Nitro node (`--profile node`) | planned |

Design and reasoning: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run it

Needs Docker with Compose v2 (Linux or macOS). About 3 GB RAM and ~7.5 GB of disk per day of raw history
(measured 2026-10-29 with every block indexed; see `RAW_TTL_DAYS`).

```sh
git clone https://github.com/robert-schmidt/rhnode && cd rhnode
cp .env.example .env               # set CLICKHOUSE_PASSWORD; RAW_TTL_DAYS decides the disk use
docker compose up -d --build       # clickhouse, redis, ingest (migrates on start, follows the tip), projector
docker compose logs -f ingest      # one JSON line every 30 s: lag, rows written, per-endpoint ok/err
```

Query it:

```sh
docker compose exec clickhouse clickhouse-client -u rhnode --password "$(grep ^CLICKHOUSE_PASSWORD .env | cut -d= -f2)" -d rhnode \
  -q "SELECT token, holder_count, symbol FROM serve_tokens FINAL ORDER BY holder_count DESC LIMIT 10"
```

Stop with `docker compose stop`. `docker compose down -v` deletes the data.

## Develop

Node 26 runs the TypeScript directly (no build step).

```sh
npm install
export COMPOSE_FILE=compose.yaml:compose.dev.yaml   # publishes ClickHouse on 127.0.0.1:8123 for host tools
docker compose up -d
npm run check                      # tsc + tests (the ClickHouse tests use their own rhnode_test database)
npm run ingest -- backfill FROM TO # re-read a block range through the same code (idempotent within the dedup window)
node --env-file=.env src/tools/check-balances.ts   # compare indexed balances with balanceOf on chain
```

## Layout

```
src/chain/      decoders (launchpads, v2/v3/v4 swaps, Relay fills), constants, the rotating upstream client
src/ingest/     tip follower + backfill, keep rules, reorg rollback
src/projector/  pools, balances/holders, prices + candles, trades
migrations/     ClickHouse schema (applied in order on start)
```

## License

MIT
