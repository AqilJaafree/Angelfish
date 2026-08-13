import { beforeEach, describe, expect, it } from 'vitest';
import { CONFIRM_TTL_MS } from './config';
import { clear, makeCode, put, size, take } from './pending';

const plan = { summary: 's', steps: [{ label: 'l', contract: '0x1', fn: 'mint', args: '[]' }] };

beforeEach(() => clear());

describe('pending plans', () => {
  it('round-trips a stored plan by its code', () => {
    const stored = put(plan, 1000);
    const got = take(stored.code, 1000);
    expect(got && 'summary' in got && got.summary).toBe('s');
  });

  // The property that matters most: a confirm code must not mint twice. The
  // second mint would succeed exactly as well as the first, so replay is the
  // expensive failure here.
  it('is single-use', () => {
    const stored = put(plan, 1000);
    expect(take(stored.code, 1000)).toBeDefined();
    expect(take(stored.code, 1000)).toBeUndefined();
  });

  it('expires past the TTL and still consumes the code', () => {
    const stored = put(plan, 1000);
    const got = take(stored.code, 1000 + CONFIRM_TTL_MS + 1);
    expect(got).toEqual({ expired: true });
    expect(take(stored.code, 1000)).toBeUndefined();
  });

  it('accepts a code in any case, with surrounding whitespace', () => {
    const stored = put(plan, 0, 'ABC234');
    expect(take('  abc234 ', 0)).toBeDefined();
  });

  it('returns undefined for an unknown code', () => {
    expect(take('ZZZZZZ', 0)).toBeUndefined();
  });

  it('tracks and clears outstanding plans', () => {
    put(plan, 0, 'AAA222');
    put(plan, 0, 'BBB333');
    expect(size()).toBe(2);
    clear();
    expect(size()).toBe(0);
  });
});

describe('makeCode', () => {
  it('is six characters from an unambiguous alphabet', () => {
    const code = makeCode(() => 0.5);
    expect(code).toHaveLength(6);
    // No O/0 or I/1 — a code is read off a screen and typed back.
    expect(code).not.toMatch(/[OI01]/);
  });
  it('spans the alphabet without escaping it', () => {
    for (const r of [0, 0.999999]) expect(makeCode(() => r)).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  });
});
