import { RawLog, addressAt, hasWords, toBytes25Arg, wordAt } from '../decode';
import { decodeV4InitializeLog } from './decode';
import { ETH_CURRENCIES, SEL_POOL_KEYS, V4_POSITION_MANAGER } from '../config';

export interface V4PoolMeta {
  poolId: string; // bytes32
  token: string; // the non-anchor currency address (lowercase)
  ethIsCurrency0: boolean; // true if the anchor (ETH) leg is currency0
  fee: number; // static tier in pips, or 0x800000 = dynamic-fee flag
}

export type Caller = (to: string, data: string) => Promise<string>;

// How long an unresolved PoolId is left alone before being retried. A pool that
// answers neither poolKeys nor a recent Initialize is almost certainly one that
// was initialized directly on the PoolManager before this process started — a
// permanent condition — but caching that forever would also permanently drop a
// pool we merely failed to see, so the negative expires.
export const UNRESOLVED_TTL_MS = parseInt(
  process.env.V4_UNRESOLVED_TTL_MS ?? String(24 * 60 * 60 * 1000),
  10
);

// Fold Initialize logs into the registry. Called by the worker with the logs from
// the SAME block window it sweeps for swaps.
//
// THIS IS THE MAINNET REPLACEMENT for the Robinhood build's per-PoolId
// `getLogs(fromBlock: 1, toBlock: head)` scan. That works there because the chain
// is young and the node accepts an unbounded range; on mainnet the free endpoints
// cap eth_getLogs at 10 blocks, so scanning back to the v4 deploy block
// (21,688,329 — over 4 million blocks ago) would cost ~400,000 requests PER
// UNKNOWN POOL. Indexing forward from the window we already fetch costs one extra
// getLogs per chunk and catches every pool created from now on.
export function indexInitializeLogs(
  registry: Record<string, V4PoolMeta | null>,
  logs: RawLog[],
  anchors: Set<string> = ETH_CURRENCIES
): number {
  let added = 0;
  for (const log of logs) {
    if (log.topics.length < 4) continue; // malformed — Initialize indexes 3 fields
    const init = decodeV4InitializeLog(log);
    const meta = metaFromCurrencies(init.poolId, init.currency0, init.currency1, Number(init.fee), anchors);
    // A confirmed non-anchor pool is stored as `null` so it is never looked up
    // again — the same negative-caching the on-demand path uses.
    if (!(init.poolId in registry)) added++;
    registry[init.poolId] = meta;
  }
  return added;
}

function metaFromCurrencies(
  poolId: string,
  currency0: string,
  currency1: string,
  fee: number,
  anchors: Set<string>
): V4PoolMeta | null {
  const c0IsEth = anchors.has(currency0);
  const c1IsEth = anchors.has(currency1);
  if (!c0IsEth && !c1IsEth) return null;
  return {
    poolId,
    token: c0IsEth ? currency1 : currency0,
    ethIsCurrency0: c0IsEth,
    fee,
  };
}

// Resolve a PoolId's anchor-paired metadata, cache-first.
//
// v4 pools are not contracts, so token0()/token1() can't be called, and a PoolId
// is keccak256(abi.encode(PoolKey)) — one-way, so the key cannot be recovered by
// arithmetic. The Robinhood build recovers it from the Initialize log; here the
// primary source is instead PositionManager's `poolKeys(bytes25)` mapping, which
// stores the PoolKey against the truncated id precisely so it can be read back.
// One eth_call, no log range to negotiate, works for any pool however old —
// measured on mainnet at 50 of 52 PoolIds resolved from a live 9-block window.
//
// The two it misses are pools initialized directly on the PoolManager rather than
// through PositionManager; those are covered by indexInitializeLogs above going
// forward, and otherwise fall to the TTL'd negative below.
export async function resolveV4PoolMeta(
  poolId: string,
  cache: Record<string, V4PoolMeta | null>,
  checkedAt: Record<string, number>,
  call: Caller,
  now: number = Date.now(),
  anchors: Set<string> = ETH_CURRENCIES
): Promise<V4PoolMeta | null> {
  if (poolId in cache) {
    const hit = cache[poolId];
    // A positive is permanent (a PoolKey is immutable). A negative expires.
    if (hit !== null) return hit;
    if (now - (checkedAt[poolId] ?? 0) < UNRESOLVED_TTL_MS) return null;
  }
  try {
    const raw = await call(V4_POSITION_MANAGER, SEL_POOL_KEYS + toBytes25Arg(poolId));
    // PoolKey = (address currency0, address currency1, uint24 fee, int24
    // tickSpacing, address hooks).
    if (!hasWords(raw, 5)) return null; // transient/garbage — do not cache
    const currency0 = addressAt(raw, 0);
    const currency1 = addressAt(raw, 1);
    const fee = Number(wordAt(raw, 2));
    const tickSpacing = wordAt(raw, 3);
    // An unknown id reads back as an all-zero key. currency0 == address(0) is
    // LEGITIMATE (native ETH), so emptiness must be judged on tickSpacing, which
    // every real PoolKey has non-zero.
    if (tickSpacing === 0n) {
      cache[poolId] = null;
      checkedAt[poolId] = now;
      return null;
    }
    const meta = metaFromCurrencies(poolId, currency0, currency1, fee, anchors);
    cache[poolId] = meta; // caches the negative for a confirmed non-anchor pair
    checkedAt[poolId] = now;
    return meta;
  } catch {
    return null; // transient — do not cache, retry next cycle
  }
}
