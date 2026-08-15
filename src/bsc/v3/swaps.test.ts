import { describe, it, expect } from 'vitest';
import { aggregateSwaps, feesToAnchor, rankTopN, PoolMeta, PoolAggregate } from './swaps';
import { DecodedSwap } from '../decode';

const POOL = '0xpool';
const TOKEN = '0xtoken';
const ANCHOR = '0xanchor';
const meta = (anchorIsToken0: boolean, fee = 2500): Map<string, PoolMeta> =>
  new Map([
    [POOL, { pool: POOL, token: TOKEN, anchor: ANCHOR, anchorKind: 'usd' as const, fee, anchorIsToken0 }],
  ]);

const swap = (a0: bigint, a1: bigint, recipient = '0xr', sqrt = 1n): DecodedSwap => ({
  sender: '0xs',
  recipient,
  amount0: a0,
  amount1: a1,
  sqrtPriceX96: sqrt,
});

describe('aggregateSwaps', () => {
  it('sums the absolute anchor leg regardless of direction', () => {
    const agg = aggregateSwaps(
      [
        { pool: POOL, swap: swap(100n, -50n) }, // anchor in
        { pool: POOL, swap: swap(-30n, 20n) }, // anchor out
      ],
      meta(true)
    );
    expect(agg.get(POOL)!.volumeAnchor).toBe(130n);
    expect(agg.get(POOL)!.swaps).toBe(2);
  });

  it('counts unique traders, not swaps', () => {
    const agg = aggregateSwaps(
      [
        { pool: POOL, swap: swap(10n, -1n, '0xa') },
        { pool: POOL, swap: swap(10n, -1n, '0xa') },
        { pool: POOL, swap: swap(10n, -1n, '0xb') },
      ],
      meta(true)
    );
    expect(agg.get(POOL)!.traders.size).toBe(2);
    expect(agg.get(POOL)!.swaps).toBe(3);
  });

  it('takes the fee from the positive (input) side only', () => {
    const agg = aggregateSwaps([{ pool: POOL, swap: swap(1_000_000n, -500n) }], meta(true));
    expect(agg.get(POOL)!.fees0).toBe(2500n); // 1e6 * 2500/1e6
    expect(agg.get(POOL)!.fees1).toBe(0n);
  });

  it('drops swaps from pools with no metadata (forks / unanchored)', () => {
    expect(aggregateSwaps([{ pool: '0xunknown', swap: swap(1n, 1n) }], meta(true)).size).toBe(0);
  });

  it('keeps the last swap in log order as the price and block', () => {
    const agg = aggregateSwaps(
      [
        { pool: POOL, swap: swap(1n, -1n, '0xa', 111n), block: 5 },
        { pool: POOL, swap: swap(1n, -1n, '0xa', 222n), block: 9 },
      ],
      meta(true)
    );
    expect(agg.get(POOL)!.lastSqrtPriceX96).toBe(222n);
    expect(agg.get(POOL)!.lastBlock).toBe(9);
  });

  it('reads the anchor leg from amount1 when the anchor is token1', () => {
    const agg = aggregateSwaps([{ pool: POOL, swap: swap(999n, -7n) }], meta(false));
    expect(agg.get(POOL)!.volumeAnchor).toBe(7n);
  });
});

describe('feesToAnchor', () => {
  const Q96 = 1n << 96n; // sqrtPriceX96 for price = 1

  it('is a plain sum when the pool price is 1', () => {
    expect(feesToAnchor(10n, 20n, Q96, true)).toBe(30n);
    expect(feesToAnchor(10n, 20n, Q96, false)).toBe(30n);
  });

  it('does not divide by zero on an uninitialized price', () => {
    expect(feesToAnchor(10n, 20n, 0n, true)).toBe(10n);
  });

  it('converts the token side at the pool price', () => {
    const sqrt = Q96 * 2n; // price = 4 (token1 per token0)
    // anchor = token0: 20 token1 is worth 20/4 = 5 anchor.
    expect(feesToAnchor(10n, 20n, sqrt, true)).toBe(15n);
    // anchor = token1: 10 token0 is worth 10*4 = 40 anchor.
    expect(feesToAnchor(10n, 20n, sqrt, false)).toBe(60n);
  });
});

describe('rankTopN', () => {
  it('sorts by volume descending and truncates', () => {
    const mk = (pool: string, v: bigint): PoolAggregate => ({
      pool,
      token: TOKEN,
      anchorKind: 'usd',
      volumeAnchor: v,
      swaps: 1,
      traders: new Set(['0xa']),
      fees0: 0n,
      fees1: 0n,
      lastSqrtPriceX96: 1n,
      lastBlock: 1,
    });
    const ranked = rankTopN(
      new Map([
        ['a', mk('a', 5n)],
        ['b', mk('b', 50n)],
        ['c', mk('c', 500n)],
      ]),
      2
    );
    expect(ranked.map((r) => r.pool)).toEqual(['c', 'b']);
  });
});
