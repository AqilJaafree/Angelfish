import { describe, it, expect } from 'vitest';
import { resolveClPoolMeta, UNRESOLVED_TTL_MS, ClPoolMeta } from './metadata';
import { NATIVE_BNB, USDT, WBNB } from '../config';

const word = (hex: string): string => hex.replace(/^0x/, '').padStart(64, '0');
const TOKEN = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const POOL_ID = '0x' + 'ab'.repeat(32);
const HOOK = '0x3333333333333333333333333333333333333333';
const MGR = '0x4444444444444444444444444444444444444444';

// Infinity PoolKey = (currency0, currency1, hooks, poolManager, fee, parameters).
//
// SIX words, and in a different order from Uniswap v4's five — `hooks` sits third
// rather than last, and poolManager/parameters have no v4 counterpart. Decoding one
// with the other's offsets reads `hooks` as a fee and silently mis-identifies pools,
// so the layout is pinned by these tests rather than assumed.
function poolKeyResult(
  c0: string,
  c1: string,
  { fee = 100, parameters = '0x010000', hooks = HOOK } = {}
): string {
  return (
    '0x' +
    word(c0) +
    word(c1) +
    word(hooks) +
    word(MGR) +
    word(fee.toString(16)) +
    word(parameters)
  );
}

describe('resolveClPoolMeta (CLPoolManager.poolIdToPoolKey)', () => {
  it('resolves a USD-anchored pool and records the anchor kind', async () => {
    const call = async (): Promise<string> => poolKeyResult(USDT, TOKEN);
    const cache: Record<string, ClPoolMeta | null> = {};
    const meta = await resolveClPoolMeta(POOL_ID, cache, {}, call, 1000);
    expect(meta).toEqual({
      poolId: POOL_ID,
      token: TOKEN,
      anchor: USDT,
      anchorKind: 'usd',
      anchorIsCurrency0: true,
    });
    expect(cache[POOL_ID]).toEqual(meta);
  });

  it('resolves a WBNB-anchored pool as kind bnb', async () => {
    const call = async (): Promise<string> => poolKeyResult(TOKEN, WBNB);
    const meta = await resolveClPoolMeta(POOL_ID, {}, {}, call, 1000);
    expect(meta?.anchorKind).toBe('bnb');
    expect(meta?.anchorIsCurrency0).toBe(false);
    expect(meta?.token).toBe(TOKEN);
  });

  // Native BNB is currency address(0) — a zero currency0 is LEGITIMATE here, which
  // is why emptiness has to be judged on `parameters` instead.
  it('resolves a native-BNB pool where currency0 is address(0)', async () => {
    const call = async (): Promise<string> => poolKeyResult(NATIVE_BNB, TOKEN);
    const meta = await resolveClPoolMeta(POOL_ID, {}, {}, call, 1000);
    expect(meta?.anchorKind).toBe('bnb');
    expect(meta?.token).toBe(TOKEN);
  });

  it('treats zero parameters as an unknown pool, not a native-BNB pool', async () => {
    const call = async (): Promise<string> =>
      poolKeyResult(NATIVE_BNB, NATIVE_BNB, { parameters: '0x0', hooks: '0x0' });
    const cache: Record<string, ClPoolMeta | null> = {};
    expect(await resolveClPoolMeta(POOL_ID, cache, {}, call, 1000)).toBeNull();
    expect(cache[POOL_ID]).toBeNull();
  });

  // Both sides anchored = no subject token. On BSC this is the busiest shape on the
  // chain (BNB/USDT), so it must be dropped rather than put USDT on a movers board.
  it('caches the negative for an anchor-on-both-sides pair', async () => {
    const call = async (): Promise<string> => poolKeyResult(WBNB, USDT);
    const cache: Record<string, ClPoolMeta | null> = {};
    expect(await resolveClPoolMeta(POOL_ID, cache, {}, call, 1000)).toBeNull();
    expect(cache[POOL_ID]).toBeNull();
  });

  it('caches the negative for a pair with no anchor at all', async () => {
    const call = async (): Promise<string> => poolKeyResult(TOKEN, OTHER);
    const cache: Record<string, ClPoolMeta | null> = {};
    expect(await resolveClPoolMeta(POOL_ID, cache, {}, call, 1000)).toBeNull();
    expect(cache[POOL_ID]).toBeNull();
  });

  it('retries a cached negative once the TTL expires', async () => {
    let hits = 0;
    const call = async (): Promise<string> => {
      hits++;
      return poolKeyResult(TOKEN, OTHER);
    };
    const cache: Record<string, ClPoolMeta | null> = {};
    const checkedAt: Record<string, number> = {};
    await resolveClPoolMeta(POOL_ID, cache, checkedAt, call, 1000);
    await resolveClPoolMeta(POOL_ID, cache, checkedAt, call, 1000 + UNRESOLVED_TTL_MS - 1);
    expect(hits).toBe(1); // still within TTL
    await resolveClPoolMeta(POOL_ID, cache, checkedAt, call, 1000 + UNRESOLVED_TTL_MS + 1);
    expect(hits).toBe(2);
  });

  it('never re-reads a positive, since a PoolKey is immutable', async () => {
    let hits = 0;
    const call = async (): Promise<string> => {
      hits++;
      return poolKeyResult(USDT, TOKEN);
    };
    const cache: Record<string, ClPoolMeta | null> = {};
    const checkedAt: Record<string, number> = {};
    await resolveClPoolMeta(POOL_ID, cache, checkedAt, call, 1000);
    await resolveClPoolMeta(POOL_ID, cache, checkedAt, call, 1e15);
    expect(hits).toBe(1);
  });

  it('does not cache anything on a transient RPC failure', async () => {
    const call = async (): Promise<string> => {
      throw new Error('timeout');
    };
    const cache: Record<string, ClPoolMeta | null> = {};
    expect(await resolveClPoolMeta(POOL_ID, cache, {}, call, 1000)).toBeNull();
    expect(POOL_ID in cache).toBe(false);
  });

  // A five-word answer is what Uniswap v4's poolKeys returns. Accepting it here
  // would decode `hooks` as the fee and MGR as the parameters, so the length check
  // is what stops a wrong-contract response being read as a valid pool.
  it('does not cache a short response, including a v4-shaped five-word one', async () => {
    const short =
      '0x' + word(USDT) + word(TOKEN) + word(HOOK) + word(MGR) + word('64');
    const cache: Record<string, ClPoolMeta | null> = {};
    expect(await resolveClPoolMeta(POOL_ID, cache, {}, async () => short, 1000)).toBeNull();
    expect(POOL_ID in cache).toBe(false);
    expect(await resolveClPoolMeta(POOL_ID, cache, {}, async () => '0x', 1000)).toBeNull();
    expect(POOL_ID in cache).toBe(false);
  });

  // The PoolId goes through as a full bytes32. Uniswap v4 needed it left-aligned
  // into a bytes25 with the low 7 bytes zeroed; doing that here would read the
  // wrong mapping slot and return an empty key.
  it('passes the full bytes32 PoolId, untruncated', async () => {
    let seen = '';
    const call = async (_to: string, data: string): Promise<string> => {
      seen = data;
      return poolKeyResult(USDT, TOKEN);
    };
    await resolveClPoolMeta(POOL_ID, {}, {}, call, 1000);
    expect(seen.slice(10)).toBe('ab'.repeat(32));
  });
});
