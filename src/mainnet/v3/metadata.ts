import { PoolMeta } from './swaps';
import { addressAt, addressArg, hasWords, uintArg, wordAt } from '../decode';
import { WETH, V3_FACTORY, SEL_TOKEN0, SEL_TOKEN1, SEL_FEE, SEL_GET_POOL } from '../config';

export type Caller = (to: string, data: string) => Promise<string>;

// Resolve a pool's WETH-paired metadata, cache-first. Caches `null` for pools that
// are not a genuine Uniswap v3 WETH pool so they aren't re-resolved. On a transient
// RPC error, returns `null` WITHOUT caching, so the next cycle retries.
//
// THE FACTORY CHECK IS MAINNET-SPECIFIC and has no counterpart in the Robinhood
// build. There, the v3 sweep is topic-only and every contract answering
// token0()/token1()/fee() with a WETH pair is taken at its word, because the chain
// has one Uniswap deployment and nothing else emitting that topic0. Mainnet does
// not have that luxury: SushiSwap v3 and a long tail of other v3 forks are
// byte-identical copies emitting the SAME Swap topic0 with the same ABI, so the
// unfiltered sweep picks them up and nothing downstream can tell them apart. Asking
// the canonical factory whether it minted this exact (token0, token1, fee) triple
// is the only cheap authoritative answer — one extra eth_call per pool, once,
// cached for the process' life alongside the reads it already makes.
export async function resolvePoolMeta(
  pool: string,
  cache: Record<string, PoolMeta | null>,
  call: Caller,
  anchor: string = WETH
): Promise<PoolMeta | null> {
  if (pool in cache) return cache[pool];
  try {
    const token0Raw = await call(pool, SEL_TOKEN0);
    const token1Raw = await call(pool, SEL_TOKEN1);
    // A contract that doesn't answer token0()/token1() at all isn't a v3 pool.
    // hasWords rejects the `0x` empty-return case, which addressAt would otherwise
    // decode into the zero address and carry forward as a real pairing.
    if (!hasWords(token0Raw, 1) || !hasWords(token1Raw, 1)) {
      cache[pool] = null;
      return null;
    }
    const token0 = addressAt(token0Raw, 0);
    const token1 = addressAt(token1Raw, 0);
    if (token0 !== anchor && token1 !== anchor) {
      cache[pool] = null; // confirmed no-anchor pool — cache the negative
      return null;
    }
    const feeRaw = await call(pool, SEL_FEE);
    if (!hasWords(feeRaw, 1)) {
      cache[pool] = null;
      return null;
    }
    const fee = Number(wordAt(feeRaw, 0));

    if (!(await isCanonicalV3Pool(pool, token0, token1, fee, call))) {
      cache[pool] = null; // a fork, or a contract impersonating the ABI
      return null;
    }

    const wethIsToken0 = token0 === anchor;
    const meta: PoolMeta = {
      pool,
      token: wethIsToken0 ? token1 : token0,
      fee,
      wethIsToken0,
    };
    cache[pool] = meta;
    return meta;
  } catch {
    return null; // transient — do not cache, retry next cycle
  }
}

// Does the canonical v3 factory agree that `pool` is the pool for this triple?
//
// Throws on a transient RPC failure rather than returning false: a false here is
// cached as a permanent "not Uniswap" negative, so a timed-out call must not be
// allowed to blacklist a genuine pool for the life of the process. The caller's
// try/catch turns the throw into an uncached retry.
export async function isCanonicalV3Pool(
  pool: string,
  token0: string,
  token1: string,
  fee: number,
  call: Caller
): Promise<boolean> {
  const data = SEL_GET_POOL + addressArg(token0) + addressArg(token1) + uintArg(fee);
  const result = await call(V3_FACTORY, data);
  if (!hasWords(result, 1)) return false;
  return addressAt(result, 0) === pool;
}
