import { describe, expect, it } from 'vitest';
import { parse, parseExitPct, parseExitTarget } from './commands';

describe('parseExitTarget', () => {
  it('lists when given no argument, so /exit alone is a menu', () => {
    expect(parseExitTarget(undefined, 3)).toEqual({ kind: 'list' });
    expect(parseExitTarget('', 3)).toEqual({ kind: 'list' });
  });

  // The whole point of the slot indirection: a small number is the row the user
  // is looking at, not a token id they had to copy.
  it('reads a small number as a position slot', () => {
    expect(parseExitTarget('1', 3)).toEqual({ kind: 'slot', slot: 1 });
    expect(parseExitTarget('3', 3)).toEqual({ kind: 'slot', slot: 3 });
  });

  // Guessing between "slot" and "token id" would target an unrelated position,
  // so an out-of-range number is refused with the explicit form spelled out.
  it('refuses a number past the end of the list instead of guessing a token id', () => {
    const out = parseExitTarget('1349240', 2);
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.message).toContain('/exit #1349240');
    expect(out.kind === 'error' && out.message).toContain('pick 1–2');
  });

  it('takes an explicit #tokenId as the escape hatch', () => {
    expect(parseExitTarget('#1349240', 2)).toEqual({ kind: 'tokenId', tokenId: '1349240' });
  });

  it('accepts a #tokenId even when the wallet lists nothing', () => {
    expect(parseExitTarget('#1349240', 0)).toEqual({ kind: 'tokenId', tokenId: '1349240' });
  });

  it('rejects a malformed token id', () => {
    expect(parseExitTarget('#abc', 2).kind).toBe('error');
  });

  it('rejects junk with a usage hint', () => {
    const out = parseExitTarget('all', 2);
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.message).toContain('/exit');
  });

  it('says there is nothing to exit when the wallet holds no positions', () => {
    const out = parseExitTarget('1', 0);
    expect(out.kind).toBe('error');
    expect(out.kind === 'error' && out.message).toContain('no open positions');
  });

  it('ignores surrounding whitespace', () => {
    expect(parseExitTarget('  2  ', 3)).toEqual({ kind: 'slot', slot: 2 });
  });
});

describe('parseExitPct', () => {
  it('defaults to a full exit', () => {
    expect(parseExitPct(undefined)).toBe(100);
    expect(parseExitPct('')).toBe(100);
  });

  it('accepts a bare number or a percent sign', () => {
    expect(parseExitPct('50')).toBe(50);
    expect(parseExitPct('50%')).toBe(50);
    expect(parseExitPct('0.5')).toBe(0.5);
  });

  it('rejects a percentage outside (0, 100]', () => {
    for (const bad of ['0', '-10', '101', 'abc']) {
      expect(parseExitPct(bad)).toHaveProperty('error');
    }
  });
});

describe('parse', () => {
  it('reads a command and its arguments', () => {
    expect(parse('/exit 1 50')).toEqual({ name: 'exit', args: ['1', '50'] });
  });

  it('strips the @botname suffix Telegram appends in groups', () => {
    expect(parse('/exit@angelfish_bot 1')).toEqual({ name: 'exit', args: ['1'] });
  });

  it('ignores anything that is not a command', () => {
    expect(parse('hello')).toBeUndefined();
  });
});
