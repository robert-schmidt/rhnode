# rhnode architecture

A self-hosted Robinhood Chain (chain id 4663) node, indexer and API. Apps that read the chain
(trading bots, dashboards, wallets) can move ALL of their chain reads here: the Alchemy-style calls
(JSON-RPC + WebSocket) and the Blockscout-style calls (holders, token info, transfer history). Written 2026-10-29. Treat the numbers as
measured-then and re-measure before sizing hardware.

## 0. The chain, measured 2026-10-29 (from a VPS, sample of 30 blocks over ~2 min)

| | |
|---|---|
| Genesis | 2026-04-30 16:52 UTC, head ≈ 101.16M blocks |
| Block time | ~104 ms → ~828K blocks/day |
| Transactions | ~12.2 / block → **~10M / day** |
| Logs | ~28.6 / block → **~23.7M / day**; 51% are ERC-20 `Transfer` (0xddf252ad) |
| Raw receipt JSON | ~26 GB / day uncompressed |
| Emitters | very concentrated (144 distinct addresses across 30 blocks) |

The chain is Arbitrum Nitro (Orbit) with a centralized sequencer. Reorgs of sequenced blocks
are rare but possible; batches posted to L1 become `safe`, and L1 finality makes them `finalized`.

For scale: one active trading bot on this chain made ~500K Alchemy calls a day (411K `eth_call`) plus ~56K
Blockscout calls (2026-10-02).

## 1. What we are building, in one picture

```
 Ethereum L1 (exec + beacon; free public endpoints, §8.2)
        │
 ┌──────┴───────┐   sequencer feed (wss://feed.mainnet.chain.robinhood.com)
 │ Nitro node   │◄──────────────────────────────────────────────────────────
 │ (full, path) │  HTTP/WS JSON-RPC on localhost only — never exposed
 └──────┬───────┘
        │ eth_getBlockByNumber(full) + eth_getBlockReceipts + debug_traceBlockByNumber(callTracer, live tip only)
        ▼
 ┌────────────────────────────────────────────────────────────┐
 │ ingest (TypeScript, Node 26)                               │
 │  head follower (WS newHeads → fetch block) + backfill      │
 │  workers, ONE decoder for both, so their outputs match     │
 │  keep-rules engine stamps every row with a `keep` bitmask  │
 └──────┬─────────────────────────────────────────────────────┘
        │ batched inserts (per ~1 s / N blocks)
        ▼
 ┌────────────────────────── ClickHouse ──────────────────────┐
 │ raw_*      everything, 14-day TTL         (working set)    │
 │ kept_*     flagged rows, forever          (curated history)│
 │ ev_*       decoded events (raw/kept split, same rule)      │
 │ agg_*      materialized-view aggregates, forever, exact    │
 │ serve_*    projections keyed for point reads (API reads)   │
 │ ctl_*      watchlists, cursors, jobs (small, mutable)      │
 └──────┬─────────────────────────────────────────────────────┘
        │                         ┌──────── Redis ─────────────┐
        │  projector (async,      │ hot JSON cards, head/price,│
        │  dirty-key driven) ────►│ pub/sub for streams,       │
        │                         │ rate limits                │
        ▼                         └────────────────────────────┘
 ┌────────────────────────────────────────────────────────────┐
 │ api (Fastify on Node 26)                                   │
 │  /rpc   JSON-RPC: proxy to Nitro + cache + alchemy_* extras│
 │  /ws    eth_subscribe fan-out: no topic caps, resumable    │
 │  /api   Blockscout/Etherscan-compatible subset             │
 │  /v1    insights REST (OpenAPI 3.1)                        │
 │  /v1/stream  decoded-event WebSocket with resume cursors   │
 └────────────────────────────────────────────────────────────┘
```

**Key idea: the node is the permanent archive.** A full Nitro node keeps every block and receipt
forever. Only *state* is pruned: old-block `eth_call` and deep traces are lost. So deleting a raw
row from ClickHouse after 14 days loses nothing we can't re-read. The 14-day raw set is a fast
working copy. `kept_*` is the curated permanent copy we query quickly. Aggregates are computed
from the full stream at insert time, so they stay exact after the raw rows expire.
**The one thing that is NOT recoverable is traces** (internal calls / internal ETH transfers)
for blocks older than the node's state window (~128 blocks) without archive mode. We trace at the
tip and store what we need from the traces (§3.4).

## 2. Technology choices

