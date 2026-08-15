import { describe, it, expect } from 'vitest';
import {
  auditBadge,
  formatDangerZoneBoard,
  formatMarketCap,
  formatMoversBoardV3,
  formatMoversBoardCl,
  formatUsdAmount,
  htmlEscape,
  TELEGRAM_MAX_LEN,
} from './format';
import { MoversRow } from '../types';

const row: MoversRow = {
  pool: '0xpool',
  token: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  symbol: 'TEST',
  volumeUsd: 12_400_000_000_000_000_000n,
  swaps: 88,
  traders: 41,
  feesUsd: 37_000_000_000_000_000n,
  feeTier: '0.25%',
  marketCapUsd: 1_200_000,
  verified: true,
  risk: 'clean',
};

const board = { rows: [row], block: 25_740_390, fromBlock: 25_740_385 };

describe('htmlEscape', () => {
  // Token symbols are attacker-controlled strings read off-chain. Unescaped, one
  // stray `<` makes Telegram reject the whole message and the board never posts.
  it('neutralises markup in a hostile token symbol', () => {
    expect(htmlEscape('<b>SAFE</b>')).toBe('&lt;b&gt;SAFE&lt;/b&gt;');
    expect(htmlEscape('A & B')).toBe('A &amp; B');
  });

  it('escapes the symbol inside a rendered board', () => {
    const out = formatMoversBoardV3({ ...board, rows: [{ ...row, symbol: '<i>x</i>' }] });
    expect(out).toContain('&lt;i&gt;x&lt;/i&gt;');
    expect(out).not.toContain('<i>x</i>');
  });
});

describe('formatUsdAmount', () => {
  it('truncates rather than rounding, so a figure never reads high', () => {
    expect(formatUsdAmount(1_999_999_999_999_999_999n, 2)).toBe('$1.99');
  });

  it('pads the fraction', () => {
    expect(formatUsdAmount(10n ** 18n, 3)).toBe('$1.000');
  });

  it('handles dust without losing the sign', () => {
    expect(formatUsdAmount(-(10n ** 17n), 2)).toBe('-$0.10');
  });

  // BSC volumes are USD figures, routinely six or seven digits, where the Ethereum
  // build's Ξ amounts were small enough to read unseparated.
  it('separates thousands in the whole part', () => {
    expect(formatUsdAmount(1_234_567n * 10n ** 18n, 2)).toBe('$1,234,567.00');
  });

  // An unpriced row (a BNB-quoted pool during a failed BNB/USD read) must not read
  // as zero volume.
  it('renders an unknown amount as a dash, never as $0', () => {
    expect(formatUsdAmount(undefined)).toBe('—');
    expect(formatUsdAmount(0n, 2)).toBe('$0.00');
  });
});

describe('formatMarketCap', () => {
  it('distinguishes unknown, sub-dollar, and real caps', () => {
    expect(formatMarketCap(undefined)).toBe('MC —');
    expect(formatMarketCap(1_200_000)).toBe('MC $1.2M');
    expect(formatMarketCap(49_800_000_000)).toBe('MC $49.8B');
  });

  // Regression: a bare `<` here made Telegram read `<$1` as an opening tag and
  // reject the entire board with "Unsupported start tag". Caught only by an
  // actual test post, because sub-dollar caps are rare on mainnet.
  it('escapes the sub-dollar marker for HTML mode', () => {
    expect(formatMarketCap(0.4)).toBe('MC &lt;$1');
    expect(formatMarketCap(0.4)).not.toContain('<');
  });
});

