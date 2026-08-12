// All Ethereum-mainnet constants for the Uniswap v3 + v4 Top Movers boards.
// Every value below was verified live against mainnet on 2026-08-13; the block
// numbers quoted in comments are from that check (head was 25,740,290).
//
// This is the mainnet counterpart of nautilus' Robinhood-chain config. Where a
// value differs for a reason other than "different chain, different address",
// the reason is written down — those are the places the port is not a rename.

// --- RPC ---
// Must be an endpoint that permits a TOPIC-ONLY eth_getLogs (no `address`
// filter), because the v3 sweep below has no address filter by design. Several
// popular free endpoints reject that outright:
//   ethereum-rpc.publicnode.com -> -32701 "Please specify an address"
//   eth.merkle.io               -> -32601 method not found
// Verified working: eth-mainnet.public.blastapi.io and eth.drpc.org.
export const ETH_RPC_URL =
  process.env.ETH_RPC_URL ?? 'https://eth-mainnet.public.blastapi.io';

// Per-request deadline. `fetch` imposes none of its own and undici's default
// header timeout is 300s, so a hung endpoint would stall the caller for minutes
// while looking like nothing at all: no error, no log, just a promise that never
// settles.
export const RPC_TIMEOUT_MS = parseInt(process.env.ETH_RPC_TIMEOUT_MS ?? '30000', 10);

// Largest block span a single eth_getLogs may request.
//
// THIS IS THE BIGGEST STRUCTURAL DIFFERENCE FROM THE ROBINHOOD BUILD. Free
// mainnet endpoints cap the range hard — blastapi answers a 1000-block query
// with `-32600 "You can make eth_getLogs requests with up to a 10 block range"`.
// nautilus copes by bisecting a too-large range after the node rejects it, which
// costs a rejected round-trip at every level of the recursion; from a 300-block
// window down to 10 that is ~31 wasted calls per sweep. Here the range is
// chunked UP FRONT to this size (the reactive split is kept as a backstop for
// providers that cap on result count rather than span). Raise it when pointing
// at a paid endpoint: Alchemy/Infura-class providers allow far more, and every
// increase is one fewer round-trip per cycle.
export const MAX_LOG_RANGE = parseInt(process.env.ETH_MAX_LOG_RANGE ?? '10', 10);

// --- Currencies ---
export const WETH = (
  process.env.ETH_WETH ?? '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
).toLowerCase();
// USDC is the mainnet stand-in for the Robinhood build's USDG: the stablecoin the
// ETH/USD anchor pool is denominated in. 6 decimals.
export const USDC = (
  process.env.ETH_USDC ?? '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
).toLowerCase();
export const USDC_DECIMALS = parseInt(process.env.ETH_USDC_DECIMALS ?? '6', 10);
// The USDC/WETH 0.05% v3 pool — the on-chain source for ETH/USD. Verified via
// factory.getPool(USDC, WETH, 500), which returns exactly this address, and its
// token0() is USDC.
export const USDC_WETH_POOL = (
  process.env.ETH_USDC_WETH_POOL ?? '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640'
).toLowerCase();

// --- Uniswap v3 ---
// Canonical v3 factory. Used to VERIFY a pool is genuinely Uniswap v3 rather
// than a fork — see v3/metadata.ts for why that check does not exist in the
// Robinhood build.
export const V3_FACTORY = (
  process.env.ETH_V3_FACTORY ?? '0x1f98431c8ad98523631ae4a59f267346ea31f984'
).toLowerCase();

// --- Uniswap v4 ---
// PoolManager singleton. Every v4 Swap/Initialize log is emitted by this address.
export const V4_POOL_MANAGER = (
  process.env.ETH_V4_POOL_MANAGER ?? '0x000000000004444c5dc75cb358380d2e3de08a90'
).toLowerCase();
// PositionManager. Its `poolKeys(bytes25)` mapping is how a PoolId is turned back
// into its currencies here — see v4/metadata.ts.
export const V4_POSITION_MANAGER = (
  process.env.ETH_V4_POSITION_MANAGER ?? '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e'
).toLowerCase();
// First block with PoolManager code. Verified by eth_getCode: empty at 21688328,
// 48,020 bytes at 21688329. Floors the Initialize-log fallback scan so it can
// never walk back into pre-deployment history.
export const V4_DEPLOY_BLOCK = parseInt(process.env.ETH_V4_DEPLOY_BLOCK ?? '21688329', 10);