| Concern | Choice | Why | Rejected |
|---|---|---|---|
| Node | **Nitro** full node (path DB), current stable (v3.12.2 per the memo) | Only real option. Archive mode only if deep history state is ever needed (known RAM/crash issue #4736) | Archive node (disk/RAM), feed-only (can't sync) |
| Language | **TypeScript on Node 26** for ingest + API | The decoders were ported from an existing TypeScript trading bot, and the team knows it. ClickHouse does the heavy lifting | Rust/Go: only if ingest CPU is the measured bottleneck. `cryo` (Paradigm) is an optional bulk backfill accelerator |
| Main store | **ClickHouse** | 24M logs/day, 10× columnar compression, `TTL … DELETE WHERE`, materialized views (exact sums, uniq, argMax), ms point reads on `ORDER BY` keys, cheap whole-partition drops | Postgres/Timescale: retention drops whole chunks (no per-row keep), row updates too slow at this volume. Self-hosted Blockscout: multi-TB Postgres, no retention, no custom aggregates (but it would be a zero-code-change Blockscout API; keep that as plan B) |
| Control state | **ClickHouse `ctl_*`** (ReplacingMergeTree) at first | One fewer datastore to run. Watchlists/cursors are tiny and low-write | Postgres: add only when we sell API access (accounts, billing) |
| Cache / fan-out | **Redis** | Hot cards, latest head/prices, pub/sub to WS clients, token-bucket rate limits | — |
| API server | **Fastify** (+ `ws` for sockets), `@clickhouse/client`, `undici` to the node | Fast, JSON-schema validation, OpenAPI generated from schemas | Express (slower), uWebSockets.js (only if client count explodes) |

## 3. Data model

### 3.1 The `keep` bitmask (the retention flag)

Every raw/decoded row carries `keep UInt16`. The ingest-time **keep-rules engine** sets it from
in-memory sets that are loaded from `ctl_watchlists` and refreshed on change:

| Bit | Name | Set when the row… |
|---|---|---|
| 1 | `WATCH_WALLET` | involves a watched wallet (tx from/to, Transfer from/to, swap sender/recipient, trace from/to) |
| 2 | `WATCH_TOKEN` | involves a watched token (held, scanned, tracked) |
| 4 | `LAUNCH` | is a launchpad/factory event, a token creation, or falls in a new token's first N hours of trading (default 24 h) |
| 8 | `TRACKED_POOL` | is a swap / mint / burn on a pool of a watched token |
| 16 | `RELAY` | is a Relay router fill (all Relay contracts, incl. v3.2 router 0x0729e2a4… and proxy 0xa834e703…, per memo §4) |
| 32 | `LOCKS` | touches PinkLock02 / LP lockers / Pons fee vaults |
| 64 | `PINNED` | was pinned by hand or API (tx hash or block range) |
| 128 | `OWN` | involves our own bot wallet(s) |
| 256 | `UNRECOVERABLE` | is trace-derived data (internal transfers): can't be re-read later, kept by default (measure the volume first) |

**Rule:** `keep = 0` ⇒ the row lives 14 days (`raw_*`/`ev_*`). `keep ≠ 0` ⇒ it is also written to
`kept_*` at insert time (a materialized view `WHERE keep != 0`) and lives forever. Blocks get a
block-level flag too (`raw_blocks.keep` = OR of their rows), and `PINNED` can cover a range.

**Becoming interesting later ("promotion").** When something joins a watchlist, for example a wallet
that turns out to be good after 7 days:
1. **Inside 14 days:** `INSERT INTO kept_x SELECT … FROM raw_x WHERE <involves it> AND block_time > now() - 14 DAY`, with keep bits added.
2. **Older:** a promotion job re-reads the node (unlimited `eth_getLogs` by topic/address against our own
   node), decodes, and inserts into `kept_*`. Promotion depth is therefore unlimited and costs nothing.
`kept_*` are ReplacingMergeTree on the natural key `(block, tx_index, log_index)`, so a row promoted
twice is one row. So "give me the last week of this newly interesting wallet" is one API call.

**Coverage is reported honestly.** Every history response carries
`coverage: { from_block, to_block, complete }`, so a consumer never mistakes a partial answer for a full one.
An unwatched wallet's history is "last 14 days, complete=false" until promoted.

### 3.2 Raw tables (14-day TTL, `PARTITION BY toYYYYMMDD(block_time)`, `ttl_only_drop_parts = 1`)

Sketch, to adjust while building:

```sql
CREATE TABLE raw_blocks (number UInt64, hash FixedString(66), parent_hash FixedString(66), time DateTime64(3),
  tx_count UInt16, gas_used UInt64, base_fee UInt64, l1_block UInt64, keep UInt16, sign Int8)
ENGINE = MergeTree PARTITION BY toYYYYMMDD(time) ORDER BY number
TTL toDateTime(time) + INTERVAL 14 DAY DELETE SETTINGS ttl_only_drop_parts = 1;

CREATE TABLE raw_txs (block UInt64, tx_index UInt16, hash FixedString(66), time DateTime64(3),
  `from` FixedString(42), `to` String, -- addresses lower-cased; measure FixedString vs String compression
  value UInt256, selector FixedString(10), input String, status UInt8, gas_used UInt64,
  effective_gas_price UInt64, nonce UInt64, type UInt8, created String, keep UInt16, sign Int8)
ENGINE = MergeTree PARTITION BY toYYYYMMDD(time) ORDER BY (block, tx_index) TTL …;

CREATE TABLE raw_logs (block UInt64, tx_index UInt16, log_index UInt32, tx_hash FixedString(66), time DateTime64(3),
  address FixedString(42), topic0 String, topic1 String, topic2 String, topic3 String, data String, keep UInt16, sign Int8)
ENGINE = MergeTree PARTITION BY toYYYYMMDD(time) ORDER BY (address, topic0, block, log_index) TTL …;
-- second sort order for by-block replays: a projection ORDER BY (block, log_index)

CREATE TABLE raw_traces (block UInt64, tx_hash FixedString(66), path String, call_type LowCardinality(String),
  `from` FixedString(42), `to` FixedString(42), value UInt256, input_selector FixedString(10), error String, keep UInt16, sign Int8) …
-- only frames with value > 0 or a selector we decode; full call trees only for keep != 0 txs
```

`sign` is +1 on insert and −1 for a reorg rollback (§5). Aggregates sum `x * sign`, so a rollback
corrects them by inserting compensating rows. Nothing is mutated.

### 3.3 Decoded events (`ev_*`: same raw/kept split, same keep bits)

Decoded in TypeScript at ingest. The decoders (src/chain/: registry,
swap v2/v3/v4, swaplog, relay) were ported from a bot's battle-tested code, with real logs as fixtures (src/chain/fixtures/).

| Table | Rows | Notes |
|---|---|---|
| `ev_transfers` | ERC-20/721/1155 transfers: token, from, to, amount (UInt256), standard | ~12M/day; the base of balances/holders/flows |
| `ev_native` | top-level value transfers + internal ones from traces | internal = `UNRECOVERABLE` |
| `ev_swaps` | pool, dex (v2/v3/v4/fork), hook, sender, recipient, token_in/out, amount_in/out, sqrtPriceX96, tick, price_eth, price_usd | v4 liquidity is fragmented across forks and decoy pools exist (88%-fee v4 decoys seen). Resolve the real pool from chain, never from a stored kind |
| `ev_liquidity` | mint/burn/modifyLiquidity per pool | LP depth |
| `ev_pools` | v2 PairCreated / v3 PoolCreated / v4 Initialize (PoolManager), with hook + fee | pool registry |
| `ev_launches` | launchpad events (Fomo, Pons factory `getLaunchedToken`/fee policy, others in registry.ts) | `LAUNCH` |
| `ev_relay` | Relay fills: requester, recipient, token in/out, usd, origin chain, referrer | `RELAY` |
| `ev_locks` | PinkLock02 0xbe0b139a…, LP lockers, Pons fee vault Claimed/publish | `LOCKS` |
| `ev_trades` | per-wallet buys/sells: a swap or router fill attributed to the wallet that **acted** (tx signer, userOp, or trace frame from the wallet) | replaces per-app buy/sell classification; traces are local, so "acted" is always decidable at the tip |

### 3.4 Aggregates (`agg_*`, materialized views, forever, exact)

Fed by inserts into `ev_*`. ClickHouse MVs fire on insert, so they see every row before TTL removes it.

| Aggregate | Engine / key | Gives |
|---|---|---|
| `agg_balances` | SummingMergeTree `(token, holder)`: `sum(amount * sign)` | current balance of every holder of every token |
| `agg_native_balances_delta` | SummingMergeTree `(address)` | native balance cross-check (truth is `eth_getBalance` on the node) |
| `agg_wallet_token` | SummingMergeTree `(wallet, token)`: bought/sold amount, eth/usd in/out, n_buys, n_sells, first/last block (SimpleAggregateFunction min/max) | positions + **avg-cost PnL from sums** (realized = value_out − amount_out × avg_in_price) |
| `agg_candles_1m` | AggregatingMergeTree `(pool, minute)`: argMin/argMax/min/max price, volume | OHLCV. 5m/1h/1d roll up via MVs; token price per minute in ETH and USD (ETH/USD from the WETH/USDG pool) |
| `agg_token_hourly` | AggregatingMergeTree `(token, hour)`: transfers, uniqState(senders/receivers/buyers), buy/sell counts and volume | token stats, buyer counts  |
| `agg_wallet_daily` | `(wallet, day)`: tx count, gas, volume, uniqState(tokens) | wallet activity |
| `agg_funding_edges` | `(from, to)`: first_block, first_tx, total value, count (native + WETH/USDG) | funding graph, first funder, shared funders (inputs to side-wallet detection) |
| `agg_token_first` | `(token)`: creation block, creator, first pool, first trade block, first N buyers (groupArray) | launch facts, early buyers, bundle inputs |

Non-additive facts (holder count, top holders, current mcap, liquidity USD) are **not** MVs.
They are computed by the projector (§3.5).

### 3.5 Serving projections (`serve_*` + Redis): what the API reads

The pattern: write once, project many. The ingest marks keys dirty per block batch
(`dirty:tokens`, `dirty:wallets`, `dirty:pools` sets in Redis). The **projector** recomputes only
dirty keys and writes:

| Projection | Store | Contents | Freshness |
|---|---|---|---|
| `serve_tokens` | CH ReplacingMergeTree(version) by `token` + Redis `card:token:<addr>` | name/symbol/decimals/supply (eth_call on first sight + on supply-changing events), creator, launchpad, main pool, price, mcap, liquidity USD, holder_count, top10 %, 24h volume/buys/sells/buyers, risk inputs (LP lock state, fee terms) | ≤1 block batch for dirty tokens |
| `serve_holders` | CH `(token, balance DESC)` snapshot per dirty token | ranked holders (Blockscout `getTokenHolders` drop-in) | same |
| `serve_wallets` | CH by `wallet` + Redis `card:wallet:<addr>` | positions valued at current price, PnL, first funder, activity | same |
| `serve_pools` | CH by `pool` | dex, tokens, fee, hook, reserves/liquidity, price, TVL | same |
| `snap_holders_daily`, `snap_balances_daily` | CH, kept forever for watched tokens | holder-count history, balance history (charts, "who held at launch +1d") | daily |

API p95 targets: point reads (cards) **< 20 ms** (Redis hit) / < 60 ms (CH), ranked lists < 100 ms,
history pages < 150 ms. Streams deliver **< 300 ms** after the node sees the block.
The API never scans `raw_*` except on the explicit history/getLogs endpoints, which are
block-range-capped.

### 3.6 Control tables (`ctl_*`)

`ctl_watchlists (list, kind {wallet|token|pool|tx|block_range}, value, keep_bits, added_at, removed_at, version)`,
`ctl_cursors (name, block, hash, version)`, `ctl_jobs` (promotions, backfills), `ctl_api_keys` (later).
A bot's shortlist, held tokens, tracked pools and own wallets become watchlists.

## 4. Ingest

- **Head follower:** a WS `newHeads` subscription to the node triggers a fetch. `eth_getBlockByNumber(n, true)` + `eth_getBlockReceipts(n)`
  (verified to work on the official RPC 2026-10-29) + `debug_traceBlockByNumber(n, {tracer: "callTracer"})`.
  Batches flush every ~1 s or 10 blocks. It publishes decoded events to Redis pub/sub for `/ws` and `/v1/stream`.
- **Backfill:** the same decode function over block ranges, N workers (worker_threads) against the local node.
  For blocks older than 14 days it skips `raw_*` and writes only `kept_*`, `agg_*`, `ev_*` (kept part). Traces aren't available there.
  Full history is ~101M blocks / ~4.7 TB of receipt JSON. Budget 1–2 days on the node box; `cryo` is the escape hatch if
  JSON parsing in Node is the bottleneck.
- **Order and idempotency:** natural keys everywhere `(block, tx_index, log_index)`. Cursors in `ctl_cursors` advance only after the
  CH insert is acknowledged. Re-running a range is safe for kept/serve (Replacing) and is guarded for agg by the
  `ctl_cursors` high-water mark (never re-insert below it except through the reorg path).
- **Upstream is pluggable:** `UPSTREAM_HTTP`, `UPSTREAM_WS` env. Development runs against the public endpoints
  (official RPC ≈15 rps, dRPC/PublicNode WS. Both delivered 100% of Transfer logs in a 2026-10-29 check).
  Index a narrow recent window there. Full speed needs our node.

### 4.1 As built in M1 (2026-10-29): where the code differs from the sketch above

- **Scope decision (2026-10-29): data from go-live forward only.** This supersedes the genesis backfill above,
  promotion "older than 14 days from the node" (§3.1 step 2) and M6's full backfill. Promotion stays as step 1 (≤ 14 days
  from ClickHouse). The one look into the past is a pool's identity when it first trades after go-live (§4.2).