// Telegram rejects the WHOLE message on a parse error, so no rendered board may
// contain a `<` that does not open a tag it actually supports. This guards the
// class of bug rather than the one instance of it.
describe('rendered boards are valid Telegram HTML', () => {
  const SUPPORTED = /^(\/?)(b|i|u|s|code|pre|a)(\s|>|$)/;

  const assertWellFormed = (out: string): void => {
    for (let i = out.indexOf('<'); i !== -1; i = out.indexOf('<', i + 1)) {
      expect(
        SUPPORTED.test(out.slice(i + 1, i + 12)),
        `unescaped '<' at offset ${i}: ${JSON.stringify(out.slice(i, i + 24))}`
      ).toBe(true);
    }
  };

  const hostile: MoversRow = {
    ...row,
    symbol: '<script>&"\'',
    marketCapUsd: 0.4, // the sub-dollar branch
    feeTier: 'dynamic',
    verified: false,
    risk: 'unknown',
    rsi: 24,
    rsiLabel: 'oversold',
  };

  it('holds for every board variant, including the rare branches', () => {
    assertWellFormed(formatMoversBoardV3({ ...board, rows: [row, hostile] }));
    assertWellFormed(formatMoversBoardCl({ ...board, rows: [hostile] }));
    assertWellFormed(
      formatDangerZoneBoard({ ...board, rows: [hostile], label: '<b>evil</b> label' })
    );
  });

  it('holds for a row whose every optional field is absent', () => {
    const bare: MoversRow = {
      pool: '0xp',
      token: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
      symbol: 'BARE',
      volumeUsd: 0n,
      swaps: 0,
      traders: 0,
      feesUsd: 0n,
    };
    assertWellFormed(formatMoversBoardV3({ ...board, rows: [bare] }));
  });
});

describe('auditBadge', () => {
  it('keeps verification and risk separate', () => {
    expect(auditBadge(true, 'clean')).toBe(' ✅🟢');
    expect(auditBadge(true, 'high')).toBe(' ✅🔴');
    expect(auditBadge(false, 'unknown')).toBe(' ⚠️⬜');
  });

  it('renders nothing when the lookup did not resolve this cycle', () => {
    expect(auditBadge(undefined, undefined)).toBe('');
  });
});

describe('spike rendering', () => {
  it('shows the multiple the board ranks on', () => {
    expect(formatMoversBoardV3({ ...board, rows: [{ ...row, spike: 22.4 }] })).toContain('22×');
    expect(formatMoversBoardV3({ ...board, rows: [{ ...row, spike: 3.25 }] })).toContain('3.3×');
    expect(formatMoversBoardV3({ ...board, rows: [{ ...row, spike: 999 }] })).toContain('999×');
  });

  // "1.0×" would assert the pool is flat; the truth during warm-up is that
  // nothing is known about it yet. Those are different claims.
  it('marks a warming-up pool distinctly from a flat one', () => {
    const warming = formatMoversBoardV3({ ...board, rows: [row] });
    expect(warming).toContain('⏳');
    expect(warming).not.toContain('1.0×');
  });
});

describe('board rendering', () => {
  it('renders an HTML row with a clickable token link', () => {
    const out = formatMoversBoardV3(board);
    expect(out).toContain('<b>TEST</b>');
    expect(out).toContain('✅🟢');
    expect(out).toContain('(0.25%)');
    expect(out).toContain('MC $1.2M');
    expect(out).toContain('88 swaps');
    expect(out).toContain('href=');
    expect(out).toContain('0xbb4c…095c');
  });

  it('labels each version and the danger board\'s origin', () => {
    expect(formatMoversBoardV3(board)).toContain('PancakeSwap v3');
    expect(formatMoversBoardCl(board)).toContain('PancakeSwap Infinity');
    const danger = formatDangerZoneBoard({ ...board, label: 'PancakeSwap Infinity (BNB)' });
    expect(danger).toContain('Danger Zone');
    expect(danger).toContain('PancakeSwap Infinity (BNB)');
  });

  it('collapses the span when the window is a single block', () => {
    expect(formatMoversBoardV3({ ...board, fromBlock: board.block })).toContain(
      'block 25,740,390'
    );
  });

  // Telegram rejects an over-length body outright, which would cost the whole
  // board — so rows are dropped whole rather than the text being cut mid-tag.
  it('drops whole rows to stay under the length limit', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      ...row,
      symbol: `TOKEN${i}`.repeat(12),
    }));
    const out = formatMoversBoardV3({ ...board, rows: many });
    expect(out.length).toBeLessThanOrEqual(TELEGRAM_MAX_LEN);
    // Whatever survived is still well-formed markup, not a severed tag.
    expect((out.match(/<b>/g) ?? []).length).toBe((out.match(/<\/b>/g) ?? []).length);
    expect((out.match(/<a /g) ?? []).length).toBe((out.match(/<\/a>/g) ?? []).length);
  });
});
