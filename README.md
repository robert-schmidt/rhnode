# rhnode

A self-hosted **Robinhood Chain** (chain id 4663) indexer and data API, optionally with its own Nitro node.
It follows the chain tip (from free public RPC endpoints, or your node), decodes everything into ClickHouse, and derives the
facts trading apps usually buy from Alchemy or Blockscout: exact token balances and holders, pools, a price for
every swap, 1-minute candles, and per-wallet trades with PnL inputs.

No API keys, no paid providers. One `docker compose` stack.

## What's built

| Milestone | Status |
|---|---|
| M0 scaffold: compose (ClickHouse + Redis), config profiles, migrations | ✅ |
| M1 tip ingest of every block → `raw_*` + decoded `ev_*` (transfers, swaps, pools, launches, Relay fills), keep bits, reorg rollback | ✅ |
| M2 projector: balances/holders (`agg_balances`, `serve_tokens`), pool identities, prices + 1m candles, wallet trades | in progress |
| Token promotion: a token older than go-live gets its whole history once, on first request (`src/promoter`) | ✅ |
| History walk: every ERC-20 transfer from go-live back to genesis on your own node (`WALK=1`), kept forever; exact wallet history and token balances | built, starts after sync |
| M3 API: `/rpc`, `/ws`, Blockscout-compatible `/api`, API keys | ✅ |
| M4 `/v1/stream` with resume, watchlists | planned |
| M5 `/v1` insights REST | planned |
| M6 own Nitro node (`--profile node`), snapshot seeding, L1 proxy, self-heal + CI-gated deploys | syncing |

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

Data starts at the block you start indexing ("go-live"); there is no genesis backfill. A token minted before then is
**promoted** the first time someone asks for its holders or transfers: rhnode fetches that token's earlier Transfer history
once (a few address-filtered `eth_getLogs` calls, usually under a minute), keeps it forever, and answers exactly from then on.
Tokens with more than `PROMOTE_MAX_TRANSFERS` (500,000) earlier transfers stay refused.

## Run your own Nitro node (optional)

Without a node, `/rpc` proxies free public endpoints (rate-limited, shared with ingest). With one, the reads are local
and unlimited. It's the official `offchainlabs/nitro-node` image, already defined in `compose.yaml` under the `node` profile.

**Needs:** ~1.2 TB of fast disk to start (the snapshot unpacks to ~1.03 TB and grows), at least 16 GB RAM for the whole
stack (Nitro is capped by `NITRO_MEM`, default 8g), and an L1 Ethereum RPC that serves `eth_getLogs` older than ~128
blocks. Keyless `https://eth.drpc.org` works (the default); a free PublicNode token from allnodes.com works too. The
beacon API for blobs defaults to PublicNode's keyless one. Measured 2026-10-30 on a 4-core Xeon E3 with a USB 3 NVMe:
the node replays ~75–80 blocks/s, against ~9.6 produced, so it catches up ~5 days in ~17 h.

```sh
# 1. Seed it from the official snapshot (resumable, verifies each part, ~1 TB download; the parts are deleted after).
VOL=$(docker volume inspect rhnode_nitro -f '{{.Mountpoint}}' 2>/dev/null || (docker volume create rhnode_nitro >/dev/null && docker volume inspect rhnode_nitro -f '{{.Mountpoint}}'))
sudo sh nitro/snapshot.sh "$VOL/robinhood" /path/with/1.1TB/free
# 2. Turn the profile on and start it (it reads L1 through l1proxy, so a keyed URL never reaches Nitro's logs).
echo COMPOSE_PROFILES=node >> .env      # optional: L1_HTTP=url|rps,…  NITRO_MEM=12g  NITRO_DB_CACHE=2048
docker compose up -d
curl -s localhost:8080/health           # nitroBehind counts down to 0
# 3. Once synced, send /rpc and ingest to it, with the public endpoints as fallback:
#    UPSTREAM_HTTP=http://nitro:8547|500,https://rpc.mainnet.chain.robinhood.com|10
```

On macOS, Docker Desktop's VM needs the memory for it (Settings → Resources) and its disk image on a drive with room.

## API