- **Head: polled, not subscribed.** `eth_blockNumber` every 400 ms when caught up (src/ingest/main.ts). No silent-subscription
  failure mode (PublicNode), and it costs ~2.5 req/s. Switch to WS `newHeads` when `/v1/stream`'s < 300 ms target (M4) needs it.
- **Upstream:** `UPSTREAM_HTTP=url|rps,…` with a token bucket per endpoint and exponential backoff (src/chain/upstream.ts).
  A `null` block/receipts (an endpoint behind the head) rests that endpoint 300 ms. Block and receipts are used only when
  every receipt's `blockHash` matches the block, so two endpoints on different branches can't be mixed.
- **Idempotency = aligned batches + dedup tokens.** Batches are `[k·B, (k+1)·B)` (`BATCH_BLOCKS`, default 10) and each insert
  carries the token `table:from-to`. Every raw/ev/kept table keeps a 10,000-token window, and
  `deduplicate_blocks_in_dependent_materialized_views=1` makes the kept_* MVs drop a replay too. So a kill at any point, or
  a `backfill` over ingested blocks, writes nothing twice, even when the replay's keep bits differ (store.test.ts proves the
  token is what does it). Beyond the window a re-run duplicates raw/ev rows, so re-runs must stay recent or go through promotion.
- **`keep` is per transaction.** A tx touching anything watched is kept whole (all its logs and events), so kept_* never holds
  half a trade. Matching: tx from/to/created, every log emitter, every address-shaped topic, and v4 pool ids (topic 1).
