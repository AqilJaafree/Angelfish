// All BNB Chain constants for the PancakeSwap v3 + Infinity Top Movers boards.
// Every value below was verified live against BSC on 2026-08-15; the block numbers
// quoted in comments are from that check (head was 116,033,800).
//
// Where a value differs from the Ethereum build for a reason other than "different
// chain, different address", the reason is written down — those are the places the
// port is not a rename.

// --- RPC ---
// The general-purpose endpoint: every eth_call, plus the Infinity sweep (which
// address-filters the CLPoolManager singleton and so needs nothing special).
// publicnode is fast and does not rate-limit the call storm.
export const BSC_RPC_URL =
  process.env.BSC_RPC_URL ?? 'https://bsc-rpc.publicnode.com';

// The endpoint used ONLY for the v3 sweep, which is TOPIC-ONLY by design (no
// address filter — that is what makes a brand-new pool visible on its first trade).
//
// THIS SPLIT IS THE BIGGEST STRUCTURAL DIFFERENCE FROM THE ETHEREUM BUILD, where
// one endpoint served both. Almost every free BSC endpoint refuses a topic-only
// eth_getLogs outright. Measured across nine on 2026-08-15:
//   bsc-rpc.publicnode.com      -> -32701 "Please specify an address in your request"
//   bsc-dataseed.bnbchain.org   -> -32005 limit exceeded
//   bsc-mainnet.public.blastapi -> -32000 rate-limited
//   bsc.meowrpc.com             -> -32000 eth_getLogs is not supported
//   bsc.drpc.org / rpc.ankr.com -> public rate limit / API key required
// Only two answered it: 1rpc.io/bnb (50-block cap) and this one (25-block cap).
// So the sweep gets its own endpoint rather than degrading the whole indexer to the
// stricter provider's limits.
export const BSC_LOG_RPC_URL = process.env.BSC_LOG_RPC_URL ?? 'https://bsc.blockrazor.xyz';

// Per-request deadline. `fetch` imposes none of its own and undici's default header
// timeout is 300s, so a hung endpoint would stall the caller for minutes while
// looking like nothing at all: no error, no log, just a promise that never settles.
export const RPC_TIMEOUT_MS = parseInt(process.env.BSC_RPC_TIMEOUT_MS ?? '30000', 10);

// Largest block span a single eth_getLogs may request. blockrazor answers a 100-block
// query with `-32000 "log query range must not exceed 25 blocks"`, so the range is
// chunked UP FRONT to this size (the reactive split in rpc.ts is kept as a backstop
// for providers that cap on result count rather than span). Raise it when pointing at
// a paid endpoint; every increase is one fewer round-trip per cycle.
export const MAX_LOG_RANGE = parseInt(process.env.BSC_MAX_LOG_RANGE ?? '25', 10);

// --- Currencies ---
// See anchors.ts for the anchor SET and why BSC needs more than one. These are the
// individual addresses the rest of the config refers to.
export const WBNB = (
  process.env.BSC_WBNB ?? '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'
).toLowerCase();
// Infinity prices native BNB as Currency = address(0), exactly as Uniswap v4 does
// for native ETH. WBNB pools exist alongside it.
export const NATIVE_BNB = '0x0000000000000000000000000000000000000000';

// USDT is the deepest USD anchor on BSC by a wide margin, and — unlike Ethereum's
// USDC — it is 18 decimals, as are USDC, USD1 and BUSD here. That is load-bearing:
// a stable-anchored raw amount IS the USD amount in 1e18, so no rescaling is needed
// anywhere in the pipeline.
export const USDT = (
  process.env.BSC_USDT ?? '0x55d398326f99059ff775485246999027b3197955'
).toLowerCase();
export const USDC = (
  process.env.BSC_USDC ?? '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'
).toLowerCase();
export const USD1 = (
  process.env.BSC_USD1 ?? '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d'
).toLowerCase();

// Every anchor on BSC is 18 decimals. Verified by decimals() on all five.
export const ANCHOR_DECIMALS = 18;

// The PancakeSwap v3 WBNB/USDT 0.01% pool — the on-chain source for BNB/USD.
// Verified via factory.getPool(WBNB, USDT, 100), which returns exactly this address.
// The 0.01% tier is the active one: 840 swaps in a 400-block sample against 14 for
// the 0.05% pool. Its token0 is USDT (0x55d3… sorts below 0xbb4c…), but the workers
// derive that from the pool's own token0() rather than trusting this comment.
export const WBNB_USDT_POOL = (
  process.env.BSC_WBNB_USDT_POOL ?? '0x172fcd41e0913e95784454622d1c3724f546f849'
).toLowerCase();

