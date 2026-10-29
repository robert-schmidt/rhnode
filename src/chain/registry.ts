// The event registry: every launch path the watcher subscribes to, in one
// place. Sources: docs/providers.md §2; every ABI below was pulled from the
// VERIFIED contract on Blockscout (2026-08-09) — indexed layouts included —
// and every topic0 was OBSERVED in live chain logs (fixtures/logs.json holds
// real samples used by the tests).
//
// ─── SELF-VERIFYING ──────────────────────────────────────────────────────────
// Each entry pins the topic0 we observed on-chain AND declares the event
// signature. At import, the computed selector must equal the pinned hash —
// a typo in either is a boot failure, not a silently deaf subscription.
import { decodeEventLog, parseAbiItem, toEventSelector, type AbiEvent } from "viem";
import {
  BAGS_FACTORY,
  BAGS_V4_HOOK,
  FLAP_PORTAL,
  HOODFUN_LAUNCHPAD,
  NOXA_FACTORY,
  PONS_V1_FACTORY,
  PONS_V2_FACTORY,
  PONS_V2_MEME_HOOK,
  QUOTE_ASSETS,
  UERC20_FACTORY,
  UNIV2_FACTORY,
  UNIV3_FACTORY,
  UNIV4_POOL_MANAGER,
  lc,
} from "./constants.ts";

export type PoolKind = "v2" | "v3" | "v4";

/** A normalized chain event — what the ingest layer consumes. */
export type ChainEvent =
  | {
      kind: "launch"; curve?: string; graduationThreshold?: string;
      source: string;
      token: string;
      deployer: string;
      /** Direct-to-DEX launchpads create the pool at launch. */
      pool?: string;
      poolId?: string;
      poolKind?: PoolKind;
      pairToken?: string;
      name?: string;
      symbol?: string;
      metadataUri?: string;
    }
  | { kind: "graduated"; source: string; token: string }
  | { kind: "feeRecipient"; source: string; token: string; recipient: string }
  | { kind: "migration"; source: string; token: string; pool?: string; poolId?: string; poolKind: PoolKind; pairToken?: string }
  | { kind: "pool"; source: string; poolKind: PoolKind; token0: string; token1: string; pool?: string; poolId?: string; hooks?: string; fee?: number; tickSpacing?: number };

export type RawLog = {
  address: string;
  topics: string[];
  data: `0x${string}`;
  blockNumber: string; // hex
  blockHash: string;
  transactionHash: string;
  logIndex: string; // hex
};

type Entry = {
  key: string;
  address: string;
  topic0: string; // pinned, observed on-chain
  abi: AbiEvent;
  /** Where the pinned hash was seen — provenance, for humans. */
  observed: string;
  normalize(args: Record<string, unknown>): ChainEvent;
};

const s = (v: unknown) => lc(String(v));

