import { logger } from '../logger';
import { POSITION_MANAGER, V3_FACTORY, WALLET_ADDRESS, DEFAULT_SLIPPAGE_PCT } from './config';
import * as kh from './keeperhub';
import {
  ERC20_ABI, GET_POOL_ABI, MINT_ABI, SLOT0_ABI, TokenRef, ZERO_ADDRESS,
  buildMintParams, fromBaseUnits, priceFromSqrt, rangeTicks, singleSidedTicks,
  sortTokens, toBaseUnits,
} from './uniswap';

export interface PlanStep {
  label: string;
  contract: string;
  fn: string;
  args: string; // JSON-encoded argument array
  abi?: string;
  value?: string; // native ETH to attach, in ether units (used by /wrap)
}

export interface LpPlan {
  summary: string;
  steps: PlanStep[];
}

// Fill in decimals/symbol for a token given as a raw address.
async function hydrate(token: TokenRef): Promise<TokenRef> {
  if (token.decimals >= 0) return token;
  const [dec, sym] = await Promise.all([
    kh.readScalar(token.address, 'decimals', [], ERC20_ABI),
    kh.readScalar(token.address, 'symbol', [], ERC20_ABI).catch(() => token.symbol),
  ]);
  return { ...token, decimals: Number(dec), symbol: sym || token.symbol };
}

export async function resolvePool(
  a: TokenRef,
  b: TokenRef,
  fee: number
): Promise<{ pool: string; sqrtPriceX96: bigint; tick: number; token0: TokenRef; token1: TokenRef }> {
  const t0 = await hydrate(a);
  const t1 = await hydrate(b);
  const { token0, token1 } = sortTokens(t0, t1);
  const poolRes = await kh.readFields(V3_FACTORY, 'getPool', [token0.address, token1.address, fee], GET_POOL_ABI);
  const pool = poolRes.pool;
  if (!pool || pool.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(`no Uniswap v3 pool for ${token0.symbol}/${token1.symbol} at fee ${fee}`);
  }
  const slot0 = await kh.readFields(pool, 'slot0', [], SLOT0_ABI);
  return {
    pool,
    sqrtPriceX96: BigInt(slot0.sqrtPriceX96),
    tick: Number(slot0.tick),
    token0,
    token1,
  };
}

