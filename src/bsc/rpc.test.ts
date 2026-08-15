import { describe, it, expect } from 'vitest';
import { chunkRange, isRetryableHttp, isSplittableError } from './rpc';

describe('chunkRange', () => {
  it('covers every block exactly once with no gaps or overlaps', () => {
    const chunks = chunkRange(100, 137, 10);
    expect(chunks[0]).toEqual({ fromBlock: 100, toBlock: 109 });
    expect(chunks.at(-1)).toEqual({ fromBlock: 130, toBlock: 137 });
    const seen = chunks.flatMap((c) => {
      const out: number[] = [];
      for (let b = c.fromBlock; b <= c.toBlock; b++) out.push(b);
      return out;
    });
    expect(seen).toEqual(Array.from({ length: 38 }, (_, i) => 100 + i));
  });

  it('returns a single window when the range fits', () => {
    expect(chunkRange(50, 55, 10)).toEqual([{ fromBlock: 50, toBlock: 55 }]);
  });

  it('handles a single-block range', () => {
    expect(chunkRange(7, 7, 10)).toEqual([{ fromBlock: 7, toBlock: 7 }]);
  });

  it('never produces a zero-width step even if size is bogus', () => {
    expect(chunkRange(1, 3, 0)).toEqual([
      { fromBlock: 1, toBlock: 1 },
      { fromBlock: 2, toBlock: 2 },
      { fromBlock: 3, toBlock: 3 },
    ]);
  });
});

describe('isSplittableError', () => {
  // The exact strings free BSC endpoints answer with, kept verbatim.
  it('matches the range-cap messages free BSC endpoints actually return', () => {
    expect(isSplittableError('log query range must not exceed 25 blocks')).toBe(true);
    expect(isSplittableError('eth_getLogs is limited to 0 - 50 blocks range')).toBe(true);
    expect(isSplittableError('limit exceeded')).toBe(true);
  });

  it('matches result-count caps, which proactive chunking cannot predict', () => {
    expect(isSplittableError('query returned more than 10000 results')).toBe(true);
    expect(isSplittableError('response size exceeded')).toBe(true);
  });

  it('does not match unrelated failures', () => {
    expect(isSplittableError('execution reverted')).toBe(false);
    expect(isSplittableError('method not found')).toBe(false);
  });
});

describe('isRetryableHttp', () => {
  it('retries only rate-limit and unavailable', () => {
    expect(isRetryableHttp(429)).toBe(true);
    expect(isRetryableHttp(503)).toBe(true);
    expect(isRetryableHttp(400)).toBe(false);
    expect(isRetryableHttp(200)).toBe(false);
  });
});