const entries: Entry[] = [
  // ── Pons v2 (dominant, curve-then-migrate to v4) ─────────────────────────
  {
    key: "ponsv2:TokenLaunched",
    address: PONS_V2_FACTORY,
    topic0: "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607",
    abi: parseAbiItem(
      "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
    ) as AbiEvent,
    observed: "live factory logs (fixtures)",
    // curve + graduationThreshold ride along into launch_events.detail so a curve
    // progress read (raised on the curve vs threshold) needs no backfill later.
    normalize: (a) => ({ kind: "launch", source: "pons-v2", token: s(a.token), deployer: s(a.deployer), pairToken: s(a.pairToken), curve: s(a.curve), graduationThreshold: String(a.graduationThreshold) }),
  },
  {
    key: "ponsv2:PoolGraduated",
    address: PONS_V2_FACTORY,
    topic0: "0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259",
    abi: parseAbiItem("event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)") as AbiEvent,
    observed: "live factory logs 2026-08-09 (fixtures) — was computed-only in providers.md, now observed",
    // The v4 poolId arrives via the Initialize catch-all (Pons meme hook).
    normalize: (a) => ({ kind: "migration", source: "pons-v2", token: s(a.token), poolKind: "v4" }),
  },
  {
    // Who a launch's creator fees now go to (lib/fee-terms.ts): a creator
    // transfer, a "reassign fees to holders", or a community takeover. The
    // stored terms go stale and are re-read once — never polled.
    key: "ponsv2:CreatorFeeRecipientUpdated",
    address: PONS_V2_FACTORY,
    topic0: "0x308c390ed1ab5873392818e036cabdf408bc8ad042fbaead3108954ff75ba980",
    abi: parseAbiItem("event CreatorFeeRecipientUpdated(address indexed token, address indexed previousRecipient, address indexed newRecipient)") as AbiEvent,
    observed: "computed from the verified PonsV2LaunchFactory ABI, 2026-09-28",
    normalize: (a) => ({ kind: "feeRecipient", source: "pons-v2", token: s(a.token), recipient: s(a.newRecipient) }),
  },

  // ── Pons v1 + NOXA (direct-to-v3-pool, no migration event exists) ────────
  {
    key: "ponsv1:TokenLaunched",
    address: PONS_V1_FACTORY,
    topic0: "0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a",
    abi: parseAbiItem(
      "event TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)",
    ) as AbiEvent,
    observed: "live factory logs",
    normalize: (a) => ({
      kind: "launch",
      source: "pons-v1",
      token: s(a.token),
      deployer: s(a.deployer),
      pool: s(a.pool),
      poolKind: "v3",
      pairToken: s(a.pairToken),
    }),
  },
  {
    key: "noxa:TokenLaunched",
    address: NOXA_FACTORY,
    topic0: "0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a",
    abi: parseAbiItem(
      "event TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)",
    ) as AbiEvent,
    observed: "same codebase family as Pons v1; topic0 observed on NOXA factory (dormant since 2026-07-11)",
    normalize: (a) => ({
      kind: "launch",
      source: "noxa",
      token: s(a.token),
      deployer: s(a.deployer),
      pool: s(a.pool),
      poolKind: "v3",
      pairToken: s(a.pairToken),
    }),
  },

  // ── Flap (curve → v2 fork) ───────────────────────────────────────────────
  {
    key: "flap:TokenCreated",
    address: FLAP_PORTAL,
    topic0: "0x504e7f360b2e5fe33cbaaae4c593bc55305328341bf79009e43e0e3b7f699603",
    abi: parseAbiItem("event TokenCreated(uint256 ts, address creator, uint256 nonce, address token, string name, string symbol, string meta)") as AbiEvent,
    observed: "live portal logs (fixtures)",
    normalize: (a) => ({
      kind: "launch",
      source: "flap",
      token: s(a.token),
      deployer: s(a.creator),
      name: String(a.name ?? ""),
      symbol: String(a.symbol ?? ""),
      metadataUri: String(a.meta ?? ""),
    }),
  },
  {
    key: "flap:LaunchedToDEX",
    address: FLAP_PORTAL,
    topic0: "0x6e4f47630b8745b8cacbd44f42a8a33e7eea7cc08ef22fc7630f4f385784ff7d",
    abi: parseAbiItem("event LaunchedToDEX(address token, address pool, uint256 amount, uint256 eth)") as AbiEvent,
    observed: "live portal log block ~31821965 (fixture) — was computed-only in providers.md, now observed",
    normalize: (a) => ({ kind: "migration", source: "flap", token: s(a.token), pool: s(a.pool), poolKind: "v2" }),
  },

  // ── hood.fun (curve → v2, LP burned) ─────────────────────────────────────
  {
    key: "hoodfun:TokenCreated",
    address: HOODFUN_LAUNCHPAD,
    topic0: "0x91de26bc430b3a4f1d6cfb11d72f2e5ca75d7622d37b2a88a8998ec28e747a11",
    abi: parseAbiItem(
      "event TokenCreated(address indexed token, address indexed creator, string name, string symbol, string metadataURI, uint256 virtualEth, uint256 virtualTokens, uint256 curveSupply)",
    ) as AbiEvent,
    observed: "live launchpad logs (fixtures)",
    normalize: (a) => ({
      kind: "launch",
      source: "hood-fun",
      token: s(a.token),
      deployer: s(a.creator),
      name: String(a.name ?? ""),
      symbol: String(a.symbol ?? ""),
      metadataUri: String(a.metadataURI ?? ""),
    }),
  },
  {
    key: "hoodfun:Graduated",
    address: HOODFUN_LAUNCHPAD,
    topic0: "0x3a11b9c0ca38b86101cb9e6e1dd2f752c31467c6eaa353f931b801a338406de6",
    abi: parseAbiItem("event Graduated(address indexed token, uint256 raisedEth)") as AbiEvent,
    observed: "verified-ABI signature; selector self-check (no live sample in fixtures yet — rare event, platform quiet)",
    normalize: (a) => ({ kind: "graduated", source: "hood-fun", token: s(a.token) }),
  },
  {
    key: "hoodfun:Migrated",
    address: HOODFUN_LAUNCHPAD,
    topic0: "0x57aa04076c8e8e00f17b6f082eb7c65ec1aa90f07da036638ccfcb07dcae6cc8",
    abi: parseAbiItem(
      "event Migrated(address indexed token, address indexed pair, uint256 ethLiquidity, uint256 tokenLiquidity, uint256 lpBurned)",
    ) as AbiEvent,
    observed: "live launchpad log (fixture) — was computed-only in providers.md, now observed",
    normalize: (a) => ({ kind: "migration", source: "hood-fun", token: s(a.token), pool: s(a.pair), poolKind: "v2" }),
  },

  // ── Bags (curve → v4 with Bags hook; poolId known at CREATION) ───────────
  {
    key: "bags:TokenCreated",
    address: BAGS_FACTORY,
    topic0: "0x643b3b606052cbadac2f906ad0b462da99eda2a1d4f824d315d7f6edd3e4cced",
    abi: parseAbiItem(
      "event TokenCreated(address indexed token, address indexed curve, address indexed creator, address feeShare, address partner, bytes32 poolId, string name, string symbol, string metadataURI)",
    ) as AbiEvent,
    observed: "live factory logs (fixtures) — event was UNKNOWN in providers.md; resolved from impl ABI 0x7dfa0131…",
    normalize: (a) => ({
      kind: "launch",
      source: "bags",
      token: s(a.token),
      deployer: s(a.creator),
      poolId: String(a.poolId),
      poolKind: "v4",
      name: String(a.name ?? ""),
      symbol: String(a.symbol ?? ""),
      metadataUri: String(a.metadataURI ?? ""),
    }),
  },

  // ── pools.trade (Uniswap's UERC20Factory — "built by Uniswap for RH Chain") ──
  // TokenCreated carries no deployer (unlike Pons/Bags); the token's v4 pool is
  // caught by the univ4:Initialize catch-all below (same tx), which graduates it
  // to 'pool' without touching the 'pools-trade' source set here.
  {
    key: "uerc20:TokenCreated",
    address: UERC20_FACTORY,
    topic0: "0x4ef8284ecf42d4cd19686572ffd87f630858c82398911e776cb831de35eddbf4",
    abi: parseAbiItem(
      "event TokenCreated(address tokenAddress, (string description, string website, string image, bytes extraData) metadata)",
    ) as AbiEvent,
    observed: "live UERC20Factory logs 2026-08-10 (frong + swappy creation txs); topic0 self-verified",
    normalize: (a) => ({ kind: "launch", source: "pools-trade", token: s(a.tokenAddress), deployer: "" }),
  },

  // ── Uniswap factories: the catch-all no launch path can dodge ────────────
  {
    key: "univ2:PairCreated",
    address: UNIV2_FACTORY,
    topic0: "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9",
    abi: parseAbiItem("event PairCreated(address indexed token0, address indexed token1, address pair, uint256 n)") as AbiEvent,
    observed: "canonical + live factory logs",
    normalize: (a) => ({ kind: "pool", source: "uniswap-v2", poolKind: "v2", token0: s(a.token0), token1: s(a.token1), pool: s(a.pair) }),
  },
  {
    key: "univ3:PoolCreated",
    address: UNIV3_FACTORY,
    topic0: "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118",
    abi: parseAbiItem(
      "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
    ) as AbiEvent,
    observed: "canonical + live factory logs",
    normalize: (a) => ({ kind: "pool", source: "uniswap-v3", poolKind: "v3", token0: s(a.token0), token1: s(a.token1), pool: s(a.pool) }),
  },
  {
    key: "univ4:Initialize",
    address: UNIV4_POOL_MANAGER,
    topic0: "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438",
    abi: parseAbiItem(
      "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
    ) as AbiEvent,
    observed: "live PoolManager logs (1,651 in ~5.6h measured 2026-08-09)",
    normalize: (a) => ({
      kind: "pool",
      source: "uniswap-v4",
      poolKind: "v4",
      token0: s(a.currency0),
      token1: s(a.currency1),
      poolId: String(a.id),
      hooks: s(a.hooks),
      // The rest of the PoolKey: with these on record a v4 pool can be quoted
      // later without re-reading its Initialize.
      fee: Number(a.fee),
      tickSpacing: Number(a.tickSpacing),
    }),
  },
];

