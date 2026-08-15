import { describe, it, expect } from 'vitest';
import { recordSwapPrice, CandleState, MAX_CLOSES, MAX_TRACKED_POOLS } from './candles';

describe('recordSwapPrice', () => {
  it('starts a candle on the first sample', () => {
    const store: Record<string, CandleState> = {};
    recordSwapPrice(store, 'p', 10, 1.5);
    expect(store.p).toEqual({ bucket: 10, close: 1.5, closes: [] });
  });

  it('overwrites the forming close within the same bucket', () => {
    const store: Record<string, CandleState> = {};
    recordSwapPrice(store, 'p', 10, 1);
    recordSwapPrice(store, 'p', 10, 2);
    expect(store.p).toEqual({ bucket: 10, close: 2, closes: [] });
  });

  it('finalizes the previous candle when the bucket advances', () => {
    const store: Record<string, CandleState> = {};
    recordSwapPrice(store, 'p', 10, 1);
    recordSwapPrice(store, 'p', 11, 2);
    expect(store.p).toEqual({ bucket: 11, close: 2, closes: [1] });
  });

  // RSI needs contiguous periods, so a pool that did not trade for a while must
  // still contribute candles — otherwise its RSI silently spans a longer horizon.
  it('forward-fills tradeless buckets with the last close', () => {
    const store: Record<string, CandleState> = {};
    recordSwapPrice(store, 'p', 10, 1);
    recordSwapPrice(store, 'p', 14, 5);
    expect(store.p.closes).toEqual([1, 1, 1, 1]);
    expect(store.p.close).toBe(5);
  });

  it('ignores an out-of-order (reorg) sample', () => {
    const store: Record<string, CandleState> = {};
    recordSwapPrice(store, 'p', 10, 1);
    recordSwapPrice(store, 'p', 9, 99);
    expect(store.p).toEqual({ bucket: 10, close: 1, closes: [] });
  });

  it('caps the retained closes', () => {
    const store: Record<string, CandleState> = {};
    for (let b = 0; b < MAX_CLOSES + 20; b++) recordSwapPrice(store, 'p', b, b);
    expect(store.p.closes.length).toBeLessThanOrEqual(MAX_CLOSES);
  });

  it('caps the forward-fill too, so one long gap cannot blow the cap', () => {
    const store: Record<string, CandleState> = {};
    recordSwapPrice(store, 'p', 0, 1);
    recordSwapPrice(store, 'p', 10_000, 2);
    expect(store.p.closes.length).toBeLessThanOrEqual(MAX_CLOSES);
  });

  it('evicts the least-recently-updated pool past the LRU bound', () => {
    const store: Record<string, CandleState> = {};
    for (let i = 0; i < MAX_TRACKED_POOLS + 5; i++) recordSwapPrice(store, `p${i}`, 1, 1);
    expect(Object.keys(store)).toHaveLength(MAX_TRACKED_POOLS);
    expect(store.p0).toBeUndefined();
    expect(store[`p${MAX_TRACKED_POOLS + 4}`]).toBeDefined();
  });

  it('keeps a re-touched pool alive through eviction', () => {
    const store: Record<string, CandleState> = {};
    recordSwapPrice(store, 'keep', 1, 1);
    for (let i = 0; i < MAX_TRACKED_POOLS - 1; i++) recordSwapPrice(store, `p${i}`, 1, 1);
    recordSwapPrice(store, 'keep', 2, 1); // touch: moves to the end of insertion order
    for (let i = 0; i < 10; i++) recordSwapPrice(store, `q${i}`, 1, 1);
    expect(store.keep).toBeDefined();
  });
});
