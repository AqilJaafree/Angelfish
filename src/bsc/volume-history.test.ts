import { describe, it, expect } from 'vitest';
import {
  baselineRate,
  MAX_HISTORY_BUCKETS,
  MAX_SPIKE,
  MIN_BASELINE_BUCKETS,
  MIN_SPIKE_VOLUME_USD,
  recordVolume,
  sortBySpike,
  sortBySwaps,
  spikeScore,
  VolumeState,
} from './volume-history';

// 18-decimal fixed point, standing in for both anchor units and USD — every BSC
// anchor is 18 decimals, so the two share a scale.
const UNITS = (n: number): bigint => BigInt(Math.round(n * 1e18));
const BUCKET_BLOCKS = 25;

// Build a pool with `n` finalized buckets each carrying `perBucket` anchor units.
function warmed(n: number, perBucket: number): VolumeState {
  return {
    bucket: n,
    volume: '0',
    blocks: 0,
    history: Array.from({ length: n }, () => ({
      volume: UNITS(perBucket).toString(),
      blocks: BUCKET_BLOCKS,
    })),
  };
}

describe('recordVolume', () => {
  it('accumulates within a bucket rather than overwriting', () => {
    const store: Record<string, VolumeState> = {};
    recordVolume(store, 'p', 10, UNITS(1), 10, BUCKET_BLOCKS);
    recordVolume(store, 'p', 10, UNITS(2), 10, BUCKET_BLOCKS);
    expect(BigInt(store.p.volume)).toBe(UNITS(3));
    expect(store.p.blocks).toBe(20);
  });

  it('finalizes the previous bucket when the bucket advances', () => {
    const store: Record<string, VolumeState> = {};
    recordVolume(store, 'p', 10, UNITS(5), 25, BUCKET_BLOCKS);
    recordVolume(store, 'p', 11, UNITS(1), 10, BUCKET_BLOCKS);
    expect(store.p.history).toEqual([{ volume: UNITS(5).toString(), blocks: 25 }]);
    expect(BigInt(store.p.volume)).toBe(UNITS(1));
  });

  // The opposite of the candles, which forward-fill the last price. A pool that
  // did not trade genuinely had no volume, and dropping those buckets would
  // compute the baseline only over buckets where it happened to trade —
  // overstating exactly the quiet pools whose activity is worth surfacing.
  it('zero-fills skipped buckets instead of ignoring them', () => {
    const store: Record<string, VolumeState> = {};
    recordVolume(store, 'p', 10, UNITS(5), 25, BUCKET_BLOCKS);
    recordVolume(store, 'p', 14, UNITS(1), 10, BUCKET_BLOCKS);
    expect(store.p.history).toHaveLength(4);
    expect(store.p.history.slice(1).every((b) => b.volume === '0')).toBe(true);
    expect(store.p.history.slice(1).every((b) => b.blocks === BUCKET_BLOCKS)).toBe(true);
  });

  it('ignores an out-of-order (reorg) sample', () => {
    const store: Record<string, VolumeState> = {};
    recordVolume(store, 'p', 10, UNITS(5), 25, BUCKET_BLOCKS);
    recordVolume(store, 'p', 9, UNITS(99), 25, BUCKET_BLOCKS);
    expect(BigInt(store.p.volume)).toBe(UNITS(5));
  });

  it('caps history, including across a long gap', () => {
    const store: Record<string, VolumeState> = {};
    recordVolume(store, 'p', 0, UNITS(1), 25, BUCKET_BLOCKS);
    recordVolume(store, 'p', 10_000, UNITS(1), 25, BUCKET_BLOCKS);
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
        { volume: UNITS(10).toString(), blocks: 10 }, // 1 ETH/block
        { volume: UNITS(20).toString(), blocks: 20 }, // 1 ETH/block
        { volume: UNITS(70).toString(), blocks: 70 }, // 1 ETH/block
      ],
    };
    expect(baselineRate(state)! / 1e18).toBeCloseTo(1, 6);
  });
});

