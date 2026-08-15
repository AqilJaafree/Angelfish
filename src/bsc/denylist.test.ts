import { describe, it, expect } from 'vitest';
import { DENYLIST, filterDenied, isDenied } from './denylist';

const USDT = '0x55d398326f99059ff775485246999027b3197955';
const BTCB = '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c';
const CAKE = '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82';
const BUSD = '0xe9e7cea3dedca5984780bafc599bd69add087d56';
const NEW_TOKEN = '0x1234567890abcdef1234567890abcdef12345678';

describe('isDenied', () => {
  it('excludes stablecoins, bridged majors and DeFi blue chips', () => {
    expect(isDenied(USDT)).toBe(true);
    expect(isDenied(BTCB)).toBe(true);
    expect(isDenied(CAKE)).toBe(true);
    expect(isDenied(BUSD)).toBe(true);
  });

  // The stablecoins are anchors AND denylisted, deliberately. A USDT/USDC pool is
  // dropped upstream as anchor-on-both-sides, but USDT paired against a non-anchor
  // stable reaches the board as the tracked side, and belongs here.
  it('excludes an anchor stablecoin reached as the tracked side', () => {
    expect(isDenied('0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d')).toBe(true); // USDC
    expect(isDenied('0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d')).toBe(true); // USD1
  });

  it('leaves everything else alone', () => {
    expect(isDenied(NEW_TOKEN)).toBe(false);
  });

  it('matches a checksummed address rather than silently missing it', () => {
    expect(isDenied('0x55d398326f99059fF775485246999027B3197955')).toBe(true);
  });

  // THE important property. A symbol is unauthenticated — any contract can call
  // itself USDT. If this filter matched on symbols, an impostor would be hidden
  // from the very board meant to surface it. Only the real address is excluded.
  it('does not exclude an impostor that merely calls itself USDT', () => {
    expect(isDenied(NEW_TOKEN)).toBe(false);
    // A near-miss address (one nibble off the real USDT) must NOT match.
    expect(isDenied('0x55d398326f99059ff775485246999027b3197954')).toBe(false);
  });

  it('holds a plausible number of curated entries', () => {
    expect(DENYLIST.size).toBeGreaterThan(25);
  });

  it('stores every address lowercase, so lookups cannot miss', () => {
    for (const a of DENYLIST) expect(a).toBe(a.toLowerCase());
  });
});

describe('filterDenied', () => {
  it('drops denied rows and reports how many', () => {
    const rows = [{ token: USDT }, { token: NEW_TOKEN }, { token: BTCB }];
    const { kept, dropped } = filterDenied(rows);
    expect(kept.map((r) => r.token)).toEqual([NEW_TOKEN]);
    expect(dropped).toBe(2);
  });

  it('preserves rank order of what survives', () => {
    const rows = [{ token: 'a' }, { token: USDT }, { token: 'b' }, { token: 'c' }];
    expect(filterDenied(rows).kept.map((r) => r.token)).toEqual(['a', 'b', 'c']);
  });

  it('handles an all-denied window without throwing', () => {
    const { kept, dropped } = filterDenied([{ token: USDT }, { token: CAKE }]);
    expect(kept).toEqual([]);
    expect(dropped).toBe(2);
  });

  it('is a no-op on an empty list', () => {
    expect(filterDenied([])).toEqual({ kept: [], dropped: 0 });
  });
});
