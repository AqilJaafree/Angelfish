// Per-pool volume history, bucketed on the same block-count buckets as the
// candles so "the last N buckets" means the same thing to both.
//
// This is what lets the boards rank on a volume SPIKE rather than absolute
// volume. Absolute volume is a near-constant property of a pool — USDC/WETH is
// the most heavily traded pool on almost every window, which is exactly what
// makes it uninteresting on a movers board. A pool's volume relative to its own
// recent baseline is the thing that actually changes when something happens.

// Volumes here are in the pool's own ANCHOR base units (18 decimals), never USD.
//
// That is a deliberate choice on BSC, where different pools have different anchors.
// A pool always uses the same anchor, so a baseline built from its own history is
// self-consistent whatever that anchor is — and, critically, recording it in anchor
// units means a failed BNB/USD read cannot corrupt the history. Converting first
// would skip the BNB-anchored pools for that cycle, and recordVolume zero-fills
// skipped buckets, so a transient price failure would understate those pools'
// baselines and inflate their next spike — the exact fault the zero-fill exists to
// avoid. USD is applied later, for ranking and display only.
export interface VolumeBucket {
  volume: string; // bigint does not survive JSON
  blocks: number;
}

export interface VolumeState {
  bucket: number; // block-count bucket id of the forming window
  volume: string; // accumulated so far IN the forming bucket
  blocks: number; // blocks contributed to the forming bucket
  history: VolumeBucket[]; // finalized buckets, oldest → newest, capped
}

export const MAX_HISTORY_BUCKETS = 24; // ~2h at 667 blocks/bucket (5 min each)
export const MAX_TRACKED_POOLS = 500; // LRU bound, mirroring candles.ts

// Finalized buckets needed before a pool's baseline is trusted. Below this a
// pool has no score and falls back to volume ranking — a baseline drawn from
// one or two samples is noise, and would let any pool claim a huge multiple on
// its second ever trade.
export const MIN_BASELINE_BUCKETS = parseInt(process.env.SPIKE_MIN_BUCKETS ?? '3', 10);

// Scores are clamped here. A pool whose baseline is genuinely zero (it did not
// trade at all across its whole history) would otherwise divide by zero; that
// case is a real spike, so it gets the ceiling rather than being discarded.
export const MAX_SPIKE = 999;

// A pool must move at least this much in the window to be eligible for a spike
// score. Without a floor, a pool that normally trades dust tops the board on a
// 400x multiple of nothing — the arithmetic is right and the row is worthless.
// Pools below the floor fall back to volume ranking.
//
// In USD (18 decimals), not anchor units — unlike the baseline itself. A floor has
// to mean the same thing to every pool to be a floor at all, and on BSC "0.05 of
// the anchor" is $45 for a BNB pool and five cents for a USDT one, so an
// anchor-denominated floor would gate the two sides of the same board three orders
// of magnitude apart.
export const MIN_SPIKE_VOLUME_USD = BigInt(
  process.env.SPIKE_MIN_VOLUME_USD ?? '50000000000000000000' // $50
);

