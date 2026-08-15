import { describe, it, expect } from 'vitest';
import { anchorSide, isAnchor, toUsd } from './anchors';
import { NATIVE_BNB, USD1, USDC, USDT, WBNB } from './config';

const TOKEN = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

describe('isAnchor', () => {
  it('recognises native BNB, WBNB and all three USD stables', () => {
    for (const a of [NATIVE_BNB, WBNB, USDT, USDC, USD1]) expect(isAnchor(a)).toBe(true);
  });

  it('does not treat an ordinary token as an anchor', () => {
    expect(isAnchor(TOKEN)).toBe(false);
  });

  it('is case-insensitive, so a checksummed address cannot slip through', () => {
    expect(isAnchor('0xbB4CDb9CBd36B01bD1cBaEBF2De08d9173bc095c')).toBe(true);
  });
});

describe('anchorSide', () => {
  it('picks the token side when the anchor is currency0', () => {
    expect(anchorSide(USDT, TOKEN)).toEqual({
      anchor: USDT,
      kind: 'usd',
      token: TOKEN,
      anchorIsCurrency0: true,
    });
  });

  it('picks the token side when the anchor is currency1', () => {
    expect(anchorSide(TOKEN, WBNB)).toEqual({
      anchor: WBNB,
      kind: 'bnb',
      token: TOKEN,
      anchorIsCurrency0: false,
    });
  });

  it('classifies native BNB as a bnb anchor, not a missing one', () => {
    expect(anchorSide(NATIVE_BNB, TOKEN)?.kind).toBe('bnb');
  });

  // THE reason this is an XOR rather than an "either side matches". A pool anchored
  // on both sides has no subject token, and on BSC that is not an edge case: the
  // WBNB/USDT pools are among the busiest on the chain. Admitting them would rank
  // USDT on a Top Movers board for trading against BNB.
  it('rejects a pair with an anchor on BOTH sides', () => {
    expect(anchorSide(WBNB, USDT)).toBeNull();
    expect(anchorSide(USDT, USDC)).toBeNull();
    expect(anchorSide(NATIVE_BNB, USD1)).toBeNull();
  });

  it('rejects a pair with no anchor at all', () => {
    expect(anchorSide(TOKEN, OTHER)).toBeNull();
  });

  it('normalises case on both sides', () => {
    const side = anchorSide('0x55D398326f99059fF775485246999027B3197955', TOKEN.toUpperCase());
    expect(side?.anchor).toBe(USDT);
    expect(side?.token).toBe(TOKEN);
  });
});

describe('toUsd', () => {
  const ONE = 10n ** 18n;

  // A stable's raw amount IS its USD amount, because every BSC anchor is 18
  // decimals. No float touches this path, and it keeps working when the BNB/USD
  // read has failed — which is most of the board.
  it('passes a usd-anchored amount through untouched, even with no rate', () => {
    expect(toUsd(1234n * ONE, 'usd', undefined)).toBe(1234n * ONE);
    expect(toUsd(7n, 'usd', 900)).toBe(7n);
  });

  it('converts a bnb-anchored amount at the given rate', () => {
    expect(toUsd(2n * ONE, 'bnb', 900)).toBe(1800n * ONE);
  });

  it('handles a fractional rate without losing the amount', () => {
    expect(toUsd(ONE, 'bnb', 912.5)).toBe(9125n * 10n ** 17n);
  });

  // A window's volume routinely exceeds 2^53 base units. Converting via Number
  // first would silently drop low-order digits on exactly the busiest pools.
  it('keeps full precision on an amount far beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = 10n ** 30n; // a trillion tokens at 18 decimals
    expect(toUsd(huge, 'bnb', 2)).toBe(2n * huge);
  });

  it('returns undefined for a bnb amount when the rate is unusable', () => {
    for (const bad of [undefined, 0, -1, NaN, Infinity]) {
      expect(toUsd(ONE, 'bnb', bad as number | undefined)).toBeUndefined();
    }
  });
});