- **`time` is `DateTime` (seconds)**, not DateTime64(3): the chain stamps whole seconds (~10 blocks share one).
- **Rows past the TTL are dropped at insert, but the kept MV still fires.** That is §4's "older than 14 days → kept only" for free.
- **Relay v3.2 router is `0x0729e2a4716d9f7dd17858d5d504426d228697f7`** (found in our own raw_txs). It also routes smart-wallet
  sells, so `fillOf` gained a guard (src/chain/relay.ts). The proxy `0xa834e703…` hasn't appeared yet.
- **Not built in M1:** `INGEST_SCOPE=watched` and `TRACES=tip` (ingest refuses to start with them), reorg rollback (a parent
  mismatch halts ingest; M2), `ev_locks`/`ev_liquidity`/`ev_trades` (M2), Pons fee-vault matching for `LOCKS`.

## 5. Reorgs and finality

Keep `raw_blocks(number, hash, parent_hash)`. On a new block whose `parent_hash` doesn't match our stored hash at `n−1`:
walk back to the fork point, re-insert every affected row with `sign = −1` (aggregates self-correct), and lightweight-`DELETE`
those rows from raw/ev/kept (rare, so the cost is fine). Then ingest the new branch. Responses and stream messages carry
`finality: unsafe | safe | finalized` (Nitro exposes the `safe`/`finalized` tags). Consumers that move money (trading bots)
can require `safe`.

