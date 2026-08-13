import { describe, expect, it } from 'vitest';
import {
  MAX_TICK, MAX_UINT128, MIN_TICK, alignTick, applySlippage, buildMintParams, fromBaseUnits,
  knownToken, positionAmounts, priceFromSqrt, rangeTicks, resolveToken, singleSidedTicks,
  sortTokens, sqrtRatioAtTickX96, toBaseUnits,
} from './uniswap';

describe('resolveToken', () => {
  it('resolves a known symbol case-insensitively', () => {
    expect(resolveToken('usdc')?.address).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    expect(resolveToken('USDC')?.decimals).toBe(6);
  });
  it('accepts a raw address and marks decimals unknown', () => {
    const t = resolveToken('0xA0b86991c6218b36c1D19D4a2e9Eb0cE3606eB48');
    expect(t?.address).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    expect(t?.decimals).toBe(-1); // hydrated on chain later
  });
  it('rejects an unknown symbol and a malformed address', () => {
    expect(resolveToken('NOTATOKEN')).toBeUndefined();
    expect(resolveToken('0x1234')).toBeUndefined();
  });
});

describe('sortTokens', () => {
  // mint() takes currencies in address order; reversing them silently swaps
  // which side each amount funds.
  it('orders by address and reports the flip', () => {
    const usdc = resolveToken('USDC')!;
    const weth = resolveToken('WETH')!;
    const { token0, token1, flipped } = sortTokens(weth, usdc);
    expect(token0.symbol).toBe('USDC'); // 0xa0b8… < 0xc02a…
    expect(token1.symbol).toBe('WETH');
    expect(flipped).toBe(true);
    expect(sortTokens(usdc, weth).flipped).toBe(false);
  });
});

describe('toBaseUnits', () => {
  it('converts without floating point error', () => {
    expect(toBaseUnits('1.5', 6)).toBe(1_500_000n);
    expect(toBaseUnits('100', 6)).toBe(100_000_000n);
    expect(toBaseUnits('0.03', 18)).toBe(30_000_000_000_000_000n);
  });
  it('keeps precision a float would lose', () => {
    expect(toBaseUnits('0.1', 18)).toBe(100_000_000_000_000_000n);
    expect(toBaseUnits('1234567.123456', 6)).toBe(1_234_567_123_456n);
  });
  it('rejects more decimal places than the token has', () => {
    expect(() => toBaseUnits('1.1234567', 6)).toThrow(/decimal places/);
  });
  it('rejects junk', () => {
    for (const bad of ['', '.', 'abc', '-1', '1.2.3']) expect(() => toBaseUnits(bad, 6)).toThrow();
  });
  it('round-trips through fromBaseUnits', () => {
    expect(fromBaseUnits(toBaseUnits('123.45', 6), 6)).toBe('123.45');
    expect(fromBaseUnits(1_000_000n, 6)).toBe('1');
  });
});

describe('alignTick', () => {
  it('rounds down for lower and up for upper', () => {
    expect(alignTick(195, 60, 'down')).toBe(180);
    expect(alignTick(195, 60, 'up')).toBe(240);
  });
  it('handles negative ticks in the correct direction', () => {
    expect(alignTick(-195, 60, 'down')).toBe(-240);
    expect(alignTick(-195, 60, 'up')).toBe(-180);
  });
  it('clamps to the protocol bounds', () => {
    expect(alignTick(-1e9, 60, 'down')).toBe(MIN_TICK);
    expect(alignTick(1e9, 60, 'up')).toBe(MAX_TICK);
  });
});

describe('rangeTicks', () => {
  // Ticks are logarithmic. A ±10% band is ln(1.1)/ln(1.0001) ≈ 953 ticks wide
  // regardless of where the current tick sits — treating the percentage as
  // linear in tick space would be catastrophically wrong near tick 200,000.
  it('produces a log-derived band, not a linear one', () => {
    const { tickLower, tickUpper } = rangeTicks(200869, 10, 500);
    expect(tickUpper - 200869).toBeGreaterThan(900);
    expect(tickUpper - 200869).toBeLessThan(1010);
    expect(200869 - tickLower).toBeGreaterThan(900);
  });
  it('is width-invariant across very different current ticks', () => {
    const a = rangeTicks(0, 10, 500);
    const b = rangeTicks(200869, 10, 500);
    const widthA = a.tickUpper - a.tickLower;
    const widthB = b.tickUpper - b.tickLower;
    expect(Math.abs(widthA - widthB)).toBeLessThanOrEqual(2 * a.spacing);
  });
  it('aligns both bounds to the tier spacing', () => {
    for (const [fee, spacing] of [[500, 10], [3000, 60], [10000, 200]] as const) {
      const r = rangeTicks(200869, 5, fee);
      expect(r.tickLower % spacing).toBe(0);
      expect(r.tickUpper % spacing).toBe(0);
      expect(r.tickUpper).toBeGreaterThan(r.tickLower);
    }
  });
  it('never collapses to an empty range on a tiny percentage', () => {
    const r = rangeTicks(200869, 0.001, 10000); // spacing 200, band ~0 ticks
    expect(r.tickUpper).toBeGreaterThan(r.tickLower);
  });
  it('rejects an unsupported fee tier and an out-of-bounds range', () => {
    expect(() => rangeTicks(0, 10, 1234)).toThrow(/fee tier/);
    expect(() => rangeTicks(0, 0, 500)).toThrow(/between 0 and 100/);
    expect(() => rangeTicks(0, 100, 500)).toThrow(/between 0 and 100/);
  });
});

