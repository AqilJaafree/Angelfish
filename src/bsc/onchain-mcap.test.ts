import { describe, it, expect } from 'vitest';
import { computeFdvUsd, fdvFromSeriesValue, resolveTokenMeta, SUPPLY_TTL_MS, TokenMeta } from './onchain-mcap';
import { SEL_TOTAL_SUPPLY, SEL_DECIMALS } from './config';
import { sequentialCallMany } from './rpc';

const word = (hex: string): string => '0x' + hex.replace(/^0x/, '').padStart(64, '0');
const TOKEN = '0xtoken';

describe('fdvFromSeriesValue', () => {
  it('prices a same-decimals token against ETH', () => {
    // 1M tokens at 0.001 ETH each, ETH = $2000 -> $2,000,000
    const fdv = fdvFromSeriesValue({
      seriesValue: 0.001,
      supply: 1_000_000n * 10n ** 18n,
      tokenDecimals: 18,
      anchorDecimals: 18,
      anchorUsd: 2000,
    });
    expect(fdv).toBeCloseTo(2_000_000, 0);
  });

  it('corrects for a decimal gap between the token and the anchor', () => {
    // A 6-decimal token worth 0.001 ETH: one whole token is 1e6 raw units and
    // 0.001 ETH is 1e15 raw wei, so the RAW ratio the pool reports is 1e9 —
    // 1e12x larger than the whole-unit price. That gap is what the correction
    // undoes; getting its sign wrong misprices the token by 1e24.
    const fdv = fdvFromSeriesValue({
      seriesValue: 0.001 * 10 ** 12,
      supply: 1_000_000n * 10n ** 6n,
      tokenDecimals: 6,
      anchorDecimals: 18,
      anchorUsd: 2000,
    });
    expect(fdv).toBeCloseTo(2_000_000, 0);
  });

  it('returns undefined rather than a garbage figure for degenerate inputs', () => {
    const base = { supply: 10n ** 18n, tokenDecimals: 18, anchorDecimals: 18, anchorUsd: 2000 };
    expect(fdvFromSeriesValue({ ...base, seriesValue: 0 })).toBeUndefined();
    expect(fdvFromSeriesValue({ ...base, seriesValue: Infinity })).toBeUndefined();
    expect(fdvFromSeriesValue({ ...base, supply: 0n, seriesValue: 1 })).toBeUndefined();
    expect(fdvFromSeriesValue({ ...base, anchorUsd: 0, seriesValue: 1 })).toBeUndefined();
  });
});

describe('computeFdvUsd', () => {
  it('returns undefined for an uninitialized pool price', () => {
    expect(
      computeFdvUsd({
        supply: 10n ** 18n,
        tokenDecimals: 18,
        sqrtPriceX96: 0n,
        tokenIsToken0: true,
        anchorDecimals: 18,
        anchorUsd: 2000,
      })
    ).toBeUndefined();
  });

  it('inverts the price when the token is token1', () => {
    const sqrt = (1n << 96n) * 2n; // price = 4 token1 per token0
    const asToken0 = computeFdvUsd({
      supply: 10n ** 18n,
      tokenDecimals: 18,
      sqrtPriceX96: sqrt,
      tokenIsToken0: true,
      anchorDecimals: 18,
      anchorUsd: 1,
    })!;
    const asToken1 = computeFdvUsd({
      supply: 10n ** 18n,
      tokenDecimals: 18,
      sqrtPriceX96: sqrt,
      tokenIsToken0: false,
      anchorDecimals: 18,
      anchorUsd: 1,
    })!;
    expect(asToken0 / asToken1).toBeCloseTo(16, 5); // 4 vs 1/4
  });
});

describe('resolveTokenMeta', () => {
  const caller = (supply: string, decimals: string) => {
    let calls = 0;
    const call = async (_to: string, data: string): Promise<string> => {
      calls++;
      if (data === SEL_TOTAL_SUPPLY) return supply;
      if (data === SEL_DECIMALS) return decimals;
      throw new Error('unexpected');
    };
    return { call, count: () => calls };
  };

  it('reads and caches supply + decimals', async () => {
    const { call, count } = caller(word('de0b6b3a7640000'), word('12'));
    const cache: Record<string, TokenMeta> = {};
    const checkedAt: Record<string, number> = {};
    const meta = await resolveTokenMeta(TOKEN, cache, checkedAt, sequentialCallMany(call), 1000);
    expect(meta).toEqual({ supply: 10n ** 18n, decimals: 18 });
    await resolveTokenMeta(TOKEN, cache, checkedAt, sequentialCallMany(call), 1000);
    expect(count()).toBe(2); // second call served from cache
  });

  it('re-reads after the TTL — supply is mutable, a mint should move the cap', async () => {
    const { call, count } = caller(word('1'), word('12'));
    const cache: Record<string, TokenMeta> = {};
    const checkedAt: Record<string, number> = {};
    await resolveTokenMeta(TOKEN, cache, checkedAt, sequentialCallMany(call), 1000);
    await resolveTokenMeta(TOKEN, cache, checkedAt, sequentialCallMany(call), 1000 + SUPPLY_TTL_MS + 1);
    expect(count()).toBe(4);
  });

  // A bare 0x for decimals() is indistinguishable from a real 0-decimal token
  // once decoded, and getting that wrong misprices the token by 1e18.
  it('rejects an empty decimals() response instead of reading it as 0', async () => {
    const { call } = caller(word('1'), '0x');
    const cache: Record<string, TokenMeta> = {};
    expect(await resolveTokenMeta(TOKEN, cache, {}, sequentialCallMany(call), 1000)).toBeUndefined();
    expect(cache[TOKEN]).toBeUndefined();
  });

  it('rejects an implausible decimals value', async () => {
    const { call } = caller(word('1'), word('ff'));
    expect(await resolveTokenMeta(TOKEN, {}, {}, sequentialCallMany(call), 1000)).toBeUndefined();
  });

  it('does not cache a transient failure', async () => {
    const call = async (): Promise<string> => {
      throw new Error('timeout');
    };
    const cache: Record<string, TokenMeta> = {};
    expect(
      await resolveTokenMeta(TOKEN, cache, {}, sequentialCallMany(call), 1000)
    ).toBeUndefined();
    expect(TOKEN in cache).toBe(false);
  });

  // A batch reports a per-item failure as `null`, which decodes to 0n exactly as a
  // real zero would. It must be rejected as transient and NOT cached, or a momentary
  // blip would pin a 0-decimal, 0-supply verdict on the token for the TTL.
  it('treats a null batch entry as transient and caches nothing', async () => {
    const cache: Record<string, TokenMeta> = {};
    const nulls = async (): Promise<(string | null)[]> => [null, null];
    expect(await resolveTokenMeta(TOKEN, cache, {}, nulls, 1000)).toBeUndefined();
    expect(TOKEN in cache).toBe(false);
  });
});