// --- PancakeSwap v3 ---
// Canonical v3 factory. Used to VERIFY a pool is genuinely PancakeSwap v3 rather
// than one of the many forks emitting the same Swap topic0 — see v3/metadata.ts.
// Confirmed by factory() on all four WBNB/USDT tiers.
export const V3_FACTORY = (
  process.env.BSC_V3_FACTORY ?? '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865'
).toLowerCase();

// --- PancakeSwap Infinity ---
// CLPoolManager — the concentrated-liquidity singleton. Every Infinity CL Swap log
// is emitted by this address, so the sweep can address-filter it.
export const CL_POOL_MANAGER = (
  process.env.BSC_CL_POOL_MANAGER ?? '0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b'
).toLowerCase();

// BinPoolManager is deliberately NOT indexed. It is deployed and functional, but a
// 300-block sample returned ONE log against the CL manager's 4,341 — it is a live
// contract with no meaningful trading on it, and a whole second worker (Bin uses a
// discrete-bin AMM, not sqrtPriceX96, so none of the pricing or candle code applies)
// would be built for nothing.

// --- Board knobs ---
// Rows per board. Raising this raises MCAP_MAX_LOOKUPS with it — see below.
export const TOP_N = parseInt(process.env.MOVERS_TOP_N ?? '8', 10);

// What the boards rank on.
//
//   'swaps' (default) — raw Swap-event count in the window, busiest pool first.
//   'spike'           — window volume against that pool's OWN recent baseline.
//
// The trade-off is worth knowing before flipping it. Swap count is a fairly stable
// property of a pool, so 'swaps' puts the genuinely busiest pools on top and the
// leaders will look similar cycle to cycle. 'spike' surfaces pools doing something
// unusual FOR THEMSELVES, which keeps the board turning over but lets a pool that
// normally trades nothing win on small absolute numbers.
//
// The spike is computed and displayed either way (the stdout renderer prints it),
// so switching this changes the ORDER, never what a row says about itself.
export type RankMode = 'swaps' | 'spike';
export const RANK_BY: RankMode = process.env.MOVERS_RANK_BY === 'spike' ? 'spike' : 'swaps';
// 120s. At ~0.45s/block that is ~267 blocks, so a 300-block window gives continuous
// coverage with a small overlap rather than a gap.
export const POLL_SECONDS = parseInt(process.env.MOVERS_POLL_SECONDS ?? '120', 10);
// ~2.3 minutes of BSC. Small in wall-clock next to Ethereum's 300 blocks (~1 hour),
// but far denser: a 300-block sweep returned 3,530 v3 swaps across 264 pools and
// 4,341 Infinity swaps across 101. This is the catch-up clamp after downtime too, so
// raising it costs proportionally more chunked getLogs on the 25-block-capped sweep.
export const MAX_LOOKBACK_BLOCKS = parseInt(
  process.env.MOVERS_MAX_LOOKBACK_BLOCKS ?? '300',
  10
);

// --- Market-cap gate ---
// Tokens at or above this USD FDV stay on their board's own list; everything below —
// and everything whose cap cannot be established — goes to the shared Danger Zone.
export const MIN_MARKET_CAP_USD = parseInt(
  process.env.MOVERS_MIN_MARKET_CAP_USD ?? '300000',
  10
);
// Hard ceiling on market-cap lookups per board per cycle. The walk normally stops
// much earlier (as soon as both groups are full); this bounds the worst case.
//
// MUST scale with TOP_N. The walk needs to fill TWO groups of TOP_N — main and
// Danger Zone — so it cannot finish in fewer than 2×TOP_N lookups even if every
// single one lands, and in practice it needs more because a token that trades on
// several fee tiers is memoized to one lookup while still consuming rows. At
// TOP_N=5 the old ceiling of 25 was ALREADY capping both boards every cycle
// ("market-cap lookup ceiling reached" in production on 2026-08-15), so leaving it
// there while raising TOP_N to 8 would have published boards that were short of
// rows and said so only in a warning. 40 gives the 16 rows a comfortable margin.
export const MCAP_MAX_LOOKUPS = parseInt(process.env.MOVERS_MCAP_MAX_LOOKUPS ?? '40', 10);