describe('singleSidedTicks', () => {
  // The live values this was first executed against: USDC/WETH 0.05%, tick 200843.
  const CUR = 200843;

  // Direction is the whole correctness question. token1-only must sit BELOW the
  // current tick; getting it backwards asks for the token the wallet lacks and
  // reverts with STF.
  it('places a token1-only range entirely below the current tick', () => {
    const { tickLower, tickUpper } = singleSidedTicks(CUR, 'token1', 1, 5, 500);
    expect(tickUpper).toBeLessThanOrEqual(CUR);
    expect(tickLower).toBeLessThan(tickUpper);
  });

  it('places a token0-only range entirely above the current tick', () => {
    const { tickLower, tickUpper } = singleSidedTicks(CUR, 'token0', 1, 5, 500);
    expect(tickLower).toBeGreaterThanOrEqual(CUR);
    expect(tickUpper).toBeGreaterThan(tickLower);
  });

  // Regression on the exact range that was minted as tokenId 1349240.
  it('reproduces the executed mainnet position', () => {
    expect(singleSidedTicks(CUR, 'token1', 1, 5, 500)).toEqual({
      tickLower: 200260, tickUpper: 200740, spacing: 10,
    });
  });

  it('leaves a real gap, so a small price move cannot drag price into the range', () => {
    const { tickUpper } = singleSidedTicks(CUR, 'token1', 1, 5, 500);
    expect(CUR - tickUpper).toBeGreaterThan(90); // ~1% ≈ 99 ticks
  });

  it('aligns both bounds to the tier spacing', () => {
    for (const [fee, spacing] of [[100, 1], [500, 10], [3000, 60], [10000, 200]] as const) {
      for (const side of ['token0', 'token1'] as const) {
        const r = singleSidedTicks(CUR, side, 1, 5, fee);
        expect(r.tickLower % spacing).toBe(0);
        expect(r.tickUpper % spacing).toBe(0);
        expect(r.tickUpper).toBeGreaterThan(r.tickLower);
      }
    }
  });

  // A width narrower than one spacing would otherwise collapse to an empty range.
  it('never collapses even when width rounds to nothing', () => {
    for (const side of ['token0', 'token1'] as const) {
      const r = singleSidedTicks(CUR, side, 1, 0.001, 10000);
      expect(r.tickUpper).toBeGreaterThan(r.tickLower);
    }
  });

  it('rejects a bad fee tier, offset or width', () => {
    expect(() => singleSidedTicks(CUR, 'token1', 1, 5, 1234)).toThrow(/fee tier/);
    expect(() => singleSidedTicks(CUR, 'token1', 0, 5, 500)).toThrow(/offset/);
    expect(() => singleSidedTicks(CUR, 'token1', 1, 0, 500)).toThrow(/width/);
  });
});

describe('knownToken', () => {
  it('maps a known address back to its symbol and decimals', () => {
    expect(knownToken('0xA0b86991c6218b36c1D19D4a2e9Eb0cE3606eB48')).toEqual({
      address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, symbol: 'USDC',
    });
  });
  it('is undefined for an address not in the alias table', () => {
    expect(knownToken('0x1111111111111111111111111111111111111111')).toBeUndefined();
  });
});

