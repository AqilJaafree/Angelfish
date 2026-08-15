import { logger } from '../logger';
import { hasWords, wordAt } from './decode';
import { SEL_SLOT0, WBNB_USDT_POOL } from './config';

// BNB/USD, read from the deepest on-chain source rather than an external price API:
// the PancakeSwap v3 WBNB/USDT 0.01% pool, whose slot0 is one eth_call.
//
// This matters LESS here than the ETH/USD anchor did on Ethereum, and deliberately
// so. There, every market cap on both boards was priced through this one number.
// Here only the BNB-anchored pools need it — the 139-of-264 v3 pools quoted in USD
// stables are priced directly, because a BSC stable is 18 decimals and its pool
// price is already a USD price. So a failed read costs part of a board, not all of it.
export const BNB_USD_TTL_MS = parseInt(process.env.MOVERS_BNB_USD_TTL_MS ?? '60000', 10);

export interface BnbUsdState {
  rate?: number;
  at?: number;
}

export type Caller = (to: string, data: string) => Promise<string>;

// `wbnbIsToken0` describes the WBNB/USDT pool's ordering. It is derived from the
// pool's own token0() by the caller rather than hardcoded, so pointing
// BSC_WBNB_USDT_POOL at a different pool cannot silently invert the rate.
//
// No decimal correction appears below, unlike the Ethereum build's 18-vs-6 WETH/USDC
// gap: WBNB and USDT are BOTH 18 decimals, so the raw pool ratio is already the
// human rate.
export async function resolveBnbUsd(
  call: Caller,
  state: BnbUsdState,
  now: number,
  wbnbIsToken0: boolean,
  pool: string = WBNB_USDT_POOL
): Promise<number | undefined> {
  if (state.rate != null && now - (state.at ?? 0) < BNB_USD_TTL_MS) return state.rate;
  try {
    const raw = await call(pool, SEL_SLOT0);
    if (!hasWords(raw, 1)) return undefined;
    const sqrtPriceX96 = wordAt(raw, 0);
    if (sqrtPriceX96 <= 0n) return undefined;
    const ratio = (Number(sqrtPriceX96) / 2 ** 96) ** 2; // token1/token0, raw
    // USDT per WBNB.
    const rate = wbnbIsToken0 ? ratio : 1 / ratio;
    if (!Number.isFinite(rate) || rate <= 0) return undefined;
    state.rate = rate;
    state.at = now;
    return rate;
  } catch (err) {
    // Caching nothing here matters: a stale rate would silently mis-price every
    // BNB-anchored row, which is worse than showing no caps for one cycle.
    logger.warn({ err, pool }, 'movers: BNB/USD read failed');
    return undefined;
  }
}
