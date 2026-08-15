import { DecodedClSwap } from './decode';
import { ClPoolMeta } from './metadata';
import { AnchorKind } from '../anchors';

export interface ClPoolAggregate {
  poolId: string;
  token: string;
  anchorKind: AnchorKind;
  volumeAnchor: bigint; // Σ |anchor-leg amount| over the window, in anchor base units
  swaps: number;
  traders: Set<string>;
  feesAnchor: bigint; // Σ |anchor-leg amount| * eventFee / 1e6
  lastSqrtPriceX96: bigint; // sqrtPriceX96 of the most recent swap in the window
  lastBlock: number; // block of the most recent swap in the window
  // Pips charged on the most recent swap, or undefined if none was plausible.
  //
  // Infinity has no fixed fee-tier ladder to read off the PoolKey the way v3 reads
  // fee(): a pool's hook sets the rate, and the PoolKey's own `fee` field does not
  // track what is actually charged (pools observed with key fee 67 were charging 99
  // pips). The rate in the Swap event is the real one, so the display label is taken
  // from there — for a static-fee pool that IS its tier, and for a hook-managed pool
  // it is the rate that just applied, which is the most honest thing available.
  lastFeePips?: bigint;
}

export function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

// The largest per-swap fee treated as real, in pips (1e6 = 100%). 10% is already far
// outside any legitimate tier — PancakeSwap's own top tier is 10000 pips = 1%.
//
// The Ethereum build guards only against the 0x800000 dynamic-fee FLAG leaking
// through, on the assumption that anything below 1e6 is a genuine rate. Infinity
// breaks that assumption: hooks set the fee per swap, and a live 300-block sample on
// 2026-08-15 contained five swaps reporting 980,310 pips — 98%. That is under 1e6, so
// the Ethereum guard admits it, and one such swap would dominate the fee column of
// whatever board it landed on. Volume is unaffected either way; only the fee figure
// is dropped, which is the conservative direction.
export const MAX_PLAUSIBLE_FEE_PIPS = BigInt(process.env.MOVERS_MAX_FEE_PIPS ?? '100000');

// Infinity amounts are int128 with a sign convention we don't rely on: the anchor-leg
// notional is |amount|, which is correct whether the anchor is the input or output
// side. The per-swap fee comes straight from the Swap event (word 5), so dynamic-fee
// and hook pools value correctly with no extra RPC — the reason this path needs no
// slot0 call while v3 does.
export function aggregateClSwaps(
  decoded: { poolId: string; swap: DecodedClSwap; block?: number }[],
  metaById: Map<string, ClPoolMeta>
): Map<string, ClPoolAggregate> {
  const out = new Map<string, ClPoolAggregate>();
  for (const { poolId, swap, block } of decoded) {
    const meta = metaById.get(poolId);
    if (!meta) continue;
    let agg = out.get(poolId);
    if (!agg) {
      agg = {
        poolId,
        token: meta.token,
        anchorKind: meta.anchorKind,
        volumeAnchor: 0n,
        swaps: 0,
        traders: new Set<string>(),
        feesAnchor: 0n,
        lastSqrtPriceX96: 0n,
        lastBlock: 0,
      };
      out.set(poolId, agg);
    }
    const anchorAmt = abs(meta.anchorIsCurrency0 ? swap.amount0 : swap.amount1);
    agg.volumeAnchor += anchorAmt;
    agg.swaps += 1;
    agg.traders.add(swap.sender);
    agg.lastSqrtPriceX96 = swap.sqrtPriceX96; // last swap in block/log order wins
    agg.lastBlock = block ?? 0;
    if (swap.fee <= MAX_PLAUSIBLE_FEE_PIPS) {
      agg.feesAnchor += (anchorAmt * swap.fee) / 1_000_000n;
      agg.lastFeePips = swap.fee;
    }
  }
  return out;
}

export interface ClRankedPool {
  poolId: string;
  token: string;
  anchorKind: AnchorKind;
  volumeAnchor: bigint;
  swaps: number;
  traders: number;
  feesAnchor: bigint;
  lastFeePips?: bigint;
}

export function rankClTopN(
  aggregates: Map<string, ClPoolAggregate>,
  topN: number
): ClRankedPool[] {
  return [...aggregates.values()]
    .map((a) => ({
      poolId: a.poolId,
      token: a.token,
      anchorKind: a.anchorKind,
      volumeAnchor: a.volumeAnchor,
      swaps: a.swaps,
      traders: a.traders.size,
      feesAnchor: a.feesAnchor,
      lastFeePips: a.lastFeePips,
    }))
    .sort((x, y) =>
      y.volumeAnchor > x.volumeAnchor ? 1 : y.volumeAnchor < x.volumeAnchor ? -1 : 0
    )
    .slice(0, topN);
}