// Build the full add-liquidity plan: approvals (only where the existing
// allowance is short) followed by the mint.
export async function quoteLp(input: {
  tokenA: TokenRef;
  tokenB: TokenRef;
  fee: number;
  amountA: string;
  amountB: string;
  rangePct: number;
  // Gap between the current price and the near edge, single-sided only.
  offsetPct?: number;
  slippagePct?: number;
  now?: number;
}): Promise<LpPlan> {
  if (!WALLET_ADDRESS) throw new Error('LP_WALLET_ADDRESS is not set');
  const slippagePct = input.slippagePct ?? DEFAULT_SLIPPAGE_PCT;
  const { pool, sqrtPriceX96, tick, token0, token1 } = await resolvePool(input.tokenA, input.tokenB, input.fee);

  // The caller named the pair in their own order; map each amount onto the
  // pool's address-sorted order before anything downstream uses it.
  const aIsToken0 = token0.address.toLowerCase() === input.tokenA.address.toLowerCase();
  const amount0 = toBaseUnits(aIsToken0 ? input.amountA : input.amountB, token0.decimals);
  const amount1 = toBaseUnits(aIsToken0 ? input.amountB : input.amountA, token1.decimals);

  // A wallet holding only one of the two tokens can still LP, by placing the
  // whole range on one side of the price. Detected from a zero amount rather
  // than asked for, because a two-sided range with a zero amount would simply
  // revert on the token that is missing.
  const oneSided = amount0 === 0n ? 'token1' : amount1 === 0n ? 'token0' : undefined;
  if (oneSided && amount0 === 0n && amount1 === 0n) throw new Error('both amounts are zero');
  const { tickLower, tickUpper, spacing } = oneSided
    ? singleSidedTicks(tick, oneSided, input.offsetPct ?? 1, input.rangePct, input.fee)
    : rangeTicks(tick, input.rangePct, input.fee);
  const price = priceFromSqrt(sqrtPriceX96, token0.decimals, token1.decimals);
  const now = input.now ?? Date.now();
  const deadlineSec = Math.floor(now / 1000) + 20 * 60;

  const params = buildMintParams({
    token0, token1, fee: input.fee, tickLower, tickUpper,
    amount0, amount1, slippagePct, recipient: WALLET_ADDRESS, deadlineSec,
  });

  const steps: PlanStep[] = [];
  for (const [token, amount] of [[token0, amount0], [token1, amount1]] as const) {
    if (amount === 0n) continue;
    let allowance = 0n;
    try {
      allowance = BigInt(await kh.readScalar(token.address, 'allowance', [WALLET_ADDRESS, POSITION_MANAGER], ERC20_ABI));
    } catch (err) {
      logger.warn({ err, token: token.address }, 'lp: allowance read failed, will approve defensively');
    }
    if (allowance < amount) {
      steps.push({
        label: `approve ${fromBaseUnits(amount, token.decimals)} ${token.symbol}`,
        contract: token.address,
        fn: 'approve',
        args: JSON.stringify([POSITION_MANAGER, amount.toString()]),
        abi: ERC20_ABI,
      });
    }
  }
  steps.push({
    label: `mint ${token0.symbol}/${token1.symbol} ${input.fee / 10000}%`,
    contract: POSITION_MANAGER,
    fn: 'mint',
    // Tuple as an OBJECT — see buildMintParams.
    args: JSON.stringify([params]),
    abi: MINT_ABI,
  });

  const lowerPrice = 1.0001 ** tickLower * 10 ** (token0.decimals - token1.decimals);
  const upperPrice = 1.0001 ** tickUpper * 10 ** (token0.decimals - token1.decimals);
  const fmt = (n: number) => (n < 0.01 ? n.toExponential(3) : n.toLocaleString('en-US', { maximumFractionDigits: 6 }));

  const deposit = oneSided
    ? `<b>${fromBaseUnits(oneSided === 'token1' ? amount1 : amount0, oneSided === 'token1' ? token1.decimals : token0.decimals)} ` +
      `${oneSided === 'token1' ? token1.symbol : token0.symbol}</b> (single-sided)`
    : `<b>${fromBaseUnits(amount0, token0.decimals)} ${token0.symbol}</b> + ` +
      `<b>${fromBaseUnits(amount1, token1.decimals)} ${token1.symbol}</b>`;
  const rangeLine = oneSided
    ? `range    ${input.offsetPct ?? 1}%–${(input.offsetPct ?? 1) + input.rangePct}% ` +
      `${oneSided === 'token1' ? 'below' : 'above'} price → ${fmt(lowerPrice)} – ${fmt(upperPrice)}`
    : `range    ±${input.rangePct}% → ${fmt(lowerPrice)} – ${fmt(upperPrice)}`;

  const summary =
    `<b>${token0.symbol}/${token1.symbol}</b> · fee ${input.fee / 10000}% · pool <code>${pool.slice(0, 10)}…</code>\n` +
    `deposit  ${deposit}\n` +
    `price    ${fmt(price)} ${token1.symbol} per ${token0.symbol}\n` +
    `${rangeLine}\n` +
    `ticks    ${tickLower} … ${tickUpper} (spacing ${spacing})\n` +
    `slippage ${slippagePct}% · deadline 20 min`;

  return { summary, steps };
}

export interface StepOutcome {
  label: string;
  ok: boolean;
  detail: string;
}

// Simulate every step. Approvals are simulated but their state change is not
// applied, so a mint that depends on a pending approval will still report STF
// here — that is expected and is called out in the reply rather than hidden.
export async function simulate(steps: PlanStep[]): Promise<StepOutcome[]> {
  const out: StepOutcome[] = [];
  for (const s of steps) {
    try {
      const res = await kh.write(s.contract, s.fn, JSON.parse(s.args), { abi: s.abi, value: s.value, simulate: true });
      const ok = res.success !== false && res.wouldRevert !== true;
      out.push({
        label: s.label,
        ok,
        detail: ok ? `gas ~${res.gasEstimate ?? '?'}` : `would revert: ${res.revertReason ?? res.error ?? 'unknown'}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // KeeperHub returns a 400 carrying the revert reason for a failed
      // simulation, which surfaces here as a thrown error rather than a result.
      const m = /revertReason":"([^"]+)/.exec(msg) ?? /Error\(([^)]+)\)/.exec(msg);
      out.push({ label: s.label, ok: false, detail: m ? `would revert: ${m[1]}` : msg.slice(0, 200) });
    }
  }
  return out;
}

// Execute for real, stopping at the first failure. Each step carries an
// idempotency key derived from the confirm code and its index, so a retry after
// a timeout cannot broadcast the same approval or mint twice.
export async function execute(steps: PlanStep[], code: string): Promise<StepOutcome[]> {
  const out: StepOutcome[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    try {
      const res = await kh.write(s.contract, s.fn, JSON.parse(s.args), {
        abi: s.abi,
        value: s.value,
        simulate: false,
        idempotencyKey: `lp-${code}-${i}`,
      });
      const ok = res.success !== false;
      out.push({
        label: s.label,
        ok,
        detail: ok ? (res.transactionLink ?? res.executionId ?? res.status ?? 'submitted') : (res.error ?? 'failed'),
      });
      if (!ok) break;
    } catch (err) {
      out.push({ label: s.label, ok: false, detail: err instanceof Error ? err.message.slice(0, 300) : String(err) });
      break;
    }
  }
  return out;
}
