import { TICK_SPACING, TOKENS } from './config';

// Uniswap v3's absolute tick bounds. A range outside these reverts.
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

export interface TokenRef {
  address: string;
  decimals: number;
  symbol: string;
}

// Resolve `USDC` or a raw 0x address. An address always wins over an alias, so
// a pasted address is never silently reinterpreted as a known symbol.
export function resolveToken(input: string): TokenRef | undefined {
  const t = input.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) {
    return { address: t.toLowerCase(), decimals: -1, symbol: `${t.slice(0, 6)}…${t.slice(-4)}` };
  }
  const known = TOKENS[t.toUpperCase()];
  if (!known) return undefined;
  return { address: known.address, decimals: known.decimals, symbol: t.toUpperCase() };
}

// v3 orders a pool's currencies by address, and mint() takes them in that order.
// Getting this backwards silently swaps which side each amount funds.
export function sortTokens(a: TokenRef, b: TokenRef): { token0: TokenRef; token1: TokenRef; flipped: boolean } {
  const flipped = a.address.toLowerCase() > b.address.toLowerCase();
  return flipped ? { token0: b, token1: a, flipped } : { token0: a, token1: b, flipped };
}

// Human amount -> base units, without going through a float. `1.5` at 6 decimals
// must be exactly 1500000; parseFloat would introduce a representation error on
// amounts with many decimal places, and this value is a transfer amount.
export function toBaseUnits(amount: string, decimals: number): bigint {
  const clean = amount.trim().replace(/,/g, '');
  if (!/^\d*(\.\d*)?$/.test(clean) || clean === '' || clean === '.') {
    throw new Error(`invalid amount: ${amount}`);
  }
  const [whole, frac = ''] = clean.split('.');
  if (frac.length > decimals) {
    throw new Error(`${amount} has more than ${decimals} decimal places`);
  }
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

export function fromBaseUnits(value: bigint, decimals: number, places = 6): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = (value % base).toString().padStart(decimals, '0').slice(0, places).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

// Align a tick to the pool's spacing. Lower rounds down and upper rounds up, so
// the requested range is always fully contained rather than trimmed inside it.
export function alignTick(tick: number, spacing: number, dir: 'down' | 'up'): number {
  const aligned = dir === 'down' ? Math.floor(tick / spacing) * spacing : Math.ceil(tick / spacing) * spacing;
  return Math.max(MIN_TICK, Math.min(MAX_TICK, aligned));
}

// A ±pct band around the current tick.
//
// Ticks are logarithmic: price(tick) = 1.0001^tick. So a +10% price move is
// ln(1.10)/ln(1.0001) ticks, NOT 10% of the tick number — treating it linearly
// would produce a wildly wrong band at any tick far from zero (mainnet USDC/WETH
// sits near 200,000).
export function rangeTicks(
  currentTick: number,
  pct: number,
  fee: number
): { tickLower: number; tickUpper: number; spacing: number } {
  const spacing = TICK_SPACING[fee];
  if (!spacing) throw new Error(`unsupported fee tier: ${fee}`);
  if (!(pct > 0) || pct >= 100) throw new Error(`range must be between 0 and 100 percent, got ${pct}`);
  const delta = Math.log(1 + pct / 100) / Math.log(1.0001);
  let tickLower = alignTick(currentTick - delta, spacing, 'down');
  let tickUpper = alignTick(currentTick + delta, spacing, 'up');
  // A band narrower than one spacing collapses to an empty range, which reverts.
  if (tickLower === tickUpper) {
    tickLower = alignTick(tickLower - spacing, spacing, 'down');
    tickUpper = alignTick(tickUpper + spacing, spacing, 'up');
  }
  return { tickLower, tickUpper, spacing };
}

// A range placed entirely on ONE side of the current price, so the position is
// funded with a single token.
//
// v3 splits a position by where the price sits relative to the range:
//   currentTick <  tickLower  -> 100% token0
//   currentTick >= tickUpper  -> 100% token1
// so supplying only token1 means putting the whole range BELOW the current tick,
// and only token0 means putting it ABOVE. Getting this backwards asks for the
// token the wallet does not hold and reverts with STF.
//
// `offsetPct` is the gap between the current price and the near edge. It is not
// cosmetic: with a zero gap, any price move between quote and inclusion drags the
// current tick inside the range, which makes the mint demand *both* tokens and
// revert. The gap buys tolerance for that drift.
export function singleSidedTicks(
  currentTick: number,
  side: 'token0' | 'token1',
  offsetPct: number,
  widthPct: number,
  fee: number
): { tickLower: number; tickUpper: number; spacing: number } {
  const spacing = TICK_SPACING[fee];
  if (!spacing) throw new Error(`unsupported fee tier: ${fee}`);
  if (!(offsetPct > 0) || offsetPct >= 100) throw new Error(`offset must be between 0 and 100 percent, got ${offsetPct}`);
  if (!(widthPct > 0) || widthPct >= 100) throw new Error(`width must be between 0 and 100 percent, got ${widthPct}`);
  const ticks = (pct: number) => Math.log(1 + pct / 100) / Math.log(1.0001);
  const near = ticks(offsetPct);
  const far = ticks(offsetPct + widthPct);

  if (side === 'token1') {
    // Entirely below the current price.
    let tickUpper = alignTick(currentTick - near, spacing, 'down');
    let tickLower = alignTick(currentTick - far, spacing, 'down');
    if (tickLower >= tickUpper) tickLower = alignTick(tickUpper - spacing, spacing, 'down');
    return { tickLower, tickUpper, spacing };
  }
  // Entirely above the current price.
  let tickLower = alignTick(currentTick + near, spacing, 'up');
  let tickUpper = alignTick(currentTick + far, spacing, 'up');
  if (tickUpper <= tickLower) tickUpper = alignTick(tickLower + spacing, spacing, 'up');
  return { tickLower, tickUpper, spacing };
}

// price of token1 per token0, in HUMAN units on both sides.
export function priceFromSqrt(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const q = Number(sqrtPriceX96) / 2 ** 96;
  return q * q * 10 ** (decimals0 - decimals1);
}

export function applySlippage(amount: bigint, pct: number): bigint {
  if (!(pct >= 0) || pct >= 100) throw new Error(`invalid slippage: ${pct}`);
  // Integer arithmetic in basis points — a float multiply on a bigint amount
  // would lose precision on large balances.
  const bps = BigInt(Math.round((100 - pct) * 100));
  return (amount * bps) / 10000n;
}

export interface MintParams {
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: string;
  amount1Desired: string;
  amount0Min: string;
  amount1Min: string;
  recipient: string;
  deadline: string;
}

// KeeperHub encodes a tuple argument correctly ONLY when it is given as an
// object. Passing it as a nested array double-nests and fails with
// `invalid address (argument="token0")`, so this returns an object by design.
export function buildMintParams(input: {
  token0: TokenRef;
  token1: TokenRef;
  fee: number;
  tickLower: number;
  tickUpper: number;
  amount0: bigint;
  amount1: bigint;
  slippagePct: number;
  recipient: string;
  deadlineSec: number;
}): MintParams {
  return {
    token0: input.token0.address,
    token1: input.token1.address,
    fee: input.fee,
    tickLower: input.tickLower,
    tickUpper: input.tickUpper,
    amount0Desired: input.amount0.toString(),
    amount1Desired: input.amount1.toString(),
    amount0Min: applySlippage(input.amount0, input.slippagePct).toString(),
    amount1Min: applySlippage(input.amount1, input.slippagePct).toString(),
    recipient: input.recipient,
    deadline: String(input.deadlineSec),
  };
}

export const MINT_ABI = JSON.stringify([
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'token0', type: 'address' },
          { name: 'token1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickLower', type: 'int24' },
          { name: 'tickUpper', type: 'int24' },
          { name: 'amount0Desired', type: 'uint256' },
          { name: 'amount1Desired', type: 'uint256' },
          { name: 'amount0Min', type: 'uint256' },
          { name: 'amount1Min', type: 'uint256' },
          { name: 'recipient', type: 'address' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
    ],
    outputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
  },
]);

export const SLOT0_ABI = JSON.stringify([
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
]);

export const GET_POOL_ABI = JSON.stringify([
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
]);

export const ERC20_ABI = JSON.stringify([
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  {
    type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function', name: 'allowance', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
]);

// WETH's payable deposit(): the on-ramp from raw ETH, which is not an ERC20 and
// so cannot be deposited into a pool directly.
export const WETH_DEPOSIT_ABI = JSON.stringify([
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [{ name: 'wad', type: 'uint256' }], outputs: [] },
]);

export const NPM_ABI = JSON.stringify([
  {
    type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function', name: 'tokenOfOwnerByIndex', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'index', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function', name: 'positions', stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'nonce', type: 'uint96' }, { name: 'operator', type: 'address' },
      { name: 'token0', type: 'address' }, { name: 'token1', type: 'address' },
      { name: 'fee', type: 'uint24' }, { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' }, { name: 'liquidity', type: 'uint128' },
      { name: 'feeGrowthInside0LastX128', type: 'uint256' },
      { name: 'feeGrowthInside1LastX128', type: 'uint256' },
      { name: 'tokensOwed0', type: 'uint128' }, { name: 'tokensOwed1', type: 'uint128' },
    ],
  },
]);

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
