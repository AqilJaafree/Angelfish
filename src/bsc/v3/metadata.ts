import { PoolMeta } from './swaps';
import { addressAt, addressArg, hasWords, uintArg, wordAt } from '../decode';
import { anchorSide } from '../anchors';
import { CallRequest, ManyCaller, sequentialCallMany } from '../rpc';
import { V3_FACTORY, SEL_TOKEN0, SEL_TOKEN1, SEL_FEE, SEL_GET_POOL } from '../config';

export type Caller = (to: string, data: string) => Promise<string>;

// Resolve many pools' anchor-paired metadata at once, cache-first.
//
// BATCHED IN THREE PHASES rather than four sequential calls per pool, because on
// BSC this is the indexer's dominant cost: a 300-block window surfaces 200–250
// distinct pools where the same window on Ethereum surfaces ~40, and the long tail
// means most are new each cycle rather than cache hits. Sequentially that measured
// ~191s against a 120s poll — the indexer could not keep pace with the chain. See
// rpc.callMany.
//
// The phases narrow at each step, so the factory check — the most expensive one to
// get wrong — only ever runs on pools that already look like anchored v3 pools.
//
// Caching rules are exactly those of the single-pool path below, and the
// distinction they rest on is that a batch reports a per-item FAILURE as `null`
// while a contract that simply has nothing to say answers `0x`. A null is transient
// and must never be cached; a `0x` is a definitive "not a v3 pool" and must be.
export async function resolvePoolMetas(
  pools: string[],
  cache: Record<string, PoolMeta | null>,
  callMany: ManyCaller
): Promise<Map<string, PoolMeta>> {
  const out = new Map<string, PoolMeta>();
  const pending: string[] = [];
  for (const pool of pools) {
    if (pool in cache) {
      const hit = cache[pool];
      if (hit) out.set(pool, hit);
    } else if (!pending.includes(pool)) {
      pending.push(pool);
    }
  }
  if (pending.length === 0) return out;

  // Phase 1 — token0() and token1() for every unknown pool.
  const pairReqs: CallRequest[] = [];
  for (const pool of pending) {
    pairReqs.push({ to: pool, data: SEL_TOKEN0 }, { to: pool, data: SEL_TOKEN1 });
  }
  const pairs = await callMany(pairReqs);

  interface Candidate {
    pool: string;
    token0: string;
    token1: string;
    side: NonNullable<ReturnType<typeof anchorSide>>;
  }
  const candidates: Candidate[] = [];
  for (let i = 0; i < pending.length; i++) {
    const pool = pending[i];
    const t0Raw = pairs[i * 2];
    const t1Raw = pairs[i * 2 + 1];
    if (t0Raw === null || t1Raw === null) continue; // transient — do not cache
    // A contract that doesn't answer token0()/token1() at all isn't a v3 pool.
    // hasWords rejects the `0x` case, which addressAt would otherwise decode into
    // the zero address and carry forward as a real pairing.
    if (!hasWords(t0Raw, 1) || !hasWords(t1Raw, 1)) {
      cache[pool] = null;
      continue;
    }
    const token0 = addressAt(t0Raw, 0);
    const token1 = addressAt(t1Raw, 0);
    // Anchor selection is an XOR over the anchor SET, not a match against one
    // currency — see anchors.ts. A WBNB/USDT pool has an anchor on both sides and
    // is dropped here, which on BSC discards some of the busiest pools on the chain
    // and is exactly right: neither side is a token the board is about.
    const side = anchorSide(token0, token1);
    if (!side) {
      cache[pool] = null; // confirmed no-subject-token pool — cache the negative
      continue;
    }
    candidates.push({ pool, token0, token1, side });
  }
  if (candidates.length === 0) return out;

  // Phase 2 — fee() for the pools that survived.
  const fees = await callMany(candidates.map((c) => ({ to: c.pool, data: SEL_FEE })));
  const verified: Array<Candidate & { fee: number }> = [];
  for (let i = 0; i < candidates.length; i++) {
    const raw = fees[i];
    if (raw === null) continue; // transient — do not cache
    if (!hasWords(raw, 1)) {
      cache[candidates[i].pool] = null;
      continue;
    }
    verified.push({ ...candidates[i], fee: Number(wordAt(raw, 0)) });
  }
  if (verified.length === 0) return out;

  // Phase 3 — ask the canonical factory to confirm each pool.
  //
  // THE FACTORY CHECK IS LOAD-BEARING. The v3 sweep is topic-only, and PancakeSwap
  // v3 has a long tail of byte-identical forks emitting the SAME Swap topic0 with
  // the same ABI — the unfiltered sweep picks them all up and nothing downstream
  // can tell them apart. Asking the factory whether it minted this exact
  // (token0, token1, fee) triple is the only cheap authoritative answer.
  const checks = await callMany(
    verified.map((v) => ({
      to: V3_FACTORY,
      data: SEL_GET_POOL + addressArg(v.token0) + addressArg(v.token1) + uintArg(v.fee),
    }))
  );
  for (let i = 0; i < verified.length; i++) {
    const v = verified[i];
    const raw = checks[i];
    // A failed verification must NOT be cached as a negative: that would blacklist
    // a genuine pool for the life of the process on the strength of one timeout.
    if (raw === null) continue;
    if (!hasWords(raw, 1) || addressAt(raw, 0) !== v.pool) {
      cache[v.pool] = null; // a fork, or a contract impersonating the ABI
      continue;
    }
    const meta: PoolMeta = {
      pool: v.pool,
      token: v.side.token,
      anchor: v.side.anchor,
      anchorKind: v.side.kind,
      fee: v.fee,
      anchorIsToken0: v.side.anchorIsCurrency0,
    };
    cache[v.pool] = meta;
    out.set(v.pool, meta);
  }
  return out;
}

// Single-pool convenience wrapper over the batched path above, so there is exactly
// one implementation of the caching and fork-rejection rules.
export async function resolvePoolMeta(
  pool: string,
  cache: Record<string, PoolMeta | null>,
  call: Caller
): Promise<PoolMeta | null> {
  const found = await resolvePoolMetas([pool], cache, sequentialCallMany(call));
  return found.get(pool) ?? null;
}
