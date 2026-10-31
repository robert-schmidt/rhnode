// Robinhood Chain constants. Every address carries its provenance — where it
// was verified and when (docs/providers.md holds the full trail). NOTHING in
// this file is inferred from another chain.
export const CHAIN_ID = 4663;

export const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com"; // official docs; rate-limited, no WS
export const BLOCKSCOUT = "https://robinhoodchain.blockscout.com"; // canonical explorer (Robinhood docs)

// ~101 ms measured via Blockscout stats 2026-08-09. Used for window arithmetic
// only — never assume exactness; blocks are counted, time is derived.
export const BLOCK_MS = 101;

// Core assets (official docs.robinhood.com/chain/contracts, cross-verified
// on-chain 2026-08-09; WETH triple-verified via router WETH9()).
/** Relay (relay.link) execution on Robinhood Chain — fomo's buy path. A trader's
 *  in-app buy is paid on another chain (Base USDC, Solana…) and FILLED here by a
 *  Relay solver's transaction: solver → these contracts → pool → the trader. The
 *  fill's requester is in Relay's public request API. */
export const RELAY_CONTRACTS = new Set([
  "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be", // RelayApprovalProxyV3
  "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f", // RelayRouterV3
  "0x0005ea38eb0a69d1253508ebdbdb9ea8cb26b5ef", // ERC1967Proxy on the Relay path
  "0x0729e2a4716d9f7dd17858d5d504426d228697f7", // Relay v3.2 router (rhnode: seen in ingested txs 2026-10-29). ponytail: proxy 0xa834e703… not seen yet, add when found
]);
/** The app whose Relay requests are a trader's own buys. fomo tags its requests
 *  referrer 'fomo' and attaches its 0.5% app fee (40 + 10 bps, measured
 *  2026-09-07); a request created by anyone else — no referrer, or relay.link's
 *  own site — is a third party delivering tokens to the trader's account. */
export const RELAY_APP_REFERRER = "fomo";
export const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
export const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
/** Native ETH — how Uniswap v4 (and pools.trade) represent the ETH side of a
 *  pool: the zero address, NOT the wrapped-WETH contract. A quote asset too. */
export const NATIVE_ETH = "0x0000000000000000000000000000000000000000";
/** Quote assets a memecoin pool prices against. Order = preference when
 *  deciding which side of a pool is "the token". */
export const QUOTE_ASSETS = [WETH, USDG, NATIVE_ETH];

// Multicall3 — canonical address, deployment VERIFIED on 4663 via eth_getCode
// (3808 bytes) 2026-08-09.
export const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";

// Uniswap deployments (official developers.uniswap.org deployment pages,
// factories cross-verified as verified contracts on Blockscout 2026-08-09).
export const UNIV2_FACTORY = "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f"; // Blockscout-verified; NOT on Uniswap's docs (community deploy — hood.fun/Flap migrations land here)
export const UNIV3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
export const UNIV4_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";

// Launchpads (Blockscout-verified contracts; docs/providers.md §2).
export const PONS_V2_FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e"; // "PonsV2LaunchFactory"
export const PONS_V1_FACTORY = "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb"; // "PonsLaunchFactory"
export const NOXA_FACTORY = "0xd9ec2db5f3d1b236843925949fe5bd8a3836fccb"; // unverified contract, OLI-tagged; same codebase as Pons v1; dormant since 2026-07-11
export const FLAP_PORTAL = "0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09"; // proxy; impl "Portal" verified
export const HOODFUN_LAUNCHPAD = "0x5fcc1df0dc020cf454e742e9a8ae2554c37a452c"; // "HoodCustomLaunchpad"

/** Every launchpad/factory address we know — protocol custody, never a
 *  stakeholder. One list so the scanner and read-path exclusions agree. */
export const LAUNCHPAD_ADDRS = () => [HOODFUN_LAUNCHPAD, FLAP_PORTAL, PONS_V1_FACTORY, PONS_V2_FACTORY, BAGS_FACTORY, NOXA_FACTORY, UERC20_FACTORY];
export const BAGS_FACTORY = "0xe8cc4431adf8b5a847c113ef0c6af9043219cb37"; // ERC1967Proxy → impl "BagsFactory" 0x7dfa0131…
export const UERC20_FACTORY = "0x000000e200088d55c39a11f609e5f667729ad49b"; // verified "UERC20Factory" — Uniswap's token factory that pools.trade ("built by Uniswap for Robinhood Chain") fronts; graduates to Uniswap v4