// --- RSI candles ---
// Candle = fixed block-count window. 667 blocks ≈ 5 min at ~0.45s/block — the same
// candle duration as the Ethereum build's 25 blocks, which is what matters, since
// RSI-14 is then 14 five-minute candles either way.
export const BLOCKS_PER_CANDLE = parseInt(process.env.BLOCKS_PER_CANDLE ?? '667', 10);
// Volume floor gating RSI DISPLAY only (0 = disabled). Compared against the row's
// window volume in ANCHOR base units (18 decimals), not USD — it is applied before
// the USD conversion, alongside the raw aggregate.
export const RSI_MIN_VOLUME_ANCHOR = BigInt(process.env.MOVERS_RSI_MIN_VOLUME_ANCHOR ?? '0');

// --- Event topic0 hashes ---
// Both recomputed from their signatures and confirmed against live logs.
//
// NEITHER MATCHES ITS UNISWAP COUNTERPART — this is the one thing that cannot be
// carried over by renaming an address. PancakeSwap v3 adds protocolFeesToken0/1 to
// the Swap event and Infinity adds protocolFee, so the signatures — and therefore
// the hashes — differ. The DECODERS are unaffected: the extra fields are appended,
// so the leading words keep their meaning and wordAt reads them positionally.
//
// Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)
export const V3_SWAP_TOPIC0 =
  '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83';
// Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24,uint16)
export const CL_SWAP_TOPIC0 =
  '0x04206ad2b7c0f463bff3dd4f33c5735b0f2957a351e4f79763a4fa9e775dd237';

// --- eth_call 4-byte selectors ---
export const SEL_SLOT0 = '0x3850c7bd'; // slot0()
export const SEL_SYMBOL = '0x95d89b41'; // symbol()
export const SEL_TOKEN0 = '0x0dfe1681'; // token0()
export const SEL_TOKEN1 = '0xd21220a7'; // token1()
export const SEL_FEE = '0xddca3f43'; // fee()
export const SEL_GET_POOL = '0x1698ee82'; // getPool(address,address,uint24)
export const SEL_TOTAL_SUPPLY = '0x18160ddd'; // totalSupply()
export const SEL_DECIMALS = '0x313ce567'; // decimals()
// poolIdToPoolKey(bytes32) on the CLPoolManager. Note bytes32, not Uniswap v4's
// bytes25 — Infinity stores the key against the FULL PoolId, so the id is passed
// through unmodified and the bytes25 left-alignment dance is not needed here.
export const SEL_POOL_ID_TO_KEY = '0x0e2d484a';

// --- Contract verification + source scan ---
//
// There is NO Blockscout instance for BSC — bsc.blockscout.com, bscscan.blockscout.com,
// binance.blockscout.com and bnb.blockscout.com all 404 — so unlike the Ethereum
// build this cannot be a Blockscout URL swap. Two sources are used instead, tried in
// order by audit.ts.
//
// SOURCIFY IS THE KEYLESS DEFAULT, which is what keeps the badges working out of the
// box. Measured against 60 real board tokens on 2026-08-15 it answered for 48 — 80% —
// and its payload is a flat `{file: {content}}` map, simpler than Etherscan's blob.
// An unverified address is a clean 404. Other keyless options were checked and
// rejected: Routescan answers `"chain not supported"` for BSC, and anyabi.xyz returns
// only an ABI, which a SOURCE scan cannot use.
export const SOURCIFY_API = (
  process.env.BSC_SOURCIFY_API ?? 'https://sourcify.dev/server'
).replace(/\/$/, '');

// Etherscan's V2 multichain endpoint, used to cover the addresses Sourcify does not
// have. BscScan's own V1 is retired and answers every request with "You are using a
// deprecated V1 endpoint". OPTIONAL: it needs a free key from etherscan.io/apis, and
// with no key configured this source is simply skipped.
export const EXPLORER_API = (
  process.env.BSC_EXPLORER_API ?? 'https://api.etherscan.io/v2/api'
).replace(/\/$/, '');
export const EXPLORER_CHAIN_ID = process.env.BSC_EXPLORER_CHAIN_ID ?? '56';
export const EXPLORER_API_KEY = process.env.BSC_EXPLORER_API_KEY ?? '';

// Human-facing explorer, used for the token links in Telegram messages.
export const EXPLORER_BASE = (process.env.BSC_EXPLORER_BASE ?? 'https://bscscan.com').replace(
  /\/$/,
  ''
);
// Set MOVERS_AUDIT_ENABLED=0 to skip verification/audit lookups entirely. This no
// longer depends on an API key being present, because Sourcify does not need one.
export const AUDIT_ENABLED = process.env.MOVERS_AUDIT_ENABLED !== '0';
