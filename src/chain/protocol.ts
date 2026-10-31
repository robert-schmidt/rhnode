// The protocol addresses that are never a holder or a buyer (R9, GET /v1/registry): one list, owned here, read by the
// API's top10 / holder kinds / early buyers and by clients. Per-token protocol addresses (a token's own pools, its
// launchpad curve) are added where a token is known, not listed here.
import {
  BAGS_FACTORY, BAGS_V4_HOOK, BURN_SINKS, FLAP_PORTAL, HOODFUN_LAUNCHPAD, LP_LOCKERS, MULTICALL3, NOXA_FACTORY, PERMIT2,
  PONS_V1_FACTORY, PONS_V2_FACTORY, PONS_V2_MEME_HOOK, QUOTER_V2, RELAY_CONTRACTS, SWAP_ROUTER_V3, UERC20_FACTORY, UNIV2_FACTORY,
  UNIV3_FACTORY, UNIV4_POOL_MANAGER, UNIVERSAL_ROUTER, USDG, V2_ROUTER, V4_QUOTER, V4_STATE_VIEW, WETH,
} from "./constants.ts";
import { RELAY_ROUTERS } from "./relay.ts";

export type ProtocolKind = "burn" | "locker" | "quote" | "router" | "pool_manager" | "factory" | "launchpad" | "hook" | "relay" | "infra";
export type ProtocolEntry = { address: string; kind: ProtocolKind; label: string };

const PINKLOCK02 = "0xbe0b139abc90723af76a89d3051f60ba1b64c8d9";
const list: [string, ProtocolKind, string][] = [
  [BURN_SINKS[0], "burn", "0xdead"], [BURN_SINKS[1], "burn", "zero address"],
  ...Object.entries(LP_LOCKERS).map(([a, l]) => [a, "locker", l] as [string, ProtocolKind, string]),
  [PINKLOCK02, "locker", "PinkLock02"],
  [WETH, "quote", "WETH"], [USDG, "quote", "USDG"],
  [SWAP_ROUTER_V3, "router", "Uniswap SwapRouter02"], [UNIVERSAL_ROUTER, "router", "Uniswap UniversalRouter"],
  [V2_ROUTER, "router", "UniswapV2Router02"], [PERMIT2, "router", "Permit2"],
  [QUOTER_V2, "infra", "Uniswap QuoterV2"], [V4_QUOTER, "infra", "Uniswap v4 Quoter"], [V4_STATE_VIEW, "infra", "Uniswap v4 StateView"],
  [MULTICALL3, "infra", "Multicall3"],
  [UNIV4_POOL_MANAGER, "pool_manager", "Uniswap v4 PoolManager"],
  [UNIV2_FACTORY, "factory", "Uniswap v2 factory"], [UNIV3_FACTORY, "factory", "Uniswap v3 factory"], [UERC20_FACTORY, "factory", "UERC20Factory"],
  [PONS_V1_FACTORY, "launchpad", "Pons v1"], [PONS_V2_FACTORY, "launchpad", "Pons v2"], [NOXA_FACTORY, "launchpad", "Noxa"],
  [FLAP_PORTAL, "launchpad", "Flap"], [HOODFUN_LAUNCHPAD, "launchpad", "hood.fun"], [BAGS_FACTORY, "launchpad", "Bags"],
  [PONS_V2_MEME_HOOK, "hook", "Pons v2 hook"], [BAGS_V4_HOOK, "hook", "Bags v4 hook"],
  ...[...RELAY_CONTRACTS, ...RELAY_ROUTERS].map((a) => [a, "relay", "Relay"] as [string, ProtocolKind, string]),
];

/** address → entry; the first listing of an address wins (e.g. 0x0 is a burn sink before it is native ETH). */
export const PROTOCOL = new Map<string, ProtocolEntry>();
for (const [a, kind, label] of list) if (!PROTOCOL.has(a.toLowerCase())) PROTOCOL.set(a.toLowerCase(), { address: a.toLowerCase(), kind, label });
