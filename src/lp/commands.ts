import {
  DEFAULT_RANGE_PCT, KEEPERHUB_API_KEY, OWNER_ID, POSITION_MANAGER, TICK_SPACING, TOKENS, WALLET_ADDRESS,
} from './config';
import * as kh from './keeperhub';
import * as pending from './pending';
import { AuditEntry, auditToken, renderAuditLine, renderAuditReport, tokensNeedingAudit } from './audit';
import { DEFAULT_TRAIL_LIMIT, fetchTrail, renderTrail } from './trail';
// `execute` is deliberately NOT imported: broadcasting is commented out, and leaving
// the import would make it look reachable from here. See cmdConfirm below.
import { quoteExit, quoteLp, resolvePool, simulate, StepOutcome } from './plan';
import { ERC20_ABI, NPM_ABI, WBNB_DEPOSIT_ABI, fromBaseUnits, priceFromSqrt, resolveToken, toBaseUnits } from './pancake';

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
  '<b>Angelfish LP</b> — PancakeSwap v3, BNB Chain',
  '',
  '<code>/pool  &lt;A&gt; &lt;B&gt; &lt;fee&gt;</code>  pool price and tick',
  '<code>/lp    &lt;A&gt; &lt;B&gt; &lt;fee&gt; &lt;amtA&gt; &lt;amtB&gt; [range%]</code>  quote a position',
  '<code>/wrap  &lt;amount-bnb&gt;</code>  wrap BNB into WBNB',
  '<code>/confirm &lt;code&gt;</code>  ⛔ disabled — broadcasting is commented out',
  '<code>/positions</code>  open positions',
  '<code>/exit  [n] [percent]</code>  withdraw — run bare to pick from a list',
  '<code>/audit &lt;token&gt;</code>  contract verification and source scan',
  '<code>/history [n]</code>  what this wallet has signed (from KeeperHub)',
  '<code>/cancel</code>  drop pending quotes',
  '<code>/wallet</code>  address and balances',
  '<code>/status</code>  configuration check',
  '',
  `fee tiers: ${Object.keys(TICK_SPACING).join(', ')}  ·  symbols: ${Object.keys(TOKENS).join(', ')}`,
  'Addresses are accepted anywhere a symbol is.',
  '',
  '<i>Every /lp and /exit is quoted and simulated. Broadcasting is currently DISABLED,',
  'so /confirm will not sign or submit anything — see src/lp/plan.ts.</i>',
  '<i>Pass 0 for one amount to open a single-sided position — the range is placed',
  'entirely on the side that needs only the token you hold.</i>',
  '<i>To close one: /exit lists your positions, then /exit 1 closes the first.</i>',
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
      'example: <code>/lp USDT WBNB 500 100 0.03 10</code>';
  }
  const a = resolveToken(args[0]);
  const b = resolveToken(args[1]);
  const fee = Number(args[2]);
  if (!a || !b) return `unknown token: ${!a ? args[0] : args[1]}`;
  if (!TICK_SPACING[fee]) return `unsupported fee tier ${args[2]} (use ${Object.keys(TICK_SPACING).join(', ')})`;
  const rangePct = args[5] ? Number(args[5].replace('%', '')) : DEFAULT_RANGE_PCT;
  if (!Number.isFinite(rangePct) || rangePct <= 0 || rangePct >= 100) return `invalid range: ${args[5]}`;

  // Audit before quoting. A token reached by raw address has had nothing
  // checked about it, and the verdict belongs in front of the operator BEFORE
  // they read a confirm code — not appended after it, where it reads as a
  // footnote to a decision already made.
  const audits: AuditEntry[] = [];
  for (const address of tokensNeedingAudit([a.address, b.address])) {
    const symbol = address === a.address.toLowerCase() ? a.symbol : b.symbol;
    audits.push(await auditToken(address, symbol));
  }

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
    renderAuditBlock(audits) +
    `${plan.summary}\n\n<b>simulation</b>\n${outcomeLines(sim)}\n` +
    (notes.length ? `\n${notes.join('\n')}\n` : '') +
    `\n${allOk ? '✅ all steps simulate clean' : '⚠️ some steps would revert'}\n` +
    `quote <code>${stored.code}</code> — expires in 5 min\n` +
    '⛔ <i>broadcasting is disabled; /confirm will not sign anything</i>'
  );
}

