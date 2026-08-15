// BNB Chain PancakeSwap v3 constants for the LP bot. One chain only, by design:
// the bot signs transactions, so the chain is pinned rather than parameterised.
export const CHAIN_ID = '56';

// NonfungiblePositionManager — mint/increase/decrease/collect all live here.
// Verified on-chain by its symbol(), which answers `PCS-V3-POS`.
export const POSITION_MANAGER = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364';
export const V3_FACTORY = '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865';

// Fee tier -> tickSpacing. A tick range MUST be a multiple of the pool's spacing
// or mint reverts, so this table is load-bearing rather than informational.
//
// PANCAKESWAP'S LADDER IS NOT UNISWAP'S. The 0.3%/60 tier does not exist here; its
// place is taken by 0.25%/50. Every pair was read back from a live pool's fee() and
// tickSpacing() on 2026-08-15 rather than assumed. Carrying Uniswap's table over
// would have made `3000` a silently unsupported tier and — worse — mis-spaced any
// range quoted against it.
export const TICK_SPACING: Record<number, number> = {
  100: 1,
  500: 10,
  2500: 50,
  10000: 200,
};

// Symbol aliases accepted in commands, so `/lp USDT WBNB 500 …` works without
// pasting addresses. An address is always accepted too and always wins.
//
// Note the decimals: on BSC the stablecoins are 18, not the 6 they are on Ethereum,
// and BTCB is 18 rather than WBTC's 8. toBaseUnits rejects an amount with more
// decimal places than the token has, so a stale 6 here would refuse valid amounts.
export const TOKENS: Record<string, { address: string; decimals: number }> = {
  WBNB: { address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', decimals: 18 },
  USDT: { address: '0x55d398326f99059ff775485246999027b3197955', decimals: 18 },
  USDC: { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18 },
  USD1: { address: '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d', decimals: 18 },
  BUSD: { address: '0xe9e7cea3dedca5984780bafc599bd69add087d56', decimals: 18 },
  BTCB: { address: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', decimals: 18 },
  ETH: { address: '0x2170ed0880ac9a755fd29b2688956bd959f933f8', decimals: 18 },
  CAKE: { address: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82', decimals: 18 },
};

// Only this Telegram user may command the bot. A NUMERIC id, never a username:
// usernames are mutable and can be released and re-registered by someone else,
// so gating fund movement on one would hand the wallet to whoever claims it next.
//
// Deliberately has NO default. The owner's identity is a secret of the
// deployment, not a constant of the code, so it lives only in the gitignored
// .env. Unset resolves to 0, which no real Telegram account can have, so an
// unconfigured bot refuses everyone rather than falling open.
export const OWNER_ID = Number(process.env.LP_OWNER_TELEGRAM_ID ?? 0);
// Optional. Cross-checked to raise a log warning, never trusted for
// authorisation. Unset simply disables that warning.
export const OWNER_USERNAME = process.env.LP_OWNER_USERNAME ?? '';

export const BOT_TOKEN = process.env.TELEGRAM_BOT ?? process.env.TELEGRAM_BOT_TOKEN;
export const KEEPERHUB_URL = process.env.KEEPERHUB_URL ?? 'https://app.keeperhub.com/mcp';
export const KEEPERHUB_API_KEY = process.env.KEEPERHUB_API_KEY;
// Also no default — the signing address belongs in the gitignored .env.
export const WALLET_ADDRESS = process.env.LP_WALLET_ADDRESS ?? '';

// How long a quoted plan stays confirmable. Short, because the quote embeds a
// tick range derived from a price that moves: confirming a stale plan would mint
// a range that no longer straddles the market.
export const CONFIRM_TTL_MS = Number(process.env.LP_CONFIRM_TTL_MS ?? 300_000);

// Default half-width of the position, in percent around the current price.
export const DEFAULT_RANGE_PCT = Number(process.env.LP_DEFAULT_RANGE_PCT ?? 10);

// Slippage floor applied to amountMin. Uniswap treats amountMin as the guarantee
// that the pool ratio has not moved against you between quote and inclusion.
export const DEFAULT_SLIPPAGE_PCT = Number(process.env.LP_SLIPPAGE_PCT ?? 1);

export const SEL = {
  slot0: '0x3850c7bd',
  getPool: '0x1698ee82',
  decimals: '0x313ce567',
  symbol: '0x95d89b41',
  balanceOf: '0x70a08231',
  allowance: '0xdd62ed3e',
};
