import { logger } from '../logger';
import {
  DEFAULT_RANGE_PCT, KEEPERHUB_API_KEY, OWNER_ID, POSITION_MANAGER, TICK_SPACING, TOKENS, WALLET_ADDRESS,
} from './config';
import * as kh from './keeperhub';
import * as pending from './pending';
import { execute, quoteLp, resolvePool, simulate, StepOutcome } from './plan';
import { ERC20_ABI, NPM_ABI, WETH_DEPOSIT_ABI, fromBaseUnits, priceFromSqrt, resolveToken, toBaseUnits } from './uniswap';

export interface ParsedCommand {
  name: string;
  args: string[];
}

export function parse(text: string): ParsedCommand | undefined {
  const t = text.trim();
  if (!t.startsWith('/')) return undefined;
  // Strip the @botname suffix Telegram appends in groups.
  const parts = t.slice(1).split(/\s+/);
  const name = parts[0].split('@')[0].toLowerCase();
  return { name, args: parts.slice(1) };
}

const HELP = [
  '<b>Angelfish LP</b> — Uniswap v3, Ethereum mainnet',
  '',
  '<code>/pool  &lt;A&gt; &lt;B&gt; &lt;fee&gt;</code>  pool price and tick',
  '<code>/lp    &lt;A&gt; &lt;B&gt; &lt;fee&gt; &lt;amtA&gt; &lt;amtB&gt; [range%]</code>  quote a position',
  '<code>/wrap  &lt;amount-eth&gt;</code>  wrap ETH into WETH',
  '<code>/confirm &lt;code&gt;</code>  execute the quoted plan',
  '<code>/positions</code>  open positions',
  '<code>/cancel</code>  drop pending quotes',
  '<code>/wallet</code>  address and balances',
  '<code>/status</code>  configuration check',
  '',
  `fee tiers: ${Object.keys(TICK_SPACING).join(', ')}  ·  symbols: ${Object.keys(TOKENS).join(', ')}`,
  'Addresses are accepted anywhere a symbol is.',
  '',
  '<i>Every /lp is simulated first. Nothing is broadcast until /confirm.</i>',
  '<i>Pass 0 for one amount to open a single-sided position — the range is placed',
  'entirely on the side that needs only the token you hold.</i>',
].join('\n');

function outcomeLines(rows: StepOutcome[]): string {
  return rows.map((r) => `${r.ok ? '✅' : '❌'} ${r.label}\n     <i>${r.detail}</i>`).join('\n');
}