// The audit header on a quote. Empty when both sides are curated majors, so a
// routine USDT/WBNB quote is not padded with a paragraph saying nothing.
export function renderAuditBlock(audits: AuditEntry[]): string {
  if (!audits.length) return '';
  const lines = ['<b>token audit</b>', ...audits.map(renderAuditLine)];
  // Lead with the worst case. An unverified contract and a high-risk one are
  // different problems and get different sentences — collapsing them into one
  // generic "be careful" would lose the distinction the two badges exist for.
  const unverified = audits.filter((e) => e.result && !e.result.verified);
  const high = audits.filter((e) => e.result?.verified && e.result.risk === 'high');
  const failed = audits.filter((e) => !e.result);
  if (unverified.length) {
    lines.push(`⚠️ <b>${unverified.map((e) => e.symbol).join(', ')}</b> has no published source — nobody can read what it does.`);
  }
  if (high.length) {
    lines.push(`🔴 <b>${high.map((e) => e.symbol).join(', ')}</b> holds rug-enabling powers (flags above).`);
  }
  if (failed.length) {
    lines.push(`❔ audit could not be reached for <b>${failed.map((e) => e.symbol).join(', ')}</b> — absence of a badge is not a pass.`);
  }
  return lines.join('\n') + '\n\n';
}

// ETH is not an ERC20, so a wallet holding only ETH cannot LP until it is
// wrapped. This is the step that makes a single-sided WBNB position reachable
// from a wallet that was funded with nothing but gas money.
async function cmdWrap(args: string[]): Promise<string> {
  if (!args[0]) return 'usage: <code>/wrap &lt;amount-bnb&gt;</code>  — wraps BNB into WBNB';
  const amount = args[0];
  const wei = toBaseUnits(amount, 18);
  if (wei <= 0n) return 'amount must be greater than zero';
  const sim = await kh.write(TOKENS.WBNB.address, 'deposit', [], {
    abi: WBNB_DEPOSIT_ABI, value: amount, simulate: true,
  });
  if (sim.success === false || sim.wouldRevert) {
    return `❌ would revert: ${sim.revertReason ?? sim.error ?? 'unknown'}`;
  }
  const stored = pending.put({
    summary: `wrap <b>${amount} BNB</b> → WBNB`,
    steps: [{ label: `wrap ${amount} BNB`, contract: TOKENS.WBNB.address, fn: 'deposit', args: '[]', value: amount, abi: WBNB_DEPOSIT_ABI }],
  });
  return (
    `wrap <b>${amount} BNB</b> → WBNB\ngas ~${sim.gasEstimate ?? '?'}\n\n` +
    `quote <code>${stored.code}</code>\n` +
    '⛔ <i>broadcasting is disabled; /confirm will not sign anything</i>'
  );
}

const MAX_LISTED_POSITIONS = 10;

interface PositionRow {
  slot: number; // 1-based, as shown to the user
  tokenId: string;
  fields: Record<string, string>;
}

// The list every position-facing command works from. Slot numbers are assigned
// here and nowhere else, so `/exit 2` always means the second row of the list
// the user is looking at.
async function fetchPositions(): Promise<PositionRow[]> {
  const n = Number(await kh.readScalar(POSITION_MANAGER, 'balanceOf', [WALLET_ADDRESS], NPM_ABI));
  const out: PositionRow[] = [];
  for (let i = 0; i < Math.min(n, MAX_LISTED_POSITIONS); i++) {
    const tokenId = await kh.readScalar(POSITION_MANAGER, 'tokenOfOwnerByIndex', [WALLET_ADDRESS, String(i)], NPM_ABI);
    out.push({ slot: i + 1, tokenId, fields: await kh.readFields(POSITION_MANAGER, 'positions', [tokenId], NPM_ABI) });
  }
  return out;
}