Every route except `GET /health` needs a key from `API_KEYS`: header `x-api-key: KEY`, query `?apikey=KEY`
(Etherscan style), or as the last path segment `/rpc/KEY`, `/ws/KEY` (Alchemy style, for clients that only take a URL).
Each key gets `API_RPS` requests/s (default 200; WebSocket notifications don't count).

| Route | What |
|---|---|
| `POST /rpc` | Ethereum JSON-RPC 2.0, batches included. Proxied to the upstreams (your node in `full`); receipts, txs and old blocks cached. `eth_getLogs` inside the indexed window is answered from ClickHouse with **no range or topic caps**. `alchemy_getTokenBalances` (exact, via Multicall3). `eth_sendRawTransaction` goes to the official sequencer RPC only, never retried elsewhere |
| `wss /ws` | the same JSON-RPC plus `eth_subscribe` `newHeads` and `logs` (any address/topic sets, no caps), fed by ingest (~2 s behind the block timestamp) |
| `GET /api?module=…&action=…` | Etherscan/Blockscout v1: `token.getTokenHolders`, `account.tokentx`, `account.txlist`, `account.balance(multi)`, `logs.getLogs`, `block.eth_block_number`, `contract.getsourcecode` (from Sourcify; 503 when Sourcify has no match, since Blockscout may still have it verified) |
| `GET /api/v2/tokens/{address}` | Blockscout v2 token card (name, symbol, decimals, total supply, holder count) |
| `GET /api/v2/addresses/{address}/token-balances` | Blockscout v2: every ERC-20 the wallet holds now (`[{token, value, token_id}]`). 503 until the history walk has reached genesis (`exactFrom: 0`) |
| `GET /v1/wallets/{address}/first` | `{wallet, firstTx: {block, timeStamp, hash, nonce} \| null, born, dataFrom}`: the first tx it sent that rhnode saw (kept forever). `born: "exact"` (nonce 0, its real first tx), `"before"` (it sent txs before `dataFrom`), `"unknown"` (no tx sent since then) |
| `GET /health` | `{ok, node, upstream, index, stream, head, ingested, lagBlocks, streamAgeS, rawFrom, exactFrom}`; `exactFrom`: every ERC-20 transfer from that block on is held (`account.tokentx` below `rawFrom` reads them), going down to 0 as the walk runs; HTTP 503 when `ok` is false (upstream down, index >600 blocks behind, or no block on the stream for 30 s). `node: "nitro"` means `/rpc` is served by our own node and it is within 50 blocks of the sequencer, for `nitroSinceS` seconds; `"public"` means it proxies the free endpoints. `nitroHead`/`nitroBehind`: the node's sync, when the stack runs one. `eth_getLogs` ending up to 300 blocks past `ingested` waits up to 3 s for ingest instead of going upstream |

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

## Releases and restarts (a server)

- **Release:** `ops/deploy.sh` (on the server, in the repo). It deploys `origin/main` only when its GitHub CI checks are green.
  It rebuilds the app image and recreates only the app services (`ingest`, `projector`, `api`, `l1proxy`), then waits for
  `/health` to show the index and stream fresh. If they don't come back within 3 minutes, it rolls back to the previous commit.
  ClickHouse, Redis and Nitro are never restarted by a release: when their definition changed, it says so, and
  `ops/deploy.sh --infra` applies it. An API or WebSocket change never touches the node.
- **Restarts:** every service has `restart: unless-stopped`, and Docker waits for the data disk (`RequiresMountsFor`). On
  top of that, `ops/rhnode-heal.timer` runs `ops/heal.sh` every 2 minutes: it mounts `DATA_MOUNT` if the disk came up
  late, starts Docker, and runs `docker compose up -d` when a service isn't running. Running containers are never
  restarted. To stop the stack on purpose, stop the timer first. Install it (the units assume `/srv/rhnode`):
  ```sh
  sudo cp ops/rhnode-heal.service ops/rhnode-heal.timer /etc/systemd/system/
  sudo systemctl daemon-reload && sudo systemctl enable --now rhnode-heal.timer
  ```
- Nitro stops with a 5-minute grace period and resumes from its database. After an unclean stop it re-executes from its
  last persisted state.

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
src/promoter/   on-demand history of tokens older than go-live
src/api/        /rpc, /ws, Blockscout-compatible /api, /v1, /health
src/l1proxy.ts  Nitro's L1 reads, with failover and no keyed URL in Nitro's logs
nitro/          the chain's official config files, snapshot.sh
ops/            deploy.sh (CI-gated releases), heal.sh + systemd timer (self-healing)
migrations/     ClickHouse schema (applied in order on start)
```

What the stack runs (all pinned in `compose.yaml` / `package.json`):

| Piece | Version | Role |
|---|---|---|
| ClickHouse | `clickhouse/clickhouse-server:26.3` | the store |
| Redis | `redis:7.4-alpine` | block fan-out to `/ws` |
| Node.js | `node:26-slim` (runs `.ts` directly) | ingest, projector, promoter, api, l1proxy |
| Nitro (profile `node`) | `offchainlabs/nitro-node:v3.12.2-5f02f3f` | own Robinhood Chain node |
| npm | `@clickhouse/client`, `viem`, `redis`, `ws` | |

## License

MIT