// ─── The self-check: a typo'd signature or hash refuses to boot ─────────────
for (const e of entries) {
  const computed = toEventSelector(e.abi);
  if (computed !== e.topic0) {
    throw new Error(`registry ${e.key}: computed selector ${computed} does not match pinned observed topic0 ${e.topic0}`);
  }
}

const byKey = new Map(entries.map((e) => [`${e.address}:${e.topic0}`, e]));

export const registryEntries = entries;
export const watchAddresses = [...new Set(entries.map((e) => e.address))];
export const watchTopics = [...new Set(entries.map((e) => e.topic0))];

/** v4 hooks → the launchpad whose graduation pool they mark. */
export const HOOK_SOURCES: Record<string, string> = {
  [PONS_V2_MEME_HOOK]: "pons-v2",
  [BAGS_V4_HOOK]: "bags",
};

/** Which side of a pool is "the token"? The non-quote side; null when the
 *  pool is not against a known quote asset (we do not invent memecoins). */
export function tokenSideOf(token0: string, token1: string): { token: string; quote: string } | null {
  const t0 = lc(token0);
  const t1 = lc(token1);
  const q0 = QUOTE_ASSETS.includes(t0);
  const q1 = QUOTE_ASSETS.includes(t1);
  // Both sides are quote assets (WETH/USDG, native-ETH/USDG) — not a memecoin
  // pool; inventing a "token" here is how WETH/USDG leaked in as a launch.
  if (q0 && q1) return null;
  if (q1) return { token: t0, quote: t1 };
  if (q0) return { token: t1, quote: t0 };
  return null;
}

export type Decoded = { entry: Entry; event: ChainEvent; log: RawLog };

/**
 * Decode a raw log through the registry. Returns null for logs the registry
 * does not claim — the caller counts them; an unknown log is never a crash.
 */
export function decodeChainLog(log: RawLog): Decoded | null {
  const entry = byKey.get(`${lc(log.address)}:${log.topics[0]}`);
  if (!entry) return null;
  const { args } = decodeEventLog({
    abi: [entry.abi],
    data: log.data,
    topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
  });
  return { entry, event: entry.normalize(args as Record<string, unknown>), log };
}
