import { describe, it, expect } from 'vitest';
import { selectByMarketCap } from './mcap-select';

const row = (token: string, pool = token) => ({ token, pool });
const opts = { minUsd: 300_000, perGroup: 2, maxLookups: 25 };

describe('selectByMarketCap', () => {
  it('splits on the threshold', async () => {
    const caps: Record<string, number> = { a: 1_000_000, b: 1000 };
    const s = await selectByMarketCap([row('a'), row('b')], async (r) => caps[r.token], opts);
    expect(s.main.map((r) => r.token)).toEqual(['a']);
    expect(s.danger.map((r) => r.token)).toEqual(['b']);
  });

  it('routes an unknown cap to danger — unknown is not evidence of qualifying', async () => {
    const s = await selectByMarketCap([row('a')], async () => undefined, opts);
    expect(s.danger.map((r) => r.token)).toEqual(['a']);
    expect(s.danger[0].marketCapUsd).toBeUndefined();
  });

  it('treats a rejected resolver exactly like an unknown cap', async () => {
    const s = await selectByMarketCap(
      [row('a')],
      async () => {
        throw new Error('rpc down');
      },
      opts
    );
    expect(s.danger.map((r) => r.token)).toEqual(['a']);
  });

  // The contradiction this memo exists to prevent: one token, two pools, two
  // different verdicts inside a single cycle.
  it('resolves each token once so two pools of it cannot land on both boards', async () => {
    let n = 0;
    const s = await selectByMarketCap(
      [row('a', 'p1'), row('a', 'p2')],
      async () => (n++ === 0 ? 1_000_000 : 1),
      opts
    );
    expect(s.lookups).toBe(1);
    expect(s.main).toHaveLength(2);
    expect(s.danger).toHaveLength(0);
  });

  it('stops walking once both groups are full', async () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((t) => row(t));
    const caps: Record<string, number> = { a: 1e6, b: 1e6, c: 1, d: 1, e: 1e6, f: 1 };
    const s = await selectByMarketCap(rows, async (r) => caps[r.token], opts);
    expect(s.main).toHaveLength(2);
    expect(s.danger).toHaveLength(2);
    expect(s.lookups).toBe(4); // never reached e or f
  });

  it('flags when the lookup budget stops the walk early', async () => {
    const rows = ['a', 'b', 'c'].map((t) => row(t));
    const s = await selectByMarketCap(rows, async () => 1, { ...opts, maxLookups: 1 });
    expect(s.capped).toBe(true);
    expect(s.lookups).toBe(1);
  });

  it('does not spend a lookup on a memoized token when the budget is exhausted', async () => {
    const rows = [row('a', 'p1'), row('a', 'p2'), row('b')];
    let calls = 0;
    const s = await selectByMarketCap(
      rows,
      async () => {
        calls++;
        return 1;
      },
      { minUsd: 300_000, perGroup: 5, maxLookups: 1 }
    );
    expect(calls).toBe(1);
    expect(s.danger).toHaveLength(2); // both pools of 'a' placed; 'b' cut by budget
    expect(s.capped).toBe(true);
  });
});
