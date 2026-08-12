import { describe, it, expect } from 'vitest';
import { DENYLIST, filterDenied, isDenied } from './denylist';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WBTC = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
const UNI = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984';
const WSTETH = '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0';
const NEW_TOKEN = '0x1234567890abcdef1234567890abcdef12345678';

describe('isDenied', () => {
  it('excludes stablecoins, wrapped majors, LSTs and DeFi blue chips', () => {
    expect(isDenied(USDC)).toBe(true);
    expect(isDenied(WBTC)).toBe(true);
    expect(isDenied(UNI)).toBe(true);
    expect(isDenied(WSTETH)).toBe(true);
  });

  it('excludes large caps that are none of those categories', () => {
    expect(isDenied('0xf34960d9d60be18cc1d5afc1a6f012a723a28811')).toBe(true); // KCS
    expect(isDenied('0x4a220e6096b25eadb88358cb44068a3248254675')).toBe(true); // QNT
  });

  it('leaves everything else alone', () => {
    expect(isDenied(NEW_TOKEN)).toBe(false);
  });

  it('matches a checksummed address rather than silently missing it', () => {
    expect(isDenied('0xA0b86991c6218b36c1D19D4a2e9Eb0cE3606eB48')).toBe(true);
  });

  // THE important property. A symbol is unauthenticated — any contract can call
  // itself USDC. If this filter matched on symbols, an impostor would be hidden
  // from the very board meant to surface it. Only the real address is excluded.
  it('does not exclude an impostor that merely calls itself USDC', () => {
    expect(isDenied(NEW_TOKEN)).toBe(false);
    // A near-miss address (one nibble off the real USDC) must NOT match.
    expect(isDenied('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb49')).toBe(false);
  });

  it('holds a plausible number of curated entries', () => {
    expect(DENYLIST.size).toBeGreaterThan(40);
  });

  it('stores every address lowercase, so lookups cannot miss', () => {
    for (const a of DENYLIST) expect(a).toBe(a.toLowerCase());
  });
});

describe('filterDenied', () => {
  it('drops denied rows and reports how many', () => {
    const rows = [{ token: USDC }, { token: NEW_TOKEN }, { token: WBTC }];
    const { kept, dropped } = filterDenied(rows);
    expect(kept.map((r) => r.token)).toEqual([NEW_TOKEN]);
    expect(dropped).toBe(2);
  });

  it('preserves rank order of what survives', () => {
    const rows = [{ token: 'a' }, { token: USDC }, { token: 'b' }, { token: 'c' }];
    expect(filterDenied(rows).kept.map((r) => r.token)).toEqual(['a', 'b', 'c']);
  });

  it('handles an all-denied window without throwing', () => {
    const { kept, dropped } = filterDenied([{ token: USDC }, { token: UNI }]);
    expect(kept).toEqual([]);
    expect(dropped).toBe(2);
  });

  it('is a no-op on an empty list', () => {
    expect(filterDenied([])).toEqual({ kept: [], dropped: 0 });
  });
});