describe('positionAmounts', () => {
  const at = sqrtRatioAtTickX96;

  // Direction is the correctness question again, mirrored: v3 pays out 100%
  // token0 when price is BELOW the range and 100% token1 when it is above.
  it('is all token0 when the price sits below the range', () => {
    const { amount0, amount1 } = positionAmounts(10n ** 12n, 1000, 2000, at(500));
    expect(amount1).toBe(0n);
    expect(amount0).toBeGreaterThan(0n);
  });

  it('is all token1 when the price sits above the range', () => {
    const { amount0, amount1 } = positionAmounts(10n ** 12n, 1000, 2000, at(3000));
    expect(amount0).toBe(0n);
    expect(amount1).toBeGreaterThan(0n);
  });

  it('holds both sides when the price sits inside the range', () => {
    const { amount0, amount1 } = positionAmounts(10n ** 12n, 1000, 2000, at(1500));
    expect(amount0).toBeGreaterThan(0n);
    expect(amount1).toBeGreaterThan(0n);
  });

  // Regression against the real position this repo opened on mainnet: tokenId
  // 1349240, USDC/WETH 0.05%, ticks 200260–200740, liquidity 646,075,971,053,
  // funded single-sided with 0.00035 WETH. Price was above the range (tick
  // 200843), so the whole position must value as WETH — and back out at very
  // close to what went in.
  it('reproduces the deposit of the executed mainnet position', () => {
    const { amount0, amount1 } = positionAmounts(646_075_971_053n, 200260, 200740, at(200843));
    expect(amount0).toBe(0n);
    const weth = Number(amount1) / 1e18;
    expect(weth).toBeGreaterThan(0.00034);
    expect(weth).toBeLessThan(0.00036);
  });

  it('scales linearly with liquidity, so a 50% exit is half the value', () => {
    const full = positionAmounts(10n ** 12n, 1000, 2000, at(1500));
    const half = positionAmounts(5n * 10n ** 11n, 1000, 2000, at(1500));
    expect(Number(half.amount0) / Number(full.amount0)).toBeCloseTo(0.5, 6);
    expect(Number(half.amount1) / Number(full.amount1)).toBeCloseTo(0.5, 6);
  });

  it('returns zero for zero liquidity rather than dividing by anything', () => {
    expect(positionAmounts(0n, 1000, 2000, at(1500))).toEqual({ amount0: 0n, amount1: 0n });
  });

  // A zero price would divide by zero in the token0 leg if it were not clamped
  // into the range first.
  it('survives a zero pool price by clamping into the range', () => {
    expect(() => positionAmounts(10n ** 12n, 1000, 2000, 0n)).not.toThrow();
    expect(positionAmounts(10n ** 12n, 1000, 2000, 0n).amount1).toBe(0n);
  });

  it('rejects an inverted range', () => {
    expect(() => positionAmounts(1n, 2000, 1000, at(1500))).toThrow(/empty range/);
  });
});

describe('MAX_UINT128', () => {
  // collect() takes uint128 maxima; anything larger silently overflows the type.
  it('is exactly the uint128 maximum', () => {
    expect(MAX_UINT128).toBe(340282366920938463463374607431768211455n);
  });
});

describe('priceFromSqrt', () => {
  it('prices the live USDC/WETH pool in a sane range', () => {
    // sqrtPriceX96 read from 0x88e6…5640 on mainnet; USDC(6)/WETH(18).
    const price = priceFromSqrt(1821724483374936618323423076607709n, 6, 18);
    // token1 per token0 = WETH per USDC, so ETH/USD is its reciprocal.
    expect(1 / price).toBeGreaterThan(200);
    expect(1 / price).toBeLessThan(100000);
  });
});

describe('applySlippage', () => {
  it('reduces by the given percentage using integer maths', () => {
    expect(applySlippage(1_000_000n, 1)).toBe(990_000n);
    expect(applySlippage(1_000_000n, 0)).toBe(1_000_000n);
    expect(applySlippage(1_000_000n, 0.5)).toBe(995_000n);
  });
  it('stays exact on amounts far beyond float precision', () => {
    expect(applySlippage(10n ** 30n, 1)).toBe((10n ** 30n * 9900n) / 10000n);
  });
  it('rejects nonsense', () => {
    expect(() => applySlippage(1n, 100)).toThrow();
    expect(() => applySlippage(1n, -1)).toThrow();
  });
});

describe('buildMintParams', () => {
  const usdc = resolveToken('USDC')!;
  const weth = resolveToken('WETH')!;

  it('emits an OBJECT tuple, which is what KeeperHub can encode', () => {
    const p = buildMintParams({
      token0: usdc, token1: weth, fee: 500, tickLower: 100, tickUpper: 200,
      amount0: 1_000_000n, amount1: 10n ** 15n, slippagePct: 1,
      recipient: '0x212C4a0f0a6621CE878846F412609a7F1A320538', deadlineSec: 1900000000,
    });
    // A nested array here fails encoding with `invalid address (argument="token0")`.
    expect(Array.isArray(p)).toBe(false);
    expect(p.token0).toBe(usdc.address);
    expect(p.amount0Min).toBe('990000');
    expect(p.deadline).toBe('1900000000');
  });

  it('carries amounts as decimal strings, never numbers', () => {
    const p = buildMintParams({
      token0: usdc, token1: weth, fee: 500, tickLower: 0, tickUpper: 10,
      amount0: 10n ** 24n, amount1: 0n, slippagePct: 0,
      recipient: '0x0', deadlineSec: 1,
    });
    expect(typeof p.amount0Desired).toBe('string');
    expect(p.amount0Desired).toBe('1000000000000000000000000'); // no 1e+24
  });
});