async function cmdStatus(): Promise<string> {
  const lines = [
    `owner id     <code>${OWNER_ID}</code>`,
    `wallet       ${WALLET_ADDRESS ? `<code>${WALLET_ADDRESS}</code>` : '❌ LP_WALLET_ADDRESS unset'}`,
    `keeperhub    ${KEEPERHUB_API_KEY ? '✅ key present' : '❌ KEEPERHUB_API_KEY unset'}`,
    `position mgr <code>${POSITION_MANAGER}</code>`,
  ];
  if (KEEPERHUB_API_KEY) {
    try {
      await kh.readScalar(TOKENS.USDC.address, 'decimals', [], ERC20_ABI);
      lines.push('connectivity ✅ KeeperHub reachable');
    } catch (err) {
      lines.push(`connectivity ❌ ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
    }
  }
  return lines.join('\n');
}

async function cmdWallet(): Promise<string> {
  if (!WALLET_ADDRESS) return '❌ LP_WALLET_ADDRESS is not set.';
  const lines = [`<code>${WALLET_ADDRESS}</code>`, ''];
  for (const [sym, t] of Object.entries(TOKENS)) {
    try {
      const bal = BigInt(await kh.readScalar(t.address, 'balanceOf', [WALLET_ADDRESS], ERC20_ABI));
      if (bal > 0n) lines.push(`${sym.padEnd(5)} ${fromBaseUnits(bal, t.decimals)}`);
    } catch {
      lines.push(`${sym.padEnd(5)} <i>read failed</i>`);
    }
  }
  if (lines.length === 2) lines.push('<i>no balance in any known token</i>');
  return lines.join('\n');
}

async function cmdPool(args: string[]): Promise<string> {
  if (args.length < 3) return 'usage: <code>/pool &lt;A&gt; &lt;B&gt; &lt;fee&gt;</code>';
  const a = resolveToken(args[0]);
  const b = resolveToken(args[1]);
  const fee = Number(args[2]);
  if (!a || !b) return `unknown token: ${!a ? args[0] : args[1]}`;
  if (!TICK_SPACING[fee]) return `unsupported fee tier ${args[2]} (use ${Object.keys(TICK_SPACING).join(', ')})`;
  const { pool, sqrtPriceX96, tick, token0, token1 } = await resolvePool(a, b, fee);
  const price = priceFromSqrt(sqrtPriceX96, token0.decimals, token1.decimals);
  return (
    `<b>${token0.symbol}/${token1.symbol}</b> fee ${fee / 10000}%\n` +
    `pool  <code>${pool}</code>\n` +
    `price ${price.toLocaleString('en-US', { maximumFractionDigits: 8 })} ${token1.symbol} per ${token0.symbol}\n` +
    `tick  ${tick} (spacing ${TICK_SPACING[fee]})`
  );
}

async function cmdLp(args: string[]): Promise<string> {
  if (args.length < 5) {
    return 'usage: <code>/lp &lt;A&gt; &lt;B&gt; &lt;fee&gt; &lt;amtA&gt; &lt;amtB&gt; [range%]</code>\n' +
      'example: <code>/lp USDC WETH 500 100 0.03 10</code>';
  }
  const a = resolveToken(args[0]);
  const b = resolveToken(args[1]);
  const fee = Number(args[2]);
  if (!a || !b) return `unknown token: ${!a ? args[0] : args[1]}`;
  if (!TICK_SPACING[fee]) return `unsupported fee tier ${args[2]} (use ${Object.keys(TICK_SPACING).join(', ')})`;
  const rangePct = args[5] ? Number(args[5].replace('%', '')) : DEFAULT_RANGE_PCT;
  if (!Number.isFinite(rangePct) || rangePct <= 0 || rangePct >= 100) return `invalid range: ${args[5]}`;

  const plan = await quoteLp({ tokenA: a, tokenB: b, fee, amountA: args[3], amountB: args[4], rangePct });
  const sim = await simulate(plan.steps);
  const allOk = sim.every((s) => s.ok);
  const stored = pending.put({ summary: plan.summary, steps: plan.steps });

  const notes: string[] = [];
  // An approval's state change is not applied across simulated steps, so a mint
  // that needs a pending approval legitimately reverts here. Saying so keeps a
  // real failure distinguishable from this artefact.
  if (!allOk && plan.steps.length > 1 && sim.slice(0, -1).every((s) => s.ok) && !sim[sim.length - 1].ok) {
    notes.push('<i>The mint simulates against current allowances, so it can report STF while an approval is still pending in this same plan. Confirm applies them in order.</i>');
  }
  return (
    `${plan.summary}\n\n<b>simulation</b>\n${outcomeLines(sim)}\n` +
    (notes.length ? `\n${notes.join('\n')}\n` : '') +
    `\n${allOk ? '✅ all steps simulate clean' : '⚠️ some steps would revert'}\n` +
    `confirm with <code>/confirm ${stored.code}</code> — expires in 5 min`
  );
}

// ETH is not an ERC20, so a wallet holding only ETH cannot LP until it is
// wrapped. This is the step that makes a single-sided WETH position reachable
// from a wallet that was funded with nothing but gas money.
async function cmdWrap(args: string[]): Promise<string> {
  if (!args[0]) return 'usage: <code>/wrap &lt;amount-eth&gt;</code>  — wraps ETH into WETH';
  const amount = args[0];
  const wei = toBaseUnits(amount, 18);
  if (wei <= 0n) return 'amount must be greater than zero';
  const sim = await kh.write(TOKENS.WETH.address, 'deposit', [], {
    abi: WETH_DEPOSIT_ABI, value: amount, simulate: true,
  });
  if (sim.success === false || sim.wouldRevert) {
    return `❌ would revert: ${sim.revertReason ?? sim.error ?? 'unknown'}`;
  }
  const stored = pending.put({
    summary: `wrap <b>${amount} ETH</b> → WETH`,
    steps: [{ label: `wrap ${amount} ETH`, contract: TOKENS.WETH.address, fn: 'deposit', args: '[]', value: amount, abi: WETH_DEPOSIT_ABI }],
  });
  return `wrap <b>${amount} ETH</b> → WETH\ngas ~${sim.gasEstimate ?? '?'}\n\nconfirm with <code>/confirm ${stored.code}</code>`;
}

async function cmdPositions(): Promise<string> {
  if (!WALLET_ADDRESS) return '❌ LP_WALLET_ADDRESS is not set.';
  const n = Number(await kh.readScalar(POSITION_MANAGER, 'balanceOf', [WALLET_ADDRESS], NPM_ABI));
  if (!n) return 'no open positions.';
  const out: string[] = [`<b>${n} position${n === 1 ? '' : 's'}</b>`, ''];
  for (let i = 0; i < Math.min(n, 10); i++) {
    const id = await kh.readScalar(POSITION_MANAGER, 'tokenOfOwnerByIndex', [WALLET_ADDRESS, String(i)], NPM_ABI);
    const p = await kh.readFields(POSITION_MANAGER, 'positions', [id], NPM_ABI);
    out.push(
      `#${id} · fee ${Number(p.fee) / 10000}% · ticks ${p.tickLower}…${p.tickUpper}\n` +
      `     liquidity ${p.liquidity} · owed ${p.tokensOwed0}/${p.tokensOwed1}`
    );
  }
  return out.join('\n');
}

async function cmdConfirm(args: string[]): Promise<string> {
  if (!args[0]) return 'usage: <code>/confirm &lt;code&gt;</code>';
  const plan = pending.take(args[0]);
  if (!plan) return '❌ no such pending plan (it may already have been used).';
  if ('expired' in plan) return '❌ that plan expired — re-quote with /lp.';
  logger.warn({ code: plan.code, steps: plan.steps.length }, 'lp: executing confirmed plan');
  const rows = await execute(plan.steps, plan.code);
  const ok = rows.every((r) => r.ok);
  return `${plan.summary}\n\n<b>execution</b>\n${outcomeLines(rows)}\n\n${ok ? '✅ complete' : '❌ stopped at the first failure'}`;
}

export async function handle(cmd: ParsedCommand): Promise<string> {
  switch (cmd.name) {
    case 'start':
    case 'help':
      return HELP;
    case 'status':
      return cmdStatus();
    case 'wallet':
      return cmdWallet();
    case 'pool':
      return cmdPool(cmd.args);
    case 'lp':
      return cmdLp(cmd.args);
    case 'wrap':
      return cmdWrap(cmd.args);
    case 'positions':
      return cmdPositions();
    case 'confirm':
      return cmdConfirm(cmd.args);
    case 'cancel': {
      const n = pending.size();
      pending.clear();
      return `dropped ${n} pending plan${n === 1 ? '' : 's'}.`;
    }
    default:
      return `unknown command <code>/${cmd.name}</code> — try /help`;
  }
}
