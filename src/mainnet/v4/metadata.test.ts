import { describe, it, expect } from 'vitest';
import {
  indexInitializeLogs,
  resolveV4PoolMeta,
  UNRESOLVED_TTL_MS,
  V4PoolMeta,
} from './metadata';
import { NATIVE_ETH, WETH, V4_INITIALIZE_TOPIC0 } from '../config';

const word = (hex: string): string => hex.replace(/^0x/, '').padStart(64, '0');
const TOKEN = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const POOL_ID = '0x' + 'ab'.repeat(32);

// PoolKey = (currency0, currency1, fee, tickSpacing, hooks)
function poolKeysResult(c0: string, c1: string, fee: number, tickSpacing: number): string {
  return (
    '0x' +
    word(c0) +
    word(c1) +
    word(fee.toString(16)) +
    word(tickSpacing.toString(16)) +
    word('0')
  );
}

describe('resolveV4PoolMeta (PositionManager.poolKeys)', () => {
  it('resolves a WETH pool', async () => {
    const call = async (): Promise<string> => poolKeysResult(WETH, TOKEN, 3000, 60);
    const cache: Record<string, V4PoolMeta | null> = {};
    const meta = await resolveV4PoolMeta(POOL_ID, cache, {}, call, 1000);
    expect(meta).toEqual({ poolId: POOL_ID, token: TOKEN, ethIsCurrency0: true, fee: 3000 });
  });

  // Native ETH is currency address(0) — a zero currency0 is LEGITIMATE here, which
  // is why emptiness has to be judged on tickSpacing instead.
  it('resolves a native-ETH pool where currency0 is address(0)', async () => {
    const call = async (): Promise<string> => poolKeysResult(NATIVE_ETH, TOKEN, 10000, 200);
    const meta = await resolveV4PoolMeta(POOL_ID, {}, {}, call, 1000);
    expect(meta).toEqual({ poolId: POOL_ID, token: TOKEN, ethIsCurrency0: true, fee: 10000 });
  });

  it('treats a zero tickSpacing as an unknown pool, not an ETH pool', async () => {
    const call = async (): Promise<string> => poolKeysResult(NATIVE_ETH, NATIVE_ETH, 0, 0);
    const cache: Record<string, V4PoolMeta | null> = {};
    expect(await resolveV4PoolMeta(POOL_ID, cache, {}, call, 1000)).toBeNull();
    expect(cache[POOL_ID]).toBeNull();
  });

  it('carries the dynamic-fee flag through untouched', async () => {
    const call = async (): Promise<string> => poolKeysResult(WETH, TOKEN, 0x800000, 60);
    const meta = await resolveV4PoolMeta(POOL_ID, {}, {}, call, 1000);
    expect(meta?.fee).toBe(0x800000);
  });

  it('caches the negative for a confirmed non-ETH pair', async () => {
    const call = async (): Promise<string> => poolKeysResult(TOKEN, OTHER, 500, 10);
    const cache: Record<string, V4PoolMeta | null> = {};
    expect(await resolveV4PoolMeta(POOL_ID, cache, {}, call, 1000)).toBeNull();
    expect(cache[POOL_ID]).toBeNull();
  });

  it('retries a cached negative once the TTL expires', async () => {
    let hits = 0;
    const call = async (): Promise<string> => {
      hits++;
      return poolKeysResult(TOKEN, OTHER, 500, 10);
    };
    const cache: Record<string, V4PoolMeta | null> = {};
    const checkedAt: Record<string, number> = {};
    await resolveV4PoolMeta(POOL_ID, cache, checkedAt, call, 1000);
    await resolveV4PoolMeta(POOL_ID, cache, checkedAt, call, 1000 + UNRESOLVED_TTL_MS - 1);
    expect(hits).toBe(1); // still within TTL
    await resolveV4PoolMeta(POOL_ID, cache, checkedAt, call, 1000 + UNRESOLVED_TTL_MS + 1);
    expect(hits).toBe(2);
  });

  it('never re-reads a positive, since a PoolKey is immutable', async () => {
    let hits = 0;
    const call = async (): Promise<string> => {
      hits++;
      return poolKeysResult(WETH, TOKEN, 3000, 60);
    };
    const cache: Record<string, V4PoolMeta | null> = {};
    const checkedAt: Record<string, number> = {};
    await resolveV4PoolMeta(POOL_ID, cache, checkedAt, call, 1000);
    await resolveV4PoolMeta(POOL_ID, cache, checkedAt, call, 1e15);
    expect(hits).toBe(1);
  });

  it('does not cache anything on a transient RPC failure', async () => {
    const call = async (): Promise<string> => {
      throw new Error('timeout');
    };
    const cache: Record<string, V4PoolMeta | null> = {};
    expect(await resolveV4PoolMeta(POOL_ID, cache, {}, call, 1000)).toBeNull();
    expect(POOL_ID in cache).toBe(false);
  });

  it('does not cache a short/garbage response', async () => {
    const call = async (): Promise<string> => '0x';
    const cache: Record<string, V4PoolMeta | null> = {};
    expect(await resolveV4PoolMeta(POOL_ID, cache, {}, call, 1000)).toBeNull();
    expect(POOL_ID in cache).toBe(false);
  });
});

describe('indexInitializeLogs', () => {
  const log = (poolId: string, c0: string, c1: string, fee: number) => ({
    address: '0xpm',
    topics: [V4_INITIALIZE_TOPIC0, poolId, '0x' + word(c0), '0x' + word(c1)],
    data: '0x' + word(fee.toString(16)),
  });

  it('indexes an ETH pool from its Initialize event', () => {
    const registry: Record<string, V4PoolMeta | null> = {};
    expect(indexInitializeLogs(registry, [log(POOL_ID, NATIVE_ETH, TOKEN, 3000)])).toBe(1);
    expect(registry[POOL_ID]).toEqual({
      poolId: POOL_ID,
      token: TOKEN,
      ethIsCurrency0: true,
      fee: 3000,
    });
  });

  it('stores a non-ETH pool as a permanent negative', () => {
    const registry: Record<string, V4PoolMeta | null> = {};
    indexInitializeLogs(registry, [log(POOL_ID, TOKEN, OTHER, 500)]);
    expect(registry[POOL_ID]).toBeNull();
  });

  it('skips a malformed log rather than throwing on a missing topic', () => {
    const registry: Record<string, V4PoolMeta | null> = {};
    const bad = { address: '0xpm', topics: [V4_INITIALIZE_TOPIC0, POOL_ID], data: '0x' };
    expect(() => indexInitializeLogs(registry, [bad])).not.toThrow();
    expect(registry).toEqual({});
  });

  it('counts only ids it had not seen before', () => {
    const registry: Record<string, V4PoolMeta | null> = {};
    const logs = [log(POOL_ID, WETH, TOKEN, 3000)];
    expect(indexInitializeLogs(registry, logs)).toBe(1);
    expect(indexInitializeLogs(registry, logs)).toBe(0);
  });
});
