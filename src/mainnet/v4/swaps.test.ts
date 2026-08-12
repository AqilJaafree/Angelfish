import { describe, it, expect } from 'vitest';
import { aggregateV4Swaps, rankV4TopN, V4PoolAggregate } from './swaps';
import { DecodedV4Swap } from './decode';
import { V4PoolMeta } from './metadata';

const ID = '0xpoolid';
const TOKEN = '0xtoken';
const meta = (ethIsCurrency0: boolean): Map<string, V4PoolMeta> =>
  new Map([[ID, { poolId: ID, token: TOKEN, ethIsCurrency0, fee: 3000 }]]);

const swap = (a0: bigint, a1: bigint, fee: bigint, sender = '0xs'): DecodedV4Swap => ({
  poolId: ID,
  sender,
  amount0: a0,
  amount1: a1,
  sqrtPriceX96: 1n,
  fee,
});

describe('aggregateV4Swaps', () => {
  it('values fees from the per-swap event fee, not a pool tier', () => {
    const agg = aggregateV4Swaps([{ poolId: ID, swap: swap(1_000_000n, -5n, 500n) }], meta(true));
    expect(agg.get(ID)!.feesEth).toBe(500n); // 1e6 * 500/1e6
  });

  // A dynamic-fee pool resolves its real rate per swap; the flag itself must never
  // be treated as a rate, or an 838% fee would be reported.
  it('ignores a fee word that is the dynamic flag rather than a rate', () => {
    const agg = aggregateV4Swaps(
      [{ poolId: ID, swap: swap(1_000_000n, -5n, BigInt(0x800000)) }],
      meta(true)
    );
    expect(agg.get(ID)!.feesEth).toBe(0n);
    expect(agg.get(ID)!.volumeEth).toBe(1_000_000n); // volume still counts
  });

  it('sums the absolute ETH leg regardless of swap direction', () => {
    const agg = aggregateV4Swaps(
      [
        { poolId: ID, swap: swap(100n, -50n, 0n) },
        { poolId: ID, swap: swap(-30n, 20n, 0n) },
      ],
      meta(true)
    );
    expect(agg.get(ID)!.volumeEth).toBe(130n);
  });

  it('counts unique senders — v4 has no separate recipient field', () => {
    const agg = aggregateV4Swaps(
      [
        { poolId: ID, swap: swap(1n, -1n, 0n, '0xa') },
        { poolId: ID, swap: swap(1n, -1n, 0n, '0xa') },
        { poolId: ID, swap: swap(1n, -1n, 0n, '0xb') },
      ],
      meta(true)
    );
    expect(agg.get(ID)!.traders.size).toBe(2);
  });

  it('reads the ETH leg from amount1 when ETH is currency1', () => {
    const agg = aggregateV4Swaps([{ poolId: ID, swap: swap(999n, -7n, 0n) }], meta(false));
    expect(agg.get(ID)!.volumeEth).toBe(7n);
  });

  it('drops swaps for pools with no metadata', () => {
    expect(aggregateV4Swaps([{ poolId: '0xother', swap: swap(1n, 1n, 0n) }], meta(true)).size).toBe(
      0
    );
  });
});

describe('rankV4TopN', () => {
  it('sorts by volume descending', () => {
    const mk = (poolId: string, v: bigint): V4PoolAggregate => ({
      poolId,
      token: TOKEN,
      volumeEth: v,
      swaps: 1,
      traders: new Set(['0xa']),
      feesEth: 0n,
      lastSqrtPriceX96: 1n,
      lastBlock: 1,
    });
    const ranked = rankV4TopN(
      new Map([
        ['a', mk('a', 1n)],
        ['b', mk('b', 9n)],
      ]),
      5
    );
    expect(ranked.map((r) => r.poolId)).toEqual(['b', 'a']);
  });
});
