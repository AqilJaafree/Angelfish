import { describe, it, expect } from 'vitest';
import { formatBadges, formatBoard, formatFeeTier, formatRsi, formatUsd } from './format';
import { MoversRow } from '../types';

const base: MoversRow = {
  pool: '0xpool',
  token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  symbol: 'TEST',
  volumeWeth: 12_400_000_000_000_000_000n,
  swaps: 88,
  traders: 41,
  feesWeth: 37_000_000_000_000_000n,
};

describe('formatFeeTier', () => {
  it('renders the four v3 tiers', () => {
    expect(formatFeeTier(100)).toBe('0.01%');
    expect(formatFeeTier(500)).toBe('0.05%');
    expect(formatFeeTier(3000)).toBe('0.3%');
    expect(formatFeeTier(10000)).toBe('1%');
  });
});

describe('formatUsd', () => {
  it('abbreviates by magnitude', () => {
    expect(formatUsd(1_200_000)).toBe('MC $1.2M');
    expect(formatUsd(4000)).toBe('MC $4.0K');
    expect(formatUsd(2_500_000_000)).toBe('MC $2.5B');
  });

  it('distinguishes unknown from tiny', () => {
    expect(formatUsd(undefined)).toBe('MC —');
    expect(formatUsd(0.5)).toBe('MC <$1');
  });
});

describe('formatBadges', () => {
  it('keeps verification and risk separate — ✅🔴 and ⚠️⬜ are different situations', () => {
    expect(formatBadges({ ...base, verified: true, risk: 'clean' })).toBe('✅🟢');
    expect(formatBadges({ ...base, verified: true, risk: 'high' })).toBe('✅🔴');
    expect(formatBadges({ ...base, verified: false, risk: 'unknown' })).toBe('⚠️⬜');
    expect(formatBadges({ ...base, verified: true, risk: 'caution' })).toBe('✅🟡');
  });

  it('renders nothing when the lookup did not resolve', () => {
    expect(formatBadges(base)).toBe('');
  });
});

describe('formatRsi', () => {
  it('shows a dash while warming up', () => {
    expect(formatRsi(base)).toBe('RSI —');
  });

  it('labels the extremes', () => {
    expect(formatRsi({ ...base, rsi: 78, rsiLabel: 'overbought' })).toBe('RSI 78 🔴 Overbought');
    expect(formatRsi({ ...base, rsi: 24, rsiLabel: 'oversold' })).toBe('RSI 24 🟢 Oversold');
    expect(formatRsi({ ...base, rsi: 55 })).toBe('RSI 55');
  });
});

describe('formatBoard', () => {
  it('renders three lines per row, ending with the contract address', () => {
    const out = formatBoard({
      rows: [{ ...base, feeTier: '0.3%', marketCapUsd: 1_200_000, verified: true, risk: 'clean' }],
      block: 200,
      fromBlock: 195,
      variant: 'main',
      label: 'Uniswap v3 (ETH) — mainnet',
    });
    const lines = out.split('\n');
    expect(lines[0]).toContain('Uniswap v3 (ETH) — mainnet');
    expect(lines[0]).toContain('blocks 195–200');
    expect(lines[1]).toBe('🥇 TEST ✅🟢 (0.3%) (warming) · RSI — · MC $1.2M');
    expect(lines[2]).toContain('88 swaps');
    expect(lines[2]).toContain('41 traders');
    expect(lines[3]).toBe('    ↳ 0xc02a…6cc2');
  });

  it('marks the danger board with its origin', () => {
    const out = formatBoard({
      rows: [base],
      block: 2,
      fromBlock: 1,
      variant: 'danger',
      label: 'Uniswap v4 (ETH)',
    });
    expect(out).toContain('Danger Zone');
    expect(out).toContain('Uniswap v4 (ETH)');
  });

  // The spike multiple is the signal the board ranks on, so it belongs on the
  // row. A warming-up pool must NOT render "1.0x" — that asserts the pool is
  // flat, when the truth is that nothing is known about it yet.
  it('renders the spike multiple, and marks warm-up distinctly from flat', () => {
    const out = formatBoard({ rows: [{ ...base, spike: 22.4 }], block: 2, fromBlock: 1 });
    expect(out).toContain('22x');
    const flat = formatBoard({ rows: [{ ...base, spike: 1.03 }], block: 2, fromBlock: 1 });
    expect(flat).toContain('1.0x');
    const warming = formatBoard({ rows: [base], block: 2, fromBlock: 1 });
    expect(warming).toContain('(warming)');
    expect(warming).not.toContain('1.0x');
  });

  it('renders a v4 dynamic tier as-is', () => {
    const out = formatBoard({
      rows: [{ ...base, feeTier: 'dynamic' }],
      block: 2,
      fromBlock: 1,
    });
    expect(out).toContain('(dynamic)');
  });
});