// v4 hooks that mark a graduation pool as belonging to a launchpad (official
// launchpad docs, 2026-08-09). A v4 Initialize whose hooks field matches one
// of these is that platform's migration landing.
export const METRIC_OMM_FACTORY = "0x2a53833cc95548cf52c7b159110e22d3a9018f32"; // verified "MetricOmmPoolFactory" (Sourcify); isPool(address)
export const PONS_V2_MEME_HOOK = "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044";
export const BAGS_V4_HOOK = "0x2380abf72c17aabab76480244759ac7e2932eecc";

// ─── Trading (in-app swaps) ───────────────────────────────────────────────────
// Canonical Uniswap deployment on RH Chain (providers.md §infra). VERIFIED live
// 2026-08-10: SwapRouter02 is a 24.5KB contract whose WETH9() returns the
// canonical WETH; QuoterV2 returns a real quote. So v3 (≈99% of pools) trades go
// through SwapRouter02 with QuoterV2 for slippage — no contract of our own.
export const SWAP_ROUTER_V3 = "0xcaf681a66d020601342297493863e78c959e5cb2"; // Uniswap SwapRouter02
export const QUOTER_V2 = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7"; // Uniswap QuoterV2 (non-view; eth_call it)
export const UNIVERSAL_ROUTER = "0x8876789976decbfcbbbe364623c63652db8c0904"; // v3+v4 (v4/Bags path, later)
export const V2_ROUTER = "0x89e5db8b5aa49aa85ac63f691524311aeb649eba"; // UniswapV2Router02 (the ~1% of pools on v2)
export const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3"; // canonical Permit2
// v4 (pools.trade graduates here). Quoter arg is ONE struct — selector 0xaa9d21cb,
// verified on Blockscout + a live quote 2026-08-11. StateView reads pool state by id.
export const V4_QUOTER = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";
export const V4_STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";

// Burn sinks and the launchpad LP lockers (providers.md §2/§6). An LP-token
// holder at one of these means the liquidity is burned or locked — pinned so
// "who holds the LP" can be classified without trusting a third party.
export const BURN_SINKS = ["0x000000000000000000000000000000000000dead", "0x0000000000000000000000000000000000000000"];
export const LP_LOCKERS: Record<string, string> = {
  "0x736d76699c26d0d966744cae304c000d471f7f35": "Pons locker",
  "0x31ca5e101941a93a7dd6d0497928700625cf54b5": "Pons locker (legacy)",
  "0x267444d099b10fb5ed7c3cc7b7c767adca574952": "Pons v2 launch locker",
  "0x4861446aa7ffd9e67a83cbbacb1a4b70540b83aa": "Bags vault",
};

export const lc = (a: string) => a.toLowerCase();

// Addresses that are NOT human wallets — burn sinks (0xdead, 0x0), LP lockers,
// launchpad factories, routers, the v4 pool manager, and the base assets. These
// receive tokens from nearly every launch (LP burns, graduations), so if they leak
// into the ring graph they falsely link every launch together. Never treat one as
// a coordinated actor. (Arkham-labelled cex/dex/launchpad wallets are excluded on
// top of this, at ring-build time, for the ones we don't hard-code.)
export const INFRA_WALLETS = new Set(
  [
    ...BURN_SINKS,
    ...Object.keys(LP_LOCKERS),
    WETH, USDG, NATIVE_ETH,
    SWAP_ROUTER_V3, QUOTER_V2, UNIVERSAL_ROUTER, V2_ROUTER, PERMIT2,
    UNIV4_POOL_MANAGER, UERC20_FACTORY,
    PONS_V1_FACTORY, PONS_V2_FACTORY, NOXA_FACTORY, FLAP_PORTAL, HOODFUN_LAUNCHPAD, BAGS_FACTORY,
    // The v4 hooks themselves hold tokens: the Pons v2 hook takes a 2–4% swap
    // fee in-kind and sweeps it, which on a token page's tape looked like the
    // hook selling 49,740 ETERNAL (observed 2026-09-14). It is the fee, not a
    // trader — and on some transactions its leg is LARGER than the buyer's, so
    // leaving it out mis-attributed the trade as well as adding a row.
    PONS_V2_MEME_HOOK, BAGS_V4_HOOK,
  ].map(lc),
);