describe('spikeScore', () => {
  it('scores a pool trading well above its own baseline', () => {
    // baseline 100 per 25 blocks; now 800 in 10 blocks. Scaled well clear of the
    // USD floor, which is a real gate now that it is denominated in dollars.
    const score = spikeScore(warmed(5, 100), UNITS(800), 10);
    expect(score).toBeCloseTo(20, 0);
  });

  // The whole point: the biggest pool is the biggest pool every window, so on
  // absolute volume it always wins. On its own baseline it is flat.
  it('gives a steady high-volume pool a score near 1', () => {
    const score = spikeScore(warmed(6, 250), UNITS(100), 10);
    expect(score).toBeCloseTo(1, 1);
  });

  it('is undefined while the pool is still warming up', () => {
    expect(spikeScore(warmed(1, 100), UNITS(500), 10)).toBeUndefined();
    expect(spikeScore(undefined, UNITS(500), 10)).toBeUndefined();
  });

  // Without a floor, a pool that normally trades dust tops the board on a 400x
  // multiple of nothing — arithmetically right, worthless as a row.
  it('refuses to score a window below the volume floor', () => {
    const tiny = MIN_SPIKE_VOLUME_USD - 1n;
    expect(spikeScore(warmed(5, 0.0001), tiny, 10)).toBeUndefined();
  });

  it('treats a genuinely zero baseline as the strongest spike, not an error', () => {
    const idle = warmed(5, 0);
    expect(spikeScore(idle, UNITS(500), 10)).toBe(MAX_SPIKE);
  });

  it('clamps rather than returning Infinity', () => {
    const score = spikeScore(warmed(5, 1e-9), UNITS(1000), 1);
    expect(Number.isFinite(score!)).toBe(true);
    expect(score).toBeLessThanOrEqual(MAX_SPIKE);
  });
});

describe('sortBySwaps', () => {
  const vol = (r: { v: number }): bigint => UNITS(r.v);

  it('ranks by raw swap count, not by volume or spike', () => {
    const rows = [
      { id: 'whale', v: 500, n: 3 },
      { id: 'busy', v: 2, n: 74 },
      { id: 'mid', v: 50, n: 20 },
    ];
    expect(sortBySwaps(rows, (r) => r.n, vol).map((r) => r.id)).toEqual(['busy', 'mid', 'whale']);
  });

  // On a 300-block window the tail is mostly 1- and 2-swap pools, so ties are the
  // common case. Left unbroken, their order is whatever the sweep returned and
  // reshuffles every cycle for no reason.
  it('breaks ties on USD volume so the tail is stable', () => {
    const rows = [
      { id: 'tie-small', v: 1, n: 2 },
      { id: 'tie-big', v: 900, n: 2 },
      { id: 'tie-mid', v: 40, n: 2 },
    ];
    expect(sortBySwaps(rows, (r) => r.n, vol).map((r) => r.id)).toEqual([
      'tie-big',
      'tie-mid',
      'tie-small',
    ]);
  });

  // An unpriceable row is a BNB-quoted pool during a failed BNB/USD read. It must
  // not displace a merely small one by being treated as zero — or as huge.
  it('sorts an unpriceable volume last within a tie, never as zero', () => {
    const rows = [
      { id: 'unpriced', v: 0, n: 2 },
      { id: 'small', v: 1, n: 2 },
    ];
    const volMaybe = (r: { id: string; v: number }): bigint | undefined =>
      r.id === 'unpriced' ? undefined : UNITS(r.v);
    expect(sortBySwaps(rows, (r) => r.n, volMaybe).map((r) => r.id)).toEqual(['small', 'unpriced']);
  });

  // No warming-up tier, unlike sortBySpike: a pool is rankable on its first trade.
  it('ranks a brand-new pool on its first trade rather than parking it', () => {
    const rows = [
      { id: 'established', v: 500, n: 4 },
      { id: 'brand-new', v: 1, n: 9 },
    ];
    expect(sortBySwaps(rows, (r) => r.n, vol)[0].id).toBe('brand-new');
  });

  it('does not mutate the caller\'s array', () => {
    const rows = [
      { id: 'a', v: 1, n: 1 },
      { id: 'b', v: 1, n: 9 },
    ];
    sortBySwaps(rows, (r) => r.n, vol);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('sortBySpike', () => {
  const vol = (r: { v: number }): bigint => UNITS(r.v);

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
