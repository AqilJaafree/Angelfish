// Which currencies count as the "quote" side of a pair, and what each one is worth.
//
// ---------------------------------------------------------------------------
// THIS MODULE HAS NO COUNTERPART IN THE ETHEREUM BUILD, and it is the single
// place where the port stops being a rename.
//
// On Ethereum the anchor is WETH, full stop: one currency, so a pool's "volume"
// is unambiguously an amount of wei and the whole pipeline can carry a single
// `volumeWeth: bigint` from aggregation to render. BSC has no equivalent. WBNB is
// not the centre of gravity here — USD stables are — and neither alone is enough.
// Measured over a 300-block window on 2026-08-15:
//
//   PancakeSwap v3 (264 pools, 3,530 swaps)   Infinity CL (100 pools, 4,232 swaps)
//     BNB only     82 pools, 76 tokens          18 pools, 1,502 swaps
//     USDT only   139 pools, 122 tokens         72 pools, 2,512 swaps
//     both + USDC/USD1                          84 pools, 3,729 swaps (88%)
//                 225 pools, 185 tokens
//
// A straight WBNB-for-WETH substitution would therefore have quietly indexed about
// 40% of the chain and produced a board that looked fine.
// ---------------------------------------------------------------------------
//
// The consequence is that "volume" is no longer one unit. It is handled by keeping
// aggregates in RAW ANCHOR UNITS (a pool always uses the same anchor, so its own
// spike baseline stays self-consistent) and converting to USD once, at render time.
// See toUsd below.

import { NATIVE_BNB, USD1, USDC, USDT, WBNB } from './config';

// A USD anchor's pool price IS the USD price; a BNB anchor's needs the BNB/USD rate.
export type AnchorKind = 'usd' | 'bnb';

// Every anchor on BSC is 18 decimals — WBNB, USDT, USDC, USD1 and BUSD all verified
// by decimals(). That is why no per-anchor scaling appears anywhere below: a raw
// stable amount is already a USD amount in 1e18 fixed point.
export const ANCHORS: ReadonlyMap<string, AnchorKind> = new Map([
  [NATIVE_BNB, 'bnb'],
  [WBNB, 'bnb'],
  [USDT, 'usd'],
  [USDC, 'usd'],
  [USD1, 'usd'],
]);

export function isAnchor(currency: string): boolean {
  return ANCHORS.has(currency.toLowerCase());
}

// --- Board routing ---
//
// Which anchor a pool is quoted in decides WHICH board it lands on. There are two,
// one per Telegram topic: WBNB pairs and USDT pairs. Both are PancakeSwap v3 — the
// split is by quote currency, not by DEX version.
//
// THIS MAP IS DELIBERATELY NARROWER THAN THE ANCHOR SET ABOVE. USDC and USD1 must
// stay anchors: that is what stops a USDC/WBNB pool from being read as a pool
// "about" USDC and printed as a mover. But a TOKEN/USDC pool is not a USDT pair,
// and putting it under a USDT header would assert something untrue — the rows
// render a symbol and an address, never the quote side, so nothing downstream
// could correct the impression. Such pools are therefore indexed (their candles
// and volume baselines keep accruing) and then left off both boards. It is a thin
// slice: a 300-block v3 sample on 2026-08-15 held 82 BNB-anchored and 139
// USDT-anchored pools out of 225 anchored ones. The worker logs the count each
// cycle rather than discarding them silently.
export type BoardKey = 'wbnb' | 'usdt';

const BOARD_BY_ANCHOR: ReadonlyMap<string, BoardKey> = new Map([
  // v3 has no native currency — only Infinity quotes address(0) — but routing it
  // here costs nothing and keeps the two paths answering the same question.
  [NATIVE_BNB, 'wbnb'],
  [WBNB, 'wbnb'],
  [USDT, 'usdt'],
]);

export function boardForAnchor(anchor: string): BoardKey | undefined {
  return BOARD_BY_ANCHOR.get(anchor.toLowerCase());
}

// Board order is publish order, so it is also the order the two topics get posted
// in. The label rides on the board itself: it is what the Danger Zone header and
// the stdout renderer name the source.
export const BOARDS: ReadonlyArray<{ key: BoardKey; label: string }> = [
  { key: 'wbnb', label: 'PancakeSwap v3 (WBNB pairs)' },
  { key: 'usdt', label: 'PancakeSwap v3 (USDT pairs)' },
];

export interface AnchorSide {
  anchor: string; // the anchor currency's address
  kind: AnchorKind;
  token: string; // the other side — the token the board is actually about
  anchorIsCurrency0: boolean;
}

// Pick the anchor side of a pair, or null if this pool has no subject token.
//
// The test is an XOR, not an "either side is an anchor". A pool with anchors on BOTH
// sides — USDT/USDC, WBNB/USDT, native BNB/USDT — is a stable or majors pair with no
// subject token at all, and admitting it would put USDT itself on a Top Movers board
// ranked by its own trading against USDC. On BSC that is not a rare edge case: the
// WBNB/USDT pools are among the busiest on the chain, so this branch fires constantly.
export function anchorSide(currency0: string, currency1: string): AnchorSide | null {
  const c0 = currency0.toLowerCase();
  const c1 = currency1.toLowerCase();
  const k0 = ANCHORS.get(c0);
  const k1 = ANCHORS.get(c1);
  if ((k0 != null) === (k1 != null)) return null; // both or neither — no subject token
  return k0 != null
    ? { anchor: c0, kind: k0, token: c1, anchorIsCurrency0: true }
    : { anchor: c1, kind: k1!, token: c0, anchorIsCurrency0: false };
}

// Anchor base units -> USD, in the same 1e18 fixed point.
//
// A 'usd' anchor is already there and is returned untouched — no float ever touches
// the 139-of-264 v3 pools quoted in stables, and they keep working even when the
// BNB/USD read fails.
//
// bnbUsd arrives as a float (it comes from a sqrtPriceX96 ratio). It is folded in as
// a scaled integer rather than by converting the amount to Number first: a window's
// volume routinely exceeds 2^53 base units, where Number() starts silently dropping
// low-order digits.
const RATE_SCALE = 1_000_000n;

export function toUsd(
  amount: bigint,
  kind: AnchorKind,
  bnbUsd: number | undefined
): bigint | undefined {
  if (kind === 'usd') return amount;
  if (bnbUsd == null || !(bnbUsd > 0) || !Number.isFinite(bnbUsd)) return undefined;
  return (amount * BigInt(Math.round(bnbUsd * Number(RATE_SCALE)))) / RATE_SCALE;
}
