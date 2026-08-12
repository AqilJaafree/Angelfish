import { MoversBoard, MoversRow, RiskLevel } from '../types';

// v3 fee tiers are hundredths of a bip: 3000 -> "0.3%".
export function formatFeeTier(fee: number): string {
  const pct = fee / 10_000;
  return `${Number(pct.toFixed(4))}%`;
}

export function formatEth(wei: bigint): string {
  const eth = Number(wei) / 1e18;
  if (eth === 0) return 'Ξ0';
  if (eth < 0.0001) return `Ξ${eth.toExponential(2)}`;
  return `Ξ${eth.toLocaleString('en-US', { maximumFractionDigits: eth < 1 ? 4 : 2 })}`;
}

export function formatUsd(usd: number | undefined): string {
  if (usd == null) return 'MC —';
  if (usd < 1) return 'MC <$1';
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, suffix] of units) {
    if (usd >= size) return `MC $${(usd / size).toFixed(1)}${suffix}`;
  }
  return `MC $${usd.toFixed(0)}`;
}

const RISK_BADGE: Record<RiskLevel, string> = {
  clean: '🟢',
  caution: '🟡',
  high: '🔴',
  unknown: '⬜',
};

// Two badges answering two different questions: can we see the code (✅/⚠️), and
// what does the code do (🟢/🟡/🔴/⬜). `✅🔴` ("public and dangerous") and `⚠️⬜`
// ("we can't see the code at all") are very different situations, so both are kept.
export function formatBadges(row: MoversRow): string {
  if (row.verified == null && row.risk == null) return '';
  const verified = row.verified == null ? '' : row.verified ? '✅' : '⚠️';
  const risk = row.risk == null ? '' : RISK_BADGE[row.risk];
  return verified + risk;
}

export function formatRsi(row: MoversRow): string {
  if (row.rsi == null) return 'RSI —';
  const label =
    row.rsiLabel === 'oversold'
      ? ' 🟢 Oversold'
      : row.rsiLabel === 'overbought'
        ? ' 🔴 Overbought'
        : '';
  return `RSI ${row.rsi}${label}`;
}

// Mirrors telegram/format.ts — see the note there on why an unscored row shows
// a marker rather than "1x".
export function formatSpike(spike: number | undefined): string {
  if (spike == null) return '(warming)';
  if (spike >= 10) return `${spike.toFixed(0)}x`;
  return `${spike.toFixed(1)}x`;
}

const MEDALS = ['🥇', '🥈', '🥉'];

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

// Three lines per token: identity & signals, activity in the window, the contract.
// The contract address is the source of truth — a symbol is not unique.
export function formatRow(row: MoversRow, index: number): string {
  const rank = MEDALS[index] ?? `${index + 1}.`;
  const badges = formatBadges(row);
  const parts = [
    `${rank} ${row.symbol}${badges ? ` ${badges}` : ''}`,
    row.feeTier ? `(${row.feeTier})` : '',
  ].filter(Boolean);
  const line1 = `${parts.join(' ')} ${formatSpike(row.spike)} · ${formatRsi(row)} · ${formatUsd(row.marketCapUsd)}`;
  const line2 = `    ${formatEth(row.volumeWeth)} vol · ${row.swaps} swaps · ${row.traders} traders · ${formatEth(row.feesWeth)} fees`;
  const line3 = `    ↳ ${shortAddr(row.token)}`;
  return [line1, line2, line3].join('\n');
}

export function formatBoard(board: MoversBoard): string {
  const header =
    board.variant === 'danger'
      ? `⚠️  Danger Zone — ${board.label ?? 'unknown source'}`
      : `📈 ${board.label ?? 'Top Movers'}`;
  const span = `blocks ${board.fromBlock}–${board.block}`;
  const body = board.rows.map(formatRow).join('\n');
  return [`${header}  (${span})`, body].join('\n');
}