// v4 prices native ETH as Currency = address(0), and WETH pools exist alongside.
// Either side counts as the "ETH leg" for volume and fee valuation.
export const NATIVE_ETH = '0x0000000000000000000000000000000000000000';
export const ETH_CURRENCIES = new Set([WETH, NATIVE_ETH]);
// v4's dynamic-fee flag. A PoolKey carrying it has no fixed tier; the rate
// actually charged arrives per-swap in the Swap event instead.
export const V4_DYNAMIC_FEE_FLAG = 0x800000;

// --- Board knobs ---
export const TOP_N = parseInt(process.env.MOVERS_TOP_N ?? '5', 10);
// 120s, not the Robinhood build's 60s. Measured against the default free endpoint
// on 2026-08-13: a v3 cycle takes ~50s and a v4 cycle ~23s on a WARM cache (78s
// and 38s cold), because both are dominated by sequential eth_calls at ~330ms
// each. A 60s interval would therefore fire mid-cycle every time — the
// cycleRunning guard would absorb it, but every absorbed tick is a logged warning
// for a condition that is really just a mis-set interval. Lower it when pointing
// at a paid endpoint, where the same cycle costs a fraction of the time.
export const POLL_SECONDS = parseInt(process.env.MOVERS_POLL_SECONDS ?? '120', 10);
// Mainnet blocks are ~12s, so 300 blocks ≈ 1 hour of catch-up after downtime.
// (The Robinhood build's 6000 assumed ~594 blk/min; the same wall-clock window is
// two orders of magnitude fewer blocks here.)
export const MAX_LOOKBACK_BLOCKS = parseInt(
  process.env.MOVERS_MAX_LOOKBACK_BLOCKS ?? '300',
  10
);

// --- Market-cap gate ---
// Tokens at or above this USD FDV stay on their board's own list; everything
// below — and everything whose cap cannot be established — goes to the shared
// Danger Zone list.
export const MIN_MARKET_CAP_USD = parseInt(
  process.env.MOVERS_MIN_MARKET_CAP_USD ?? '300000',
  10
);
// Hard ceiling on market-cap lookups per board per cycle. The walk normally stops
// much earlier (as soon as both groups are full); this bounds the worst case.
export const MCAP_MAX_LOOKUPS = parseInt(process.env.MOVERS_MCAP_MAX_LOOKUPS ?? '25', 10);

// --- RSI candles ---
// Candle = fixed block-count window. 25 blocks ≈ 5 min at ~12s/block.
export const BLOCKS_PER_CANDLE = parseInt(process.env.BLOCKS_PER_CANDLE ?? '25', 10);
// Volume floor gating RSI DISPLAY only (0 = disabled). Compared against the row's
// window volume in wei.
export const RSI_MIN_VOLUME_WEI = BigInt(process.env.MOVERS_RSI_MIN_VOLUME_WEI ?? '0');

// --- Event topic0 hashes ---
// Recomputed from the signatures rather than copied; all four match the
// Robinhood build's constants, since the contracts are the same code.
// Swap(address,address,int256,int256,uint160,uint128,int24)
export const V3_SWAP_TOPIC0 =
  '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
// Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)
export const V4_SWAP_TOPIC0 =
  '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
// Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)
export const V4_INITIALIZE_TOPIC0 =
  '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';

// --- eth_call 4-byte selectors ---
export const SEL_SLOT0 = '0x3850c7bd'; // slot0()
export const SEL_SYMBOL = '0x95d89b41'; // symbol()
export const SEL_TOKEN0 = '0x0dfe1681'; // token0()
export const SEL_TOKEN1 = '0xd21220a7'; // token1()
export const SEL_FEE = '0xddca3f43'; // fee()
export const SEL_GET_POOL = '0x1698ee82'; // getPool(address,address,uint24)
export const SEL_POOL_KEYS = '0x86b6be7d'; // poolKeys(bytes25)
export const SEL_TOTAL_SUPPLY = '0x18160ddd'; // totalSupply()
export const SEL_DECIMALS = '0x313ce567'; // decimals()

// --- Explorer (contract verification + source scan) ---
export const EXPLORER_BASE = (
  process.env.ETH_EXPLORER_BASE ?? 'https://eth.blockscout.com'
).replace(/\/$/, '');
// Set 0 to skip verification/audit lookups entirely (one HTTP call per new token).
export const AUDIT_ENABLED = process.env.MOVERS_AUDIT_ENABLED !== '0';
