// Ethereum mainnet Uniswap v3 constants for the LP bot. Mainnet only, by design:
// the bot signs transactions, so the chain is pinned rather than parameterised.
export const CHAIN_ID = '1';

// NonfungiblePositionManager — mint/increase/decrease/collect all live here.
export const POSITION_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
export const V3_FACTORY = '0x1f98431c8ad98523631ae4a59f267346ea31f984';

// Fee tier -> tickSpacing. A tick range MUST be a multiple of the pool's spacing
// or mint reverts, so this table is load-bearing rather than informational.
export const TICK_SPACING: Record<number, number> = {
  100: 1,
  500: 10,
  3000: 60,
  10000: 200,
};

// Symbol aliases accepted in commands, so `/lp USDC WETH 500 …` works without
// pasting addresses. An address is always accepted too and always wins.
export const TOKENS: Record<string, { address: string; decimals: number }> = {
  WETH: { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', decimals: 18 },
  USDC: { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 },
  USDT: { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6 },
  DAI: { address: '0x6b175474e89094c44da98b954eedeac495271d0f', decimals: 18 },
  WBTC: { address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', decimals: 8 },
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
