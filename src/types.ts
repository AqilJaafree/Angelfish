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

// One row of a Top Movers board. Shared by the v3 and v4 workers so a single
// renderer serves both — `pool` holds a pool address on v3 and a bytes32 PoolId
// on v4, which is the only shape difference between the two versions.
export interface MoversRow {
  pool: string; // v3: pool address (lowercase). v4: bytes32 PoolId.
  token: string; // the non-ETH token address (lowercase)
  symbol: string; // resolved token symbol (or short-address fallback)
  volumeWeth: bigint; // Σ |ETH-side amount| over the window, in wei
  swaps: number; // number of Swap events
  traders: number; // unique swapper addresses
  feesWeth: bigint; // fees generated in the window, valued in wei
  verified?: boolean; // explorer contract verification (drives ✅ / ⚠️)
  risk?: RiskLevel; // heuristic audit risk light (drives 🟢/🟡/🔴/⬜)
  feeTier?: string; // pool fee tier for display, e.g. "0.3%" or "dynamic"
  rsi?: number; // RSI-14 over 5-min candles; undefined = warming up
  rsiLabel?: 'oversold' | 'overbought';
  // How many times its own recent baseline this pool is trading at. This is
  // what the boards rank on. undefined = not scoreable yet (too little history,
  // or too little volume to be worth scoring) — that row was ranked on raw
  // volume instead, behind every scored one.
  spike?: number;
  // Fully-diluted valuation in USD, priced from the token's own pool.
  // undefined = no cap known → the row is routed to the Danger Zone board.
  marketCapUsd?: number;
}

export interface MoversBoard {
  rows: MoversRow[]; // sorted by volumeWeth desc
  block: number; // toBlock of this window
  fromBlock: number;
  variant?: 'main' | 'danger';
  label?: string; // origin label, e.g. "Uniswap v3 (ETH)"
}