## 6. APIs: why expose them, and why make them look like everyone else's

Exposing standard shapes means:
1. **An existing app switches by changing a base URL.** Its RPC client already speaks JSON-RPC, and its explorer client
   already speaks Etherscan v1 + Blockscout v2. A compatible API lets the switch-over be a settings flag per subsystem,
   with the old providers as fallback.
2. **Any tool works**: viem/ethers/wagmi, Etherscan-style scripts, wallets, other bots.
3. **The node can become a product** (RH data API) with keys and quotas, like Alchemy/Blockscout, once it's proven.

| Surface | Shape | Contents |
|---|---|---|
| `POST /rpc`, `wss /ws` | **Ethereum JSON-RPC 2.0** (batch supported, standard error codes) | Proxied to Nitro: all `eth_*`, `net_*`, `web3_*`, `debug_trace*` (live window; older traces from stored `kept_*` traces when present). Immutable results (blocks/receipts/tx by hash, finalized) cached in Redis. **Alchemy-compatible extras**: `alchemy_getTokenBalances`, `alchemy_getTokenMetadata`, `alchemy_getAssetTransfers` (answered from CH). `eth_subscribe` fan-out: one upstream sub, many clients, **no topic/address caps**, plus a non-standard `fromBlock` resume param |
| `GET /api?module=…&action=…` | **Etherscan/Blockscout v1** | at least the common calls: `account.tokentx`, `account.txlist`, `account.balancemulti`, `token.getTokenHolders`, `logs.getLogs`, `block.eth_block_number`, `contract.getsourcecode` (proxied to Blockscout and cached forever: we can't verify sources ourselves). Same paging (`page`, `offset`, `startblock`, `endblock`, `sort`) and the same `{status, message, result}` envelope |
| `GET /api/v2/…` | **Blockscout v2** subset | `tokens/{addr}` (+counters), `addresses/{addr}/token-balances` |
| `GET /v1/…` | **Insights REST**, OpenAPI 3.1, `{data, meta: {block, finality, coverage, next}}`, cursor paging, ETag | `/v1/tokens/{t}` (card), `/holders`, `/candles?tf=1m`, `/trades`, `/flows` (per-wallet totals, instead of walking tokentx pages), `/early-buyers`, `/launch`; `/v1/wallets/{w}` (card), `/positions`, `/pnl`, `/trades`, `/funding` (graph, first funder); `/v1/pools/{p}`; `/v1/launches` (feed); `/v1/relay/fills` |
| `wss /v1/stream` | decoded-event stream | `subscribe {topic: transfers|swaps|trades|launches|relay|blocks, filter: {wallets, tokens, pools}}`. Every message carries `(block, tx_index, log_index)`; `resume_from` replays from CH (≤14 days, unlimited for kept), so a reconnect has **zero gaps** (no more gap-fill code in consumers) |
| `PUT /v1/watchlists/{name}`, `POST /v1/keep/promote` | control | sets the keep rules and stream interest; promotion as in §3.1 |

Auth: `x-api-key` (static keys in env until there's a second consumer), per-key token buckets in Redis, and per-method
weights (CU-like, as Alchemy does) so a future plan/quota is just configuration. The node's own RPC port is never exposed.

## 7. What lives where (rhnode vs the apps that use it)

**Rule:** if it's a pure function of chain data and useful to more than one consumer, it belongs in rhnode.
If it encodes a strategy or an opinion, or needs off-chain data, it stays in the app.

| rhnode (facts) | apps (opinions / product) |
|---|---|
| raw + decoded events, balances, holders, top holders, holder history | scoring, risk rules (dump points, rugged rule, cabal levels, copycat label) |
| token/pool registry, prices, candles, mcap, liquidity, LP locks, fee terms | trader grading (self-leaderboard bar, precision, record book), shortlist curation |
| per-wallet trades with "who acted", positions, avg-cost PnL | copy / radar / runner / dex books, entry gates, exits, sizing |
| funding graph, first funder, shared funders, co-buys | "this is a side wallet" decision, crews |
| launch facts, early buyers, same-block bundles | bundle *verdicts*, launch scores |
| Relay fills (RH side), router-level trades | Relay origin checks on other chains, Fomo/Arkham/GoPlus/Telegram integrations |
| coverage metadata, finality | users, membership, billing, UI, bot execution |

## 8. Hosting

### 8.0 What "running a node" means here (and what it doesn't)

- **No ETH is locked, no stake, no wallet.** Staking is for *validators*: an Ethereum validator locks 32 ETH to propose blocks,
  and a Robinhood Chain (BoLD) validator posts a bond to assert state on L1. We run neither, only **full nodes** that download,
  re-execute and serve the chain. They need no funds.
- **Why the Robinhood node still talks to Ethereum.** Robinhood Chain is a rollup: its canonical blocks are derived from batches
  the sequencer posts to Ethereum (the SequencerInbox contract + EIP-4844 blobs). Nitro gets the tip fast from the **sequencer feed**
  (the sequencer's soft promise, with only a ~1–2 minute backlog) and confirms/derives the chain by reading those batches **from
  Ethereum**. That's what makes blocks `safe`/`finalized`, and how the node syncs anything the feed doesn't cover. A Nitro node holds
  no Ethereum state itself, so it needs an Ethereum execution RPC + beacon API from somewhere.
- **Who calls whom:**
  ```
  app ──all reads──► rhnode API ──► our Nitro node (Robinhood Chain)
                                            └─ reads L1 batches ──► an Ethereum node: a provider (PublicNode…) OR our own
  ```
  The app never calls a third-party RPC once it's on rhnode. The only outside calls are the node's own L1 lookups:
  it follows the Ethereum head (~12 s) and fetches each batch when posted. That's low volume, so free endpoints cope; their
  risk is availability, not quota.
- **Zero third parties = add our own Ethereum full node** next to Nitro: Reth (or Geth) + Lighthouse with checkpoint sync. Still no
  ETH, still not a validator. Cost: ~1.2–1.5 TB disk, +16–32 GB RAM. That's the production target (plan A below). Free L1
  endpoints are only how we start sooner and cheaper.

A small VPS (≤ 16 GB RAM, a few hundred GB disk) **can't** run a node. Options:

- **A (recommended for production):** one dedicated box with ≥128 GB RAM and ≥4 TB NVMe, running Nitro + ClickHouse + Redis + API.
  Nitro: snapshot 1.1 TB + ~6.5 GB/day (≈3.5 TB/year with no history pruning). ClickHouse: 14 days of raw is ~10–30 GB compressed
  (estimate, measure in M2), kept+agg+serve maybe 0.2–0.5 TB/year. Hetzner AX-class ~€250–300/month.
  RAID1 halves disk, so prefer bigger drives over mirroring and keep snapshots/backups off-box.
- **B:** node on a 64 GB box (€113–171/month), ClickHouse/API on a second one. More moving parts.
- **Now:** develop everything on a Mac with docker (ClickHouse + Redis) against public endpoints. A node is only needed for
  full backfill, tip traces and unlimited throughput (milestone M6).

### 8.1 Deployment profiles: one codebase, config decides

So we can start on the hardware we have and migrate later without a redesign, every difference between "cheap box"
and "proper box" is configuration:

| Setting | `lite` (start here, any 16 GB box) | `full` (proper server, plan A) |
|---|---|---|
| `UPSTREAM_HTTP` / `UPSTREAM_WS` | free endpoint lists with rotation + backoff (official RPC; dRPC → PublicNode WS) | our Nitro node on localhost |
| `INGEST_SCOPE` | `watched`: WS log filters for watchlists + launchpads/factories + Relay routers + tracked pools; `eth_getLogs` backfill by **token address** (the official RPC does 10M-block address-filtered spans) | `all`: every block, tx, log, receipt |
| `TRACES` | `off` ("who acted" falls back to signer/userOp; unknown otherwise) | `tip` (callTracer per block) |
| `RAW_TTL_DAYS` | 3 (only watched-scope rows exist anyway) | 14 |
| ClickHouse | single native install, `max_server_memory_usage` ≈ 3 GB, small mark/uncompressed caches | sized to the box |
| Redis | the existing server's Redis, own DB index + `rh:` prefix | own instance |
| Resource fence | systemd slice: `MemoryMax`, `CPUQuota`, `IOWeight` low, so mail/DNS/sites always win | none |
| Coverage | every response says `coverage.scope = "watched"`; unwatched entities → `complete:false` | `scope = "all"` |

**What lite still delivers:**
- exact holders, top holders, flows, early buyers and candles for **every watched token**, backfilled from its first block by address-filtered getLogs (no Blockscout credits)
- decoded launches, swaps on tracked pools, Relay fills, and wallet transfers for the shortlist
- the same `/rpc` (proxied to the free upstreams), `/api` compat and `/v1` endpoints, plus the resumable stream
- promotion = an address-filtered backfill

**What it can't:** whole-chain indexing (10M tx/day is past free endpoints' ~15 req/s), traces, historical `eth_call`,
or stats over unwatched tokens.

**Migration lite → full** is a rebuild, not a data copy. Stand up `full` on the new box, backfill from genesis
there (the node is the archive), copy only `ctl_watchlists` across, run both in shadow for a day, then point the apps'
base URL at the new box. Nothing in lite's ClickHouse is irreplaceable (its traces are off), so the old box can be wiped afterwards.

### 8.2 Running it on one box

One `compose.yaml` runs everything; `docker compose --profile node up -d` adds Nitro (`full`, from M6), without the profile
it is `lite`. Data lives in named volumes only, and nothing is published except the API on loopback (`API_PORT`, default
8080), so a reverse proxy (nginx, Caddy) or an SSH tunnel decides who reaches it.

- **Linux (recommended):** put Docker's `data-root` on a dedicated disk (`/etc/docker/daemon.json`), so the system disk can't fill.
  The `lite` profile with every block at the tip used ~2.5 GB RAM in total (ClickHouse capped at 4 GB, `clickhouse/limits.xml`).
- **macOS (dev):** Docker Desktop or OrbStack. Put the VM disk on a fast drive and keep data in named volumes (bind mounts
  go through virtiofs, which is far slower for a database). Docker Desktop "Purge data" deletes the VM disk, i.e. the data.
- **The node (M6):** Nitro documents ~64 GB RAM; measure tip-following before trusting a smaller box. Snapshot ~1.1 TB +
  ~6.5 GB/day: 4 TB lasts ~2 years with ClickHouse on the same disk. Stream the snapshot straight into the volume
  (`curl … | tar -x` in a helper container) to avoid a 2.2 TB transient.

The node also needs Ethereum mainnet: an execution RPC (`--parent-chain.connection.url`) and a beacon API for blobs
(`--parent-chain.blob-client.beacon-url`). Probed from a VPS on 2026-10-29:

| Endpoint | Kind | Result |
|---|---|---|
| `https://ethereum-rpc.publicnode.com` | exec | ✅ 10K-block getLogs; no old state (fine, Nitro reads logs/headers) |
| `https://rpc.mevblocker.io` | exec | ✅ 10K-block getLogs and state 200K blocks back (good for the snapshot catch-up) |
| `https://eth.drpc.org` | exec | ⚠️ getLogs < 10K blocks on the free plan |
| `1rpc.io/eth` | exec | ❌ 50-block getLogs. llamarpc, cloudflare-eth, merkle: no answer |
| `https://ethereum-beacon-api.publicnode.com` | beacon | ✅ `blob_sidecars` and `blobs` at head and 15 days back. **The only free beacon found** |
| `lodestar-mainnet.chainsafe.io` | beacon | ❌ 403. beaconstate.ethstaker.cc: no answer |

Consequences: start from a fresh snapshot (≤ ~2 weeks old), because standard beacon nodes keep blobs ~18 days and an older
start needs a blob archive. Set Nitro's secondary beacon URL if a second beacon is found. Nitro takes one exec URL, so put
a tiny local failover proxy in front if needed. The robust answer is our own L1 pair on the same box (Reth or Geth +
Lighthouse with checkpoint sync, ~1.2–1.5 TB, +16–32 GB RAM): it removes the single free beacon as a dependency.

## 9. Milestones

| | Deliverable | Done when |
|---|---|---|
| M0 | repo, docker compose (ClickHouse, Redis), migrations, config incl. the `lite`/`full` profile settings (§8.1) | `npm run check` green |
| M1 | ingest tip from public endpoints → raw_* + ev_* with keep bits; kept_* MVs; TTL | 1 h of tip ingested, re-run idempotent, real fixtures decode as expected |
| M2 | agg_* + projector + serve_*; reorg/sign path tested with a synthetic fork | holders/balances for 20 tokens match `balanceOf` on chain |
| M3 | `/rpc` + `/ws` proxy, alchemy_* extras; `/api` v1/v2 subset | **golden tests**: a real bot's call set gives identical answers vs Alchemy/Blockscout |
| M4 | `/v1/stream` with resume, watchlists, promotion | reconnect mid-burst loses 0 events; a promotion fills 14 days |
| M5 | `/v1` insights | each endpoint replaces one computation apps do today |
| M6 | Nitro (§8.2): snapshot, tip-following under the RAM caveat, 24 h soak | lag p99 < 1 s; or the measured verdict "run lite" |
| M7 | first consumer switch-over per subsystem behind flags, old providers as fallback | a day of parity diffs, then default on |
| M8 | move to a proper server (§8 plan A) when there is one: same compose file, re-snapshot, rebuild | shadow day clean |
