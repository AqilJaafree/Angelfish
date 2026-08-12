import { describe, it, expect } from 'vitest';
import {
  baselineRate,
  MAX_HISTORY_BUCKETS,
  MAX_SPIKE,
  MIN_BASELINE_BUCKETS,
  MIN_SPIKE_VOLUME_WEI,
  recordVolume,
  sortBySpike,
  spikeScore,
  VolumeState,
} from './volume-history';

const ETH = (n: number): bigint => BigInt(Math.round(n * 1e18));
const BUCKET_BLOCKS = 25;

// Build a pool with `n` finalized buckets each carrying `perBucket` ETH.
function warmed(n: number, perBucket: number): VolumeState {
  return {
    bucket: n,
    volume: '0',
    blocks: 0,
    history: Array.from({ length: n }, () => ({
      volume: ETH(perBucket).toString(),
      blocks: BUCKET_BLOCKS,
    })),
  };
}

describe('recordVolume', () => {
  it('accumulates within a bucket rather than overwriting', () => {
    const store: Record<string, VolumeState> = {};
    recordVolume(store, 'p', 10, ETH(1), 10, BUCKET_BLOCKS);
    recordVolume(store, 'p', 10, ETH(2), 10, BUCKET_BLOCKS);
    expect(BigInt(store.p.volume)).toBe(ETH(3));
    expect(store.p.blocks).toBe(20);
  });

  it('finalizes the previous bucket when the bucket advances', () => {
    const store: Record<string, VolumeState> = {};
    recordVolume(store, 'p', 10, ETH(5), 25, BUCKET_BLOCKS);
    recordVolume(store, 'p', 11, ETH(1), 10, BUCKET_BLOCKS);
    expect(store.p.history).toEqual([{ volume: ETH(5).toString(), blocks: 25 }]);
    expect(BigInt(store.p.volume)).toBe(ETH(1));
  });

  // The opposite of the candles, which forward-fill the last price. A pool that
  // did not trade genuinely had no volume, and dropping those buckets would
  // compute the baseline only over buckets where it happened to trade —
  // overstating exactly the quiet pools whose activity is worth surfacing.
  it('zero-fills skipped buckets instead of ignoring them', () => {
    const store: Record<string, VolumeState> = {};
    recordVolume(store, 'p', 10, ETH(5), 25, BUCKET_BLOCKS);
    recordVolume(store, 'p', 14, ETH(1), 10, BUCKET_BLOCKS);
    expect(store.p.history).toHaveLength(4);
    expect(store.p.history.slice(1).every((b) => b.volume === '0')).toBe(true);
    expect(store.p.history.slice(1).every((b) => b.blocks === BUCKET_BLOCKS)).toBe(true);
  });

  it('ignores an out-of-order (reorg) sample', () => {
    const store: Record<string, VolumeState> = {};
    recordVolume(store, 'p', 10, ETH(5), 25, BUCKET_BLOCKS);
    recordVolume(store, 'p', 9, ETH(99), 25, BUCKET_BLOCKS);
    expect(BigInt(store.p.volume)).toBe(ETH(5));
  });

  it('caps history, including across a long gap', () => {
    const store: Record<string, VolumeState> = {};
    recordVolume(store, 'p', 0, ETH(1), 25, BUCKET_BLOCKS);
    recordVolume(store, 'p', 10_000, ETH(1), 25, BUCKET_BLOCKS);
    expect(store.p.history.length).toBeLessThanOrEqual(MAX_HISTORY_BUCKETS);
  });
});

