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
| M3 API: `/rpc`, `/ws`, Blockscout-compatible `/api`, API keys | ✅ |
| M4 `/v1/stream` with resume, watchlists | planned |
| M5 `/v1` insights REST | planned |
| M6 own Nitro node (`--profile node`) | planned |

Design and reasoning: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run it

Needs Docker with Compose v2. The images are multi-arch (amd64 and arm64), so the same commands work on Linux and macOS.
Indexing every block uses about 3 GB of RAM and ~7.5 GB of disk per day of raw history (measured 2026-10-29;
see `RAW_TTL_DAYS`), and needs only a fraction of one CPU core (~10 blocks/s at the tip; decoding runs at >5,000 blocks/s
on a 2014 Xeon).

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

## API

Every route except `GET /health` needs a key from `API_KEYS`: header `x-api-key: KEY`, query `?apikey=KEY`
(Etherscan style), or as the last path segment `/rpc/KEY`, `/ws/KEY` (Alchemy style, for clients that only take a URL).
Each key gets `API_RPS` requests/s (default 200; WebSocket notifications don't count).

| Route | What |
|---|---|
| `POST /rpc` | Ethereum JSON-RPC 2.0, batches included. Proxied to the upstreams (your node in `full`); receipts, txs and old blocks cached. `eth_getLogs` inside the indexed window is answered from ClickHouse with **no range or topic caps**. `alchemy_getTokenBalances` (exact, via Multicall3). `eth_sendRawTransaction` goes to the official sequencer RPC only, never retried elsewhere |
| `wss /ws` | the same JSON-RPC plus `eth_subscribe` `newHeads` and `logs` (any address/topic sets, no caps), fed by ingest (~2 s behind the block timestamp) |
| `GET /api?module=…&action=…` | Etherscan/Blockscout v1: `token.getTokenHolders`, `account.tokentx`, `account.txlist`, `account.balance(multi)`, `logs.getLogs`, `block.eth_block_number` |
| `GET /api/v2/tokens/{address}` | Blockscout v2 token card (name, symbol, decimals, total supply, holder count) |
| `GET /health` | `{ok, ingested, rawFrom}`: the indexed block window |

Answers are exact or refused, never partial: a window that starts before the indexed data, or holders of a token
minted before indexing began, return **HTTP 503** (clients treat it as "unknown"), or are proxied to Blockscout when
`BLOCKSCOUT_API_KEY` is set.

```sh
curl -s -X POST https://your.host/rpc/$KEY -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}'
curl -s "https://your.host/api?module=token&action=getTokenHolders&contractaddress=0x…&page=1&offset=50&apikey=$KEY"
```

### Linux

- Docker Engine: `curl -fsSL https://get.docker.com | sh` (or your distro's `docker-ce` packages), then run the commands
  above with `sudo` or add yourself to the `docker` group.
- Keep the data on a dedicated disk so the system disk can't fill. Docker ≥ 29 stores images in containerd and volumes
  in Docker's own root, so move both:
  ```sh
  # /etc/docker/daemon.json
  { "data-root": "/mnt/data/docker", "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "3" } }
  # /etc/containerd/config.toml, first line
  root = "/mnt/data/containerd"
  ```
  and add `RequiresMountsFor=/mnt/data` to both services (`systemctl edit docker containerd`), so they wait for the disk.
- USB disks: use a USB 3 port. `lsusb -t` should show `Driver=uas` at 5000M; on USB 2 (`usb-storage`, 480M) writes drop to
  ~40 MB/s, which ClickHouse tolerates but a Nitro node doesn't.
- The API (from M3) listens on `127.0.0.1:${API_PORT}` only. Put nginx or Caddy in front of it; WebSocket paths need
  `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"`.

### macOS

- Docker Desktop or OrbStack. Give the VM at least 6 GB of memory and enough disk (Settings → Resources); on Docker
  Desktop, move the disk image to an external drive there if the internal one is small. Keep the data in named volumes
  (the default here): bind mounts go through virtiofs and are much slower for a database.
- "Clean / Purge data" in Docker Desktop deletes the VM disk, i.e. all indexed data.
- While the Mac sleeps, ingest pauses; on wake it catches up from its cursor.

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
