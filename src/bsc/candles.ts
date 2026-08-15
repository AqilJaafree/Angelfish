// Per-pool 5-minute candle state, keyed by a fixed block-count bucket. Each pool
// keeps its finalized closes plus the still-forming candle. Tradeless buckets are
// forward-filled with the last close so candle spacing stays uniform (RSI needs
// contiguous periods). The number of tracked pools is LRU-bounded.
export interface CandleState {
  bucket: number; // block-count bucket id of the forming candle
  close: number; // latest price seen in the forming bucket
  closes: number[]; // finalized candle closes (oldest → newest), capped
}

export const MAX_CLOSES = 30; // finalized closes kept per pool
export const MAX_TRACKED_POOLS = 500; // LRU bound on tracked pools

export function recordSwapPrice(
  store: Record<string, CandleState>,
  key: string,
  bucket: number,
  price: number
): void {
  const prev = store[key];
  let next: CandleState;
  if (!prev) {
    next = { bucket, close: price, closes: [] };
  } else if (bucket === prev.bucket) {
    next = { bucket, close: price, closes: prev.closes }; // update forming close
  } else if (bucket > prev.bucket) {
    const closes = [...prev.closes, prev.close]; // finalize the forming candle
    // Forward-fill skipped (tradeless) buckets with the last close, capped.
    for (let i = 1; i < bucket - prev.bucket && closes.length < MAX_CLOSES; i++) {
      closes.push(prev.close);
    }
    if (closes.length > MAX_CLOSES) closes.splice(0, closes.length - MAX_CLOSES);
    next = { bucket, close: price, closes };
  } else {
    return; // out-of-order / reorg: ignore
  }
  // delete + reassign moves the key to the end of insertion order (V8 preserves
  // string-key order) so it counts as most-recently-updated for LRU eviction.
  delete store[key];
  store[key] = next;
  const keys = Object.keys(store);
  if (keys.length > MAX_TRACKED_POOLS) {
    for (const k of keys.slice(0, keys.length - MAX_TRACKED_POOLS)) delete store[k];
  }
}