function toBigInt(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

// Accumulates rather than overwrites: a cycle sweeps ~10 blocks but a bucket
// spans 25, so one bucket receives several windows.
//
// Skipped buckets are filled with ZERO volume over a full bucket of blocks —
// the opposite of the candles, which forward-fill the last price. A pool that
// did not trade for an hour genuinely had no volume in that hour, and dropping
// those buckets instead of zero-filling would compute the baseline only over
// windows where it happened to trade. That overstates the baseline of exactly
// the quiet pools whose sudden activity is worth surfacing.
export function recordVolume(
  store: Record<string, VolumeState>,
  key: string,
  bucket: number,
  volumeWei: bigint,
  blocks: number,
  blocksPerBucket: number
): void {
  const prev = store[key];
  let next: VolumeState;
  if (!prev) {
    next = { bucket, volume: volumeWei.toString(), blocks, history: [] };
  } else if (bucket === prev.bucket) {
    next = {
      ...prev,
      volume: (toBigInt(prev.volume) + volumeWei).toString(),
      blocks: prev.blocks + blocks,
    };
  } else if (bucket > prev.bucket) {
    const history = [...prev.history, { volume: prev.volume, blocks: prev.blocks }];
    for (let i = 1; i < bucket - prev.bucket && history.length < MAX_HISTORY_BUCKETS; i++) {
      history.push({ volume: '0', blocks: blocksPerBucket });
    }
    if (history.length > MAX_HISTORY_BUCKETS) {
      history.splice(0, history.length - MAX_HISTORY_BUCKETS);
    }
    next = { bucket, volume: volumeWei.toString(), blocks, history };
  } else {
    return; // out-of-order / reorg: ignore
  }
  // delete + reassign moves the key to the end of insertion order for LRU.
  delete store[key];
  store[key] = next;
  const keys = Object.keys(store);
  if (keys.length > MAX_TRACKED_POOLS) {
    for (const k of keys.slice(0, keys.length - MAX_TRACKED_POOLS)) delete store[k];
  }
}

// Mean wei-per-block across the finalized history. Undefined when there is not
// enough history to mean anything.
//
// Deliberately a RATE, not a per-bucket total. Windows are not a fixed size —
// steady state sweeps ~10 blocks, a cold start clamps to MAX_LOOKBACK_BLOCKS
// (300), and a bucket spans 25 — so comparing raw totals would mostly measure
// how many blocks each side happened to cover.
export function baselineRate(state: VolumeState | undefined): number | undefined {
  if (!state || state.history.length < MIN_BASELINE_BUCKETS) return undefined;
  let volume = 0;
  let blocks = 0;
  for (const b of state.history) {
    volume += Number(toBigInt(b.volume));
    blocks += b.blocks;
  }
  if (blocks <= 0) return undefined;
  return volume / blocks;
}

// How many times its own baseline rate this pool is trading at right now.
// Undefined = not scoreable (too little history, or too little volume to be
// worth scoring); the caller ranks those by volume instead.
//
// `windowVolume` is in anchor units, matching the recorded history — the ratio it
// forms is unit-free, so the anchor cancels. `windowVolumeUsd` is used ONLY for the
// eligibility floor, which has to be a single currency to be comparable across
// pools; it defaults to windowVolume so a single-anchor caller (or a test) can omit
// it. An unknown USD value fails the floor rather than bypassing it: a pool whose
// volume cannot be valued has not been shown to clear the bar.
export function spikeScore(
  state: VolumeState | undefined,
  windowVolume: bigint,
  windowBlocks: number,
  windowVolumeUsd: bigint | undefined = windowVolume
): number | undefined {
  if (windowVolumeUsd === undefined || windowVolumeUsd < MIN_SPIKE_VOLUME_USD) return undefined;
  if (windowBlocks <= 0) return undefined;
  const baseline = baselineRate(state);
  if (baseline === undefined) return undefined;
  const rate = Number(windowVolume) / windowBlocks;
  if (!(rate > 0)) return undefined;
  // A zero baseline is a pool that did not trade at all across its history.
  // That is the strongest possible spike, not an error.
  if (baseline <= 0) return MAX_SPIKE;
  const score = rate / baseline;
  if (!Number.isFinite(score)) return MAX_SPIKE;
  return Math.min(score, MAX_SPIKE);
}

// Rank scored pools above unscored ones.
//
// Two tiers rather than one: a pool still warming up has no defensible score,
// and inventing one (0, or 1, or its raw volume) would either bury every new
// pool or let it jump the queue. Ranking the scoreable ones first by spike and
// the rest by volume keeps the board populated during warm-up — the first ~15
// minutes after a cold start, when nothing has a baseline yet — without
// pretending the unscored rows earned their place.
// `volumeOf` must return a COMPARABLE volume — USD, not anchor units. The rows
// being ordered here come from different pools with different anchors, so sorting
// on raw anchor amounts would rank one BNB above one thousand USDT. Undefined (a
// volume that could not be valued) sorts last rather than as zero, so an unpriceable
// row never displaces one that is merely small.
// Rank by raw swap count: the busiest pool in the window first.
//
// The sibling of sortBySpike, and the default — see MOVERS_RANK_BY in config.ts for
// the trade-off between them. Two structural differences from the spike ranking:
//
// There is no warming-up tier. Every pool in the window has a swap count by
// construction, so nothing is unrankable and no row has to be parked behind the
// others while it accumulates history. A pool is rankable on its first ever trade.
//
// Ties are broken by USD volume rather than left to input order, because on a
// 300-block window ties are the COMMON case, not the edge one: the tail is mostly
// 1- and 2-swap pools. Without a tiebreak their order would be whatever the sweep
// happened to return and would reshuffle every cycle for no reason. USD and not
// anchor units, since these rows come from pools with different anchors — an
// anchor-unit tiebreak would rank one BNB above a thousand USDT. An unpriceable
// volume sorts last rather than as zero, so it never displaces a merely small one.
export function sortBySwaps<T>(
  rows: T[],
  swapsOf: (row: T) => number,
  volumeOf: (row: T) => bigint | undefined
): T[] {
  return [...rows].sort((a, b) => {
    const bySwaps = swapsOf(b) - swapsOf(a);
    if (bySwaps !== 0) return bySwaps;
    const [x, y] = [volumeOf(a), volumeOf(b)];
    if (x === undefined) return y === undefined ? 0 : 1;
    if (y === undefined) return -1;
    return y > x ? 1 : y < x ? -1 : 0;
  });
}

export function sortBySpike<T>(
  rows: T[],
  scoreOf: (row: T) => number | undefined,
  volumeOf: (row: T) => bigint | undefined
): Array<T & { spike?: number }> {
  const scored: Array<T & { spike?: number }> = [];
  const unscored: Array<T & { spike?: number }> = [];
  for (const row of rows) {
    const spike = scoreOf(row);
    if (spike === undefined) unscored.push({ ...row, spike: undefined });
    else scored.push({ ...row, spike });
  }
  scored.sort((a, b) => (b.spike ?? 0) - (a.spike ?? 0));
  unscored.sort((a, b) => {
    const [x, y] = [volumeOf(a), volumeOf(b)];
    if (x === undefined) return y === undefined ? 0 : 1;
    if (y === undefined) return -1;
    return y > x ? 1 : y < x ? -1 : 0;
  });
  return [...scored, ...unscored];
}
