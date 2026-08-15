export type RiskLevel = 'clean' | 'caution' | 'high' | 'unknown';

export interface AuditResult {
  verified: boolean; // explorer source present → drives the ✅ / ⚠️ badge
  risk: RiskLevel; // heuristic source-scan result → drives the risk light
  // Which rules the source scan actually hit, e.g. ['has-mint','upgradeable'].
  // The boards render only the risk light — one glyph per row is all a board
  // has space for — but a caller about to commit funds to a token wants to know
  // WHY it is red, so the detail is carried rather than discarded.
  // Optional: absent on an unverified token (no source to scan) and on results
  // cached by an earlier build.
  flags?: string[];
}

// One row of a Top Movers board. Shared by the v3 and Infinity workers so a single
// renderer serves both — `pool` holds a pool address on v3 and a bytes32 PoolId on
// Infinity, which is the only shape difference between the two.
export interface MoversRow {
  pool: string; // v3: pool address (lowercase). Infinity: bytes32 PoolId.
  token: string; // the non-anchor token address (lowercase)
  symbol: string; // resolved token symbol (or short-address fallback)
  // Window volume and fees in USD, as bigints in 1e18 fixed point.
  //
  // USD rather than an amount of the anchor currency, because on BSC pools do not
  // share one anchor: a row may be quoted in BNB, USDT, USDC or USD1 (see
  // bsc/anchors.ts), so an anchor-denominated figure would be incomparable between
  // two rows of the same board. `undefined` means the value could not be converted —
  // only reachable for a BNB-anchored pool when the BNB/USD read failed — and
  // renders as a dash rather than a zero.
  volumeUsd?: bigint;
  swaps: number; // number of Swap events
  traders: number; // unique swapper addresses
  feesUsd?: bigint;
  verified?: boolean; // explorer contract verification (drives ✅ / ⚠️)
  risk?: RiskLevel; // heuristic audit risk light (drives 🟢/🟡/🔴/⬜)
  feeTier?: string; // pool fee tier for display, e.g. "0.3%" or "dynamic"
  rsi?: number; // RSI-14 over 5-min candles; undefined = warming up
  rsiLabel?: 'oversold' | 'overbought';
  // How many times its own recent baseline this pool is trading at. Computed on
  // every row whatever MOVERS_RANK_BY is set to, but only the ORDERING authority
  // when it is 'spike'; the default ranking is raw swap count. Rendered by the
  // stdout board and deliberately not by the Telegram one, where it read as a
  // price move. undefined = not scoreable yet (too little history, or too little
  // volume to be worth scoring).
  spike?: number;
  // Fully-diluted valuation in USD, priced from the token's own pool.
  // undefined = no cap known → the row is routed to the Danger Zone board.
  marketCapUsd?: number;
}

export interface MoversBoard {
  rows: MoversRow[]; // ranked by volume spike, then USD volume
  block: number; // toBlock of this window
  fromBlock: number;
  variant?: 'main' | 'danger';
  label?: string; // origin label, e.g. "PancakeSwap v3 (BNB)"
}
