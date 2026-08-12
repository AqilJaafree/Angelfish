import { describe, it, expect } from 'vitest';
import { resolvePoolMeta } from './metadata';
import { PoolMeta } from './swaps';
import { WETH, V3_FACTORY, SEL_TOKEN0, SEL_TOKEN1, SEL_FEE, SEL_GET_POOL } from '../config';

const word = (hex: string): string => '0x' + hex.replace(/^0x/, '').padStart(64, '0');
const TOKEN = '0x1111111111111111111111111111111111111111';
const POOL = '0x2222222222222222222222222222222222222222';

// A stub node for a pool whose factory verdict is configurable.
function makeCaller(opts: {
  token0?: string;
  token1?: string;
  fee?: number;
  factoryReturns?: string; // what getPool answers with
  failFactory?: boolean;
}) {
  const calls: string[] = [];
  const call = async (to: string, data: string): Promise<string> => {
    calls.push(`${to}:${data.slice(0, 10)}`);
    if (to === V3_FACTORY) {
      if (opts.failFactory) throw new Error('timeout');
      if (!data.startsWith(SEL_GET_POOL)) throw new Error('unexpected selector');
      return word(opts.factoryReturns ?? POOL);
    }
    if (data === SEL_TOKEN0) return word(opts.token0 ?? WETH);
    if (data === SEL_TOKEN1) return word(opts.token1 ?? TOKEN);
    if (data === SEL_FEE) return word((opts.fee ?? 3000).toString(16));
    throw new Error('unexpected call');
  };
  return { call, calls };
}

describe('resolvePoolMeta', () => {
  it('resolves a canonical WETH pool and records the anchor side', async () => {
    const { call } = makeCaller({ token0: WETH, token1: TOKEN });
    const cache: Record<string, PoolMeta | null> = {};
    const meta = await resolvePoolMeta(POOL, cache, call);
    expect(meta).toEqual({ pool: POOL, token: TOKEN, fee: 3000, wethIsToken0: true });
    expect(cache[POOL]).toEqual(meta);
  });

  it('handles WETH as token1', async () => {
    const { call } = makeCaller({ token0: TOKEN, token1: WETH });
    const meta = await resolvePoolMeta(POOL, {}, call);
    expect(meta?.wethIsToken0).toBe(false);
    expect(meta?.token).toBe(TOKEN);
  });

  // The mainnet-specific behaviour: a v3 FORK answers token0/token1/fee exactly
  // like the real thing, so only the factory can tell them apart.
  it('rejects a fork whose pair the canonical factory does not know', async () => {
    const { call } = makeCaller({ factoryReturns: '0x0' }); // getPool -> address(0)
    const cache: Record<string, PoolMeta | null> = {};
    expect(await resolvePoolMeta(POOL, cache, call)).toBeNull();
    expect(cache[POOL]).toBeNull(); // negative cached — never re-resolved
  });

  it('rejects a factory answer pointing at a different pool address', async () => {
    const { call } = makeCaller({ factoryReturns: '0x9999999999999999999999999999999999999999' });
    expect(await resolvePoolMeta(POOL, {}, call)).toBeNull();
  });

  it('does NOT cache a negative when the factory call merely failed', async () => {
    const { call } = makeCaller({ failFactory: true });
    const cache: Record<string, PoolMeta | null> = {};
    expect(await resolvePoolMeta(POOL, cache, call)).toBeNull();
    // A timed-out verification must not blacklist a genuine pool for the process' life.
    expect(POOL in cache).toBe(false);
  });

  it('caches the negative for a confirmed non-WETH pool without asking the factory', async () => {
    const { call, calls } = makeCaller({ token0: TOKEN, token1: '0x3333333333333333333333333333333333333333' });
    const cache: Record<string, PoolMeta | null> = {};
    expect(await resolvePoolMeta(POOL, cache, call)).toBeNull();
    expect(cache[POOL]).toBeNull();
    expect(calls.some((c) => c.startsWith(V3_FACTORY))).toBe(false);
  });

  it('rejects a contract that returns bare 0x for token0()', async () => {
    const call = async (_to: string, data: string): Promise<string> =>
      data === SEL_TOKEN0 ? '0x' : word(WETH);
    const cache: Record<string, PoolMeta | null> = {};
    expect(await resolvePoolMeta(POOL, cache, call)).toBeNull();
    expect(cache[POOL]).toBeNull();
  });

  it('serves from cache without any RPC', async () => {
    const hit: PoolMeta = { pool: POOL, token: TOKEN, fee: 500, wethIsToken0: false };
    const call = async (): Promise<string> => {
      throw new Error('should not be called');
    };
    expect(await resolvePoolMeta(POOL, { [POOL]: hit }, call)).toEqual(hit);
  });
});
