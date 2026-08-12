import { logger } from '../logger';
import { hasWords, wordAt } from './decode';
import { SEL_SLOT0, USDC_DECIMALS, USDC_WETH_POOL } from './config';

// Every market cap on the boards is priced through this single number, so it is
// read from the deepest on-chain source available rather than an external price
// API: the USDC/WETH 0.05% v3 pool, whose slot0 is one eth_call.
export const ETH_USD_TTL_MS = parseInt(process.env.MOVERS_ETH_USD_TTL_MS ?? '60000', 10);

export interface EthUsdState {
  rate?: number;
  at?: number;
}

export type Caller = (to: string, data: string) => Promise<string>;

// `wethIsToken0` describes the USDC/WETH pool's ordering. It is derived from the
// pool's own token0() by the caller rather than hardcoded, so pointing
// ETH_USDC_WETH_POOL at a different pool cannot silently invert the rate.
export async function resolveEthUsd(
  call: Caller,
  state: EthUsdState,
  now: number,
  wethIsToken0: boolean,
  pool: string = USDC_WETH_POOL
): Promise<number | undefined> {
  if (state.rate != null && now - (state.at ?? 0) < ETH_USD_TTL_MS) return state.rate;
  try {
    const raw = await call(pool, SEL_SLOT0);
    if (!hasWords(raw, 1)) return undefined;
    const sqrtPriceX96 = wordAt(raw, 0);
    if (sqrtPriceX96 <= 0n) return undefined;
    const ratio = (Number(sqrtPriceX96) / 2 ** 96) ** 2; // token1/token0, raw
    // USDC per WETH, corrected for the 18-vs-6 decimal gap.
    const rate = wethIsToken0
      ? ratio * 10 ** (18 - USDC_DECIMALS)
      : (1 / ratio) * 10 ** (18 - USDC_DECIMALS);
    if (!Number.isFinite(rate) || rate <= 0) return undefined;
    state.rate = rate;
    state.at = now;
    return rate;
  } catch (err) {
    // Caching nothing here matters: a stale rate would silently mis-price an
    // entire board, which is worse than showing no caps for one cycle.
    logger.warn({ err, pool }, 'movers: ETH/USD read failed');
    return undefined;
  }
}