describe('baselineRate', () => {
  it('is undefined until there is enough history to mean anything', () => {
    expect(baselineRate(undefined)).toBeUndefined();
    expect(baselineRate(warmed(MIN_BASELINE_BUCKETS - 1, 1))).toBeUndefined();
    expect(baselineRate(warmed(MIN_BASELINE_BUCKETS, 1))).toBeDefined();
  });

  // A RATE, not a per-bucket total: windows are 10 blocks in steady state and
  // 300 on a cold start, so totals would mostly measure window size.
  it('is per-block, so unequal bucket sizes do not skew it', () => {
    const state: VolumeState = {
      bucket: 9,
      volume: '0',
      blocks: 0,
      history: [
        { volume: ETH(10).toString(), blocks: 10 }, // 1 ETH/block
        { volume: ETH(20).toString(), blocks: 20 }, // 1 ETH/block
        { volume: ETH(70).toString(), blocks: 70 }, // 1 ETH/block
      ],
    };
    expect(baselineRate(state)! / 1e18).toBeCloseTo(1, 6);
  });
});

describe('spikeScore', () => {
  it('scores a pool trading well above its own baseline', () => {
    // baseline 1 ETH per 25 blocks; now 8 ETH in 10 blocks.
    const score = spikeScore(warmed(5, 1), ETH(8), 10);
    expect(score).toBeCloseTo(20, 0);
  });

  // The whole point: the biggest pool is the biggest pool every window, so on
  // absolute volume it always wins. On its own baseline it is flat.
  it('gives a steady high-volume pool a score near 1', () => {
    const score = spikeScore(warmed(6, 250), ETH(100), 10);
    expect(score).toBeCloseTo(1, 1);
  });

  it('is undefined while the pool is still warming up', () => {
    expect(spikeScore(warmed(1, 1), ETH(5), 10)).toBeUndefined();
    expect(spikeScore(undefined, ETH(5), 10)).toBeUndefined();
  });

  // Without a floor, a pool that normally trades dust tops the board on a 400x
  // multiple of nothing — arithmetically right, worthless as a row.
  it('refuses to score a window below the volume floor', () => {
    const tiny = MIN_SPIKE_VOLUME_WEI - 1n;
    expect(spikeScore(warmed(5, 0.0001), tiny, 10)).toBeUndefined();
  });

  it('treats a genuinely zero baseline as the strongest spike, not an error', () => {
    const idle = warmed(5, 0);
    expect(spikeScore(idle, ETH(5), 10)).toBe(MAX_SPIKE);
  });

  it('clamps rather than returning Infinity', () => {
    const score = spikeScore(warmed(5, 1e-9), ETH(1000), 1);
    expect(Number.isFinite(score!)).toBe(true);
    expect(score).toBeLessThanOrEqual(MAX_SPIKE);
  });
});

describe('sortBySpike', () => {
  const vol = (r: { v: number }): bigint => ETH(r.v);

  it('ranks by spike, not by volume', () => {
    const rows = [
      { id: 'whale', v: 500, s: 1.1 },
      { id: 'mover', v: 2, s: 30 },
      { id: 'mid', v: 50, s: 4 },
    ];
    const out = sortBySpike(rows, (r) => r.s, vol);
    expect(out.map((r) => r.id)).toEqual(['mover', 'mid', 'whale']);
  });

  // Inventing a score for an unscored row would either bury every new pool or
  // let it jump the queue; the two tiers avoid asserting anything untrue.
  it('puts unscored pools behind every scored one, ordered by volume', () => {
    const rows = [
      { id: 'cold-big', v: 100, s: undefined as number | undefined },
      { id: 'scored-small', v: 1, s: 2 },
      { id: 'cold-small', v: 5, s: undefined as number | undefined },
    ];
    const out = sortBySpike(rows, (r) => r.s, vol);
    expect(out.map((r) => r.id)).toEqual(['scored-small', 'cold-big', 'cold-small']);
  });

  it('attaches the score to the row it came from', () => {
    const out = sortBySpike([{ id: 'a', v: 1, s: 7.5 }], (r) => r.s, vol);
    expect(out[0].spike).toBe(7.5);
  });

  it('handles an all-unscored board (the warm-up case) without reordering chaos', () => {
    const rows = [
      { id: 'a', v: 1, s: undefined as number | undefined },
      { id: 'b', v: 9, s: undefined as number | undefined },
    ];
    expect(sortBySpike(rows, (r) => r.s, vol).map((r) => r.id)).toEqual(['b', 'a']);
  });
});
