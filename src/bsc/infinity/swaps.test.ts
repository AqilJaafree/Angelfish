import { describe, it, expect } from 'vitest';
import { aggregateClSwaps, rankClTopN, ClPoolAggregate } from './swaps';
import { DecodedClSwap } from './decode';
import { ClPoolMeta } from './metadata';

const ID = '0xpoolid';
const TOKEN = '0xtoken';
const ANCHOR = '0xanchor';
const meta = (anchorIsCurrency0: boolean): Map<string, ClPoolMeta> =>
  new Map([
    [ID, { poolId: ID, token: TOKEN, anchor: ANCHOR, anchorKind: 'usd' as const, anchorIsCurrency0 }],
  ]);

const swap = (a0: bigint, a1: bigint, fee: bigint, sender = '0xs'): DecodedClSwap => ({
  poolId: ID,
  sender,
  amount0: a0,
  amount1: a1,
  sqrtPriceX96: 1n,
  fee,
});

describe('aggregateClSwaps', () => {
  it('values fees from the per-swap event fee, not a pool tier', () => {
    const agg = aggregateClSwaps([{ poolId: ID, swap: swap(1_000_000n, -5n, 500n) }], meta(true));
    expect(agg.get(ID)!.feesAnchor).toBe(500n); // 1e6 * 500/1e6
  });

  // A hook sets the rate per swap, and an implausible one must never be treated as
  // a real fee. A live sample contained swaps reporting 980,310 pips (98%) — under
  // the 1e6 ceiling the Ethereum build used, so that guard would have admitted it.
  it('ignores an implausibly large per-swap fee', () => {
    const agg = aggregateClSwaps(
      [{ poolId: ID, swap: swap(1_000_000n, -5n, 980_310n) }],
      meta(true)
    );
    expect(agg.get(ID)!.feesAnchor).toBe(0n);
    expect(agg.get(ID)!.volumeAnchor).toBe(1_000_000n); // volume still counts
  });

  it('sums the absolute anchor leg regardless of swap direction', () => {
    const agg = aggregateClSwaps(
      [
        { poolId: ID, swap: swap(100n, -50n, 0n) },
        { poolId: ID, swap: swap(-30n, 20n, 0n) },
      ],
      meta(true)
    );
    expect(agg.get(ID)!.volumeAnchor).toBe(130n);
  });

  it('counts unique senders — the CL Swap event has no separate recipient field', () => {
    const agg = aggregateClSwaps(
      [
        { poolId: ID, swap: swap(1n, -1n, 0n, '0xa') },
        { poolId: ID, swap: swap(1n, -1n, 0n, '0xa') },
        { poolId: ID, swap: swap(1n, -1n, 0n, '0xb') },
      ],
      meta(true)
    );
    expect(agg.get(ID)!.traders.size).toBe(2);
  });

  it('reads the anchor leg from amount1 when the anchor is currency1', () => {
    const agg = aggregateClSwaps([{ poolId: ID, swap: swap(999n, -7n, 0n) }], meta(false));
    expect(agg.get(ID)!.volumeAnchor).toBe(7n);
  });

  it('drops swaps for pools with no metadata', () => {
    expect(aggregateClSwaps([{ poolId: '0xother', swap: swap(1n, 1n, 0n) }], meta(true)).size).toBe(
      0
    );
  });
});

describe('rankClTopN', () => {
  it('sorts by volume descending', () => {
    const mk = (poolId: string, v: bigint): ClPoolAggregate => ({
      poolId,
      token: TOKEN,
      anchorKind: 'usd',
      volumeAnchor: v,
      swaps: 1,
      traders: new Set(['0xa']),
      feesAnchor: 0n,
      lastSqrtPriceX96: 1n,
      lastBlock: 1,
    });
    const ranked = rankClTopN(
      new Map([
        ['a', mk('a', 1n)],
        ['b', mk('b', 9n)],
      ]),
      5
    );
    expect(ranked.map((r: { poolId: string }) => r.poolId)).toEqual(['b', 'a']);
  });
});
