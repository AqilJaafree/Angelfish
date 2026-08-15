import { addressAt, bytes32Arg, hasWords, wordAt } from '../decode';
import { anchorSide, AnchorKind } from '../anchors';
import { ManyCaller, sequentialCallMany } from '../rpc';
import { CL_POOL_MANAGER, SEL_POOL_ID_TO_KEY } from '../config';

export interface ClPoolMeta {
  poolId: string; // bytes32
  token: string; // the non-anchor currency address (lowercase)
  anchor: string; // which anchor currency this pool is quoted in
  anchorKind: AnchorKind; // 'usd' -> already USD; 'bnb' -> needs the BNB/USD rate
  anchorIsCurrency0: boolean;
}

export type Caller = (to: string, data: string) => Promise<string>;

// How long an unresolved PoolId is left alone before being retried. In practice this
// path is close to unreachable — see the note below — but a permanent negative on a
// pool we merely failed to read once would drop it for the life of the process.
export const UNRESOLVED_TTL_MS = parseInt(
  process.env.CL_UNRESOLVED_TTL_MS ?? String(24 * 60 * 60 * 1000),
  10
);

// Resolve a PoolId's anchor-paired metadata, cache-first.
//
// Infinity pools are not contracts, so token0()/token1() cannot be called, and a
// PoolId is keccak256(abi.encode(PoolKey)) — one-way, so the key cannot be recovered
// by arithmetic. It is read back from CLPoolManager's own `poolIdToPoolKey` mapping.
//
// THIS IS SUBSTANTIALLY BETTER THAN THE UNISWAP v4 EQUIVALENT and the difference
// removes a whole subsystem. On Ethereum the key lives on the PositionManager, keyed
// by a TRUNCATED bytes25, and only covers pools that were initialized THROUGH the
// PositionManager — measured at 50 of 52 live PoolIds, so the Ethereum build carries
// an Initialize-log indexer as a second source for the stragglers. Infinity stores
// the key on the PoolManager itself, against the full bytes32, written on every
// initialize regardless of route: measured at 107 of 107 live PoolIds on 2026-08-15.
// There is no second source here because there is nothing for it to catch.
export async function resolveClPoolMetas(
  poolIds: string[],
  cache: Record<string, ClPoolMeta | null>,
  checkedAt: Record<string, number>,
  callMany: ManyCaller,
  now: number = Date.now()
): Promise<Map<string, ClPoolMeta>> {
  const out = new Map<string, ClPoolMeta>();
  const pending: string[] = [];
  for (const poolId of poolIds) {
    if (poolId in cache) {
      const hit = cache[poolId];
      // A positive is permanent (a PoolKey is immutable). A negative expires.
      if (hit !== null) {
        out.set(poolId, hit);
        continue;
      }
      if (now - (checkedAt[poolId] ?? 0) < UNRESOLVED_TTL_MS) continue;
    }
    if (!pending.includes(poolId)) pending.push(poolId);
  }
  if (pending.length === 0) return out;

  // One batched round-trip for every unknown id — see rpc.callMany for why this is
  // batched rather than a call each.
  const raws = await callMany(
    pending.map((poolId) => ({
      to: CL_POOL_MANAGER,
      data: SEL_POOL_ID_TO_KEY + bytes32Arg(poolId),
    }))
  );
  for (let i = 0; i < pending.length; i++) {
    const poolId = pending[i];
    const raw = raws[i];
    if (raw === null) continue; // transient — do not cache, retry next cycle
    // PoolKey = (Currency currency0, Currency currency1, IHooks hooks,
    //            IPoolManager poolManager, uint24 fee, bytes32 parameters).
    // Six words, against Uniswap v4's five — `hooks` moves from last to third and
    // `poolManager`/`parameters` are new, so the offsets are NOT interchangeable.
    if (!hasWords(raw, 6)) continue; // garbage — do not cache
    const currency0 = addressAt(raw, 0);
    const currency1 = addressAt(raw, 1);
    const parameters = wordAt(raw, 5);
    // An unknown id reads back as an all-zero key. currency0 == address(0) is
    // LEGITIMATE (native BNB), so emptiness is judged on `parameters`, which encodes
    // the tick spacing and hook flags and is non-zero for every real pool.
    if (parameters === 0n) {
      cache[poolId] = null;
      checkedAt[poolId] = now;
      continue;
    }
    const side = anchorSide(currency0, currency1);
    // Caches the negative for a confirmed non-anchor or anchor/anchor pair.
    const meta: ClPoolMeta | null = side && {
      poolId,
      token: side.token,
      anchor: side.anchor,
      anchorKind: side.kind,
      anchorIsCurrency0: side.anchorIsCurrency0,
    };
    cache[poolId] = meta;
    checkedAt[poolId] = now;
    if (meta) out.set(poolId, meta);
  }
  return out;
}

// Single-id convenience wrapper over the batched path above, so there is exactly
// one implementation of the decode and caching rules.
export async function resolveClPoolMeta(
  poolId: string,
  cache: Record<string, ClPoolMeta | null>,
  checkedAt: Record<string, number>,
  call: Caller,
  now: number = Date.now()
): Promise<ClPoolMeta | null> {
  const found = await resolveClPoolMetas(
    [poolId],
    cache,
    checkedAt,
    sequentialCallMany(call),
    now
  );
  return found.get(poolId) ?? null;
}