function renderPosition(p: PositionRow): string {
  const f = p.fields;
  const empty = BigInt(f.liquidity ?? '0') === 0n;
  return (
    `<b>${p.slot})</b> #${p.tokenId} · fee ${Number(f.fee) / 10000}% · ticks ${f.tickLower}…${f.tickUpper}\n` +
    `     liquidity ${f.liquidity}${empty ? ' <i>(empty)</i>' : ''} · owed ${f.tokensOwed0}/${f.tokensOwed1}\n` +
    `     exit with <code>/exit ${p.slot}</code>`
  );
}

export type ExitTarget =
  | { kind: 'list' }
  | { kind: 'slot'; slot: number }
  | { kind: 'tokenId'; tokenId: string }
  | { kind: 'error'; message: string };

// Resolve what the user meant by the first argument to /exit.
//
// The point of the slot indirection is that nobody should have to retype a
// seven-digit tokenId off a phone screen. So a small number is a POSITION SLOT,
// never a token id — and a number too large to be a slot is refused with the
// `#` form spelled out rather than silently reinterpreted, because guessing
// wrong would target a completely unrelated position.
export function parseExitTarget(arg: string | undefined, count: number): ExitTarget {
  const raw = (arg ?? '').trim();
  if (!raw) return { kind: 'list' };
  if (raw.startsWith('#')) {
    const id = raw.slice(1);
    if (!/^\d+$/.test(id)) return { kind: 'error', message: `not a token id: <code>${raw}</code>` };
    return { kind: 'tokenId', tokenId: id };
  }
  if (!/^\d+$/.test(raw)) {
    return { kind: 'error', message: 'usage: <code>/exit &lt;n&gt; [percent]</code> — run <code>/exit</code> to list positions' };
  }
  if (count === 0) return { kind: 'error', message: 'no open positions to exit.' };
  const n = Number(raw);
  if (n >= 1 && n <= count) return { kind: 'slot', slot: n };
  return {
    kind: 'error',
    message:
      `you have ${count} position${count === 1 ? '' : 's'} — pick 1–${count}.\n` +
      `to target token id ${raw} directly, use <code>/exit #${raw}</code>`,
  };
}

// Accepts `50` or `50%`. Absent means a full exit.
export function parseExitPct(arg: string | undefined): number | { error: string } {
  if (arg === undefined || arg.trim() === '') return 100;
  const pct = Number(arg.trim().replace('%', ''));
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return { error: `invalid percent: ${arg}` };
  return pct;
}

async function cmdPositions(): Promise<string> {
  if (!WALLET_ADDRESS) return '❌ LP_WALLET_ADDRESS is not set.';
  const positions = await fetchPositions();
  if (!positions.length) return 'no open positions.';
  return [
    `<b>${positions.length} position${positions.length === 1 ? '' : 's'}</b>`,
    '',
    ...positions.map(renderPosition),
  ].join('\n');
}

