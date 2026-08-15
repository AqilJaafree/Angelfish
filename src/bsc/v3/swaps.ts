import { DecodedSwap } from '../decode';
import { AnchorKind } from '../anchors';

export interface PoolMeta {
  pool: string; // lowercase pool address
  token: string; // the non-anchor token address
  anchor: string; // which anchor currency this pool is quoted in
  anchorKind: AnchorKind; // 'usd' -> already USD; 'bnb' -> needs the BNB/USD rate
  fee: number; // fee tier in hundredths of a bip (e.g. 2500 = 0.25%)
  anchorIsToken0: boolean;
}

export interface PoolAggregate {
  pool: string;
  token: string;
  anchorKind: AnchorKind;
  volumeAnchor: bigint; // Σ |anchor-side amount| over the window, in anchor base units
  swaps: number;
  traders: Set<string>;
  fees0: bigint;
  fees1: bigint;
  lastSqrtPriceX96: bigint; // sqrtPriceX96 of the most recent swap in the window
  lastBlock: number; // block of the most recent swap in the window
}

export function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

export function aggregateSwaps(
  decoded: { pool: string; swap: DecodedSwap; block?: number }[],
  metaByPool: Map<string, PoolMeta>
): Map<string, PoolAggregate> {
  const out = new Map<string, PoolAggregate>();
  for (const { pool, swap, block } of decoded) {
    const meta = metaByPool.get(pool);
    if (!meta) continue; // not a verified anchor pool — skipped
    let agg = out.get(pool);
    if (!agg) {
      agg = {
        pool,
        token: meta.token,
        anchorKind: meta.anchorKind,
        volumeAnchor: 0n,
        swaps: 0,
        traders: new Set<string>(),
        fees0: 0n,
        fees1: 0n,
        lastSqrtPriceX96: 0n,
        lastBlock: 0,
      };
      out.set(pool, agg);
    }
    const anchorAmt = meta.anchorIsToken0 ? swap.amount0 : swap.amount1;
    agg.volumeAnchor += abs(anchorAmt);
    agg.swaps += 1;
    agg.traders.add(swap.recipient);
    agg.lastSqrtPriceX96 = swap.sqrtPriceX96; // last swap in block/log order wins
    agg.lastBlock = block ?? 0;
    const feePips = BigInt(meta.fee);
    // Fee is taken from the input (positive) side of the swap.
    if (swap.amount0 > 0n) agg.fees0 += (swap.amount0 * feePips) / 1_000_000n;
    if (swap.amount1 > 0n) agg.fees1 += (swap.amount1 * feePips) / 1_000_000n;
  }
  return out;
}

const Q192 = 1n << 192n;

// Value both fee sides in the pool's ANCHOR units using its spot price
// (sqrtPriceX96). price = (sqrtP/2^96)^2 = token1/token0 in raw base units.
export function feesToAnchor(
  fees0: bigint,
  fees1: bigint,
  sqrtPriceX96: bigint,
  anchorIsToken0: boolean
): bigint {
  const p2 = sqrtPriceX96 * sqrtPriceX96;
  if (anchorIsToken0) {
    // anchor = token0. token1 fees valued as fees1 / price = fees1 * 2^192 / p2.
    const fromToken1 = p2 === 0n ? 0n : (fees1 * Q192) / p2;
    return fees0 + fromToken1;
  }
  // anchor = token1. token0 fees valued as fees0 * price = fees0 * p2 / 2^192.
  const fromToken0 = (fees0 * p2) / Q192;
  return fees1 + fromToken0;
}

export interface RankedPool {
  pool: string;
  token: string;
  anchorKind: AnchorKind;
  volumeAnchor: bigint;
  swaps: number;
  traders: number;
  fees0: bigint;
  fees1: bigint;
}

export function rankTopN(
  aggregates: Map<string, PoolAggregate>,
  topN: number
): RankedPool[] {
  return [...aggregates.values()]
    .map((a) => ({
      pool: a.pool,
      token: a.token,
      anchorKind: a.anchorKind,
      volumeAnchor: a.volumeAnchor,
      swaps: a.swaps,
      traders: a.traders.size,
      fees0: a.fees0,
      fees1: a.fees1,
    }))
    .sort((x, y) =>
      y.volumeAnchor > x.volumeAnchor ? 1 : y.volumeAnchor < x.volumeAnchor ? -1 : 0
    )
    .slice(0, topN);
}