async function cmdExit(args: string[]): Promise<string> {
  if (!WALLET_ADDRESS) return '❌ LP_WALLET_ADDRESS is not set.';
  const positions = await fetchPositions();
  const target = parseExitTarget(args[0], positions.length);
  if (target.kind === 'error') return target.message;
  if (target.kind === 'list') {
    if (!positions.length) return 'no open positions to exit.';
    return [
      '<b>which position?</b>',
      '',
      ...positions.map(renderPosition),
      '',
      '<code>/exit &lt;n&gt;</code> closes it fully · <code>/exit &lt;n&gt; 50</code> takes out half',
    ].join('\n');
  }
  const pct = parseExitPct(args[1]);
  if (typeof pct !== 'number') return pct.error;
  const tokenId = target.kind === 'slot' ? positions[target.slot - 1].tokenId : target.tokenId;

  const plan = await quoteExit({ tokenId, pct });
  const sim = await simulate(plan.steps);
  const allOk = sim.every((s) => s.ok);
  const stored = pending.put({ summary: plan.summary, steps: plan.steps });

  // Each step simulates against CURRENT state, so collect and burn legitimately
  // report a revert while the decrease they depend on has not been applied.
  // Saying so keeps that artefact distinguishable from a real failure — the same
  // reasoning as the approve-then-mint note in /lp.
  const artefact = !allOk && sim[0].ok && sim.slice(1).some((s) => !s.ok);
  return (
    `${plan.summary}\n\n<b>simulation</b>\n${outcomeLines(sim)}\n` +
    (artefact
      ? '\n<i>collect and burn simulate against the position as it stands now, so they can report a revert until the withdraw ahead of them is applied. Confirm runs the steps in order.</i>\n'
      : '') +
    `\n${allOk ? '✅ all steps simulate clean' : '⚠️ some steps would revert'}\n` +
    `quote <code>${stored.code}</code> — expires in 5 min\n` +
    '⛔ <i>broadcasting is disabled; /confirm will not sign anything</i>'
  );
}

// Audit any token on demand, including the curated majors that /lp skips —
// an explicit request is a different thing from an automatic check, and the
// report carries the calibration caveat with it.
async function cmdAudit(args: string[]): Promise<string> {
  if (!args[0]) {
    return 'usage: <code>/audit &lt;token&gt;</code> — symbol or address\nfor what this wallet has signed, use <code>/history</code>';
  }
  const token = resolveToken(args[0]);
  if (!token) return `unknown token: ${args[0]}`;
  return renderAuditReport(await auditToken(token.address, token.symbol));
}

async function cmdHistory(args: string[]): Promise<string> {
  const limit = args[0] ? Number(args[0].replace(/\D/g, '')) : DEFAULT_TRAIL_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) return `invalid count: ${args[0]}`;
  return renderTrail(await fetchTrail(limit));
}

// /confirm is the only route that reaches plan.execute, and BROADCASTING IS
// DISABLED — see the comment on execute() in plan.ts.
//
// The refusal happens here, BEFORE pending.take(), so a disabled bot does not
// silently consume the single-use confirm code: the quote stays confirmable if
// execution is turned back on, instead of being burned by an attempt that could
// never have broadcast anyway.
async function cmdConfirm(args: string[]): Promise<string> {
  if (!args[0]) return 'usage: <code>/confirm &lt;code&gt;</code>';
  return (
    '🚫 <b>execution is disabled</b>\n\n' +
    'Broadcasting on BNB Chain is commented out in <code>src/lp/plan.ts</code>, so ' +
    'nothing can be signed or submitted.\n\n' +
    'Quoting and simulation still work — <code>/lp</code> and <code>/exit</code> ' +
    'price the position and simulate every step.'
  );

  // const plan = pending.take(args[0]);
  // if (!plan) return '❌ no such pending plan (it may already have been used).';
  // if ('expired' in plan) return '❌ that plan expired — re-quote with /lp.';
  // logger.warn({ code: plan.code, steps: plan.steps.length }, 'lp: executing confirmed plan');
  // const rows = await execute(plan.steps, plan.code);
  // const ok = rows.every((r) => r.ok);
  // return `${plan.summary}\n\n<b>execution</b>\n${outcomeLines(rows)}\n\n${ok ? '✅ complete' : '❌ stopped at the first failure'}`;
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
    case 'exit':
    case 'withdraw':
      return cmdExit(cmd.args);
    case 'audit':
      return cmdAudit(cmd.args);
    case 'history':
    case 'trail':
      return cmdHistory(cmd.args);
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
