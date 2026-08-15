import { MoversBoard, MoversRow, RiskLevel } from '../types';
import { BoardKey } from '../bsc/anchors';
import { EXPLORER_BASE } from '../bsc/config';

// Telegram's hard limit on a single sendMessage body.
export const TELEGRAM_MAX_LEN = 4096;

const MEDALS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣'];

// Escape text interpolated into an HTML-parsed message. Token symbols are
// attacker-controlled strings read straight off-chain — a token named
// `<b>SAFE</b>` or one containing a stray `<` would otherwise either forge
// formatting or make Telegram reject the whole message with a parse error,
// silently costing the board that cycle.
export function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 0x1f7d…2efa
function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

// A USD amount held as a bigint in 1e18 fixed point -> "$<whole>.<decimals>",
// truncated rather than rounded so a figure never reads higher than what traded.
//
// USD rather than the Ethereum build's Ξ because pools on BSC do not share one
// anchor — see bsc/anchors.ts. `undefined` (a BNB-quoted pool whose BNB/USD read
// failed) renders as a dash rather than $0, so an unpriced row is never mistaken
// for a dead one. Thousands separators are applied to the whole part, which the
// Ethereum build did not need: an ETH figure is small, a USD one routinely is not.
export function formatUsdAmount(value: bigint | undefined, decimals = 2): string {
  if (value == null) return '—';
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** 18n;
  const whole = (v / base).toLocaleString('en-US');
  const frac = (v % base).toString().padStart(18, '0').slice(0, decimals);
  return `${neg ? '-' : ''}$${whole}${decimals > 0 ? `.${frac}` : ''}`;
}

export function formatUsd(usd: number): string {
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, suffix] of units) {
    if (usd >= size) return `$${(usd / size).toFixed(1)}${suffix}`;
  }
  return `$${usd.toFixed(0)}`;
}

// Unknown renders as an em dash rather than being hidden, so a row never looks
// like it passed a check it did not.
//
// The sub-dollar case MUST emit `&lt;`, not a bare `<`. This is the HTML
// formatter, and Telegram parses `<$1` as an opening tag, rejects the request
// with `can't parse entities: Unsupported start tag "$1"`, and drops the WHOLE
// board — not just the offending row. It is a rare branch (only tokens priced
// under a dollar reach it) hiding behind a common one, so it fails long after
// the transport looks proven. The stdout formatter in bsc/format.ts keeps
// the bare `<`, which is correct there.
export function formatMarketCap(usd: number | undefined): string {
  if (usd == null) return 'MC —';
  if (usd > 0 && usd < 1) return 'MC &lt;$1';
  return `MC ${formatUsd(usd)}`;
}

// Two-part badge after the symbol: verification (✅/⚠️) plus an audit light
// (🟢 clean / 🟡 caution / 🔴 high / ⬜ couldn't audit). When the lookup failed
// this cycle, render nothing and let the next cycle retry.
export function auditBadge(verified?: boolean, risk?: RiskLevel): string {
  if (verified === undefined) return '';
  const mark = verified ? '✅' : '⚠️';
  const light =
    risk === 'clean' ? '🟢' : risk === 'caution' ? '🟡' : risk === 'high' ? '🔴' : '⬜';
  return ` ${mark}${light}`;
}

// The volume spike is NOT rendered on the board. It is still what rows are ranked
// by (bsc/volume-history.ts) and it is still printed by the stdout renderer in
// bsc/format.ts, so why a row placed where it did stays visible in the logs — it is
// only off the Telegram row, where it read as a price move rather than as a volume
// ratio. `MoversRow.spike` is therefore carried but not displayed; do not delete it.

export function formatRsiTag(
  rsi: number | undefined,
  label: 'oversold' | 'overbought' | undefined
): string {
  if (rsi == null) return 'RSI —';
  const badge = label === 'oversold' ? ' 🟢 Oversold' : label === 'overbought' ? ' 🔴 Overbought' : '';
  return `RSI ${Math.round(rsi)}${badge}`;
}

// One entry per token, three short lines — identity, metrics, address — so each
// row scans top-to-bottom instead of wrapping one long line.
function renderRow(r: MoversRow, i: number): string {
  const medal = MEDALS[i] ?? `${i + 1}.`;
  const tier = r.feeTier ? ` (${r.feeTier})` : '';
  const link = `<a href="${EXPLORER_BASE}/token/${r.token}">${shortAddr(r.token)}</a>`;
  return (
    `${medal} <b>${htmlEscape(r.symbol)}</b>` +
    `${auditBadge(r.verified, r.risk)}${tier} · ` +
    `${formatRsiTag(r.rsi, r.rsiLabel)} · ${formatMarketCap(r.marketCapUsd)}\n` +
    `    ${formatUsdAmount(r.volumeUsd, 2)} vol · ${r.swaps} swaps · ${r.traders} traders · ` +
    `${formatUsdAmount(r.feesUsd, 2)} fees\n` +
    `    ↳ ${link}`
  );
}

function frame(title: string, board: MoversBoard): string {
  const span =
    board.block === board.fromBlock
      ? `block ${board.block.toLocaleString('en-US')}`
      : `blocks ${board.fromBlock.toLocaleString('en-US')}–${board.block.toLocaleString('en-US')}`;
  const message = [title, `<i>${span}</i>`, '', board.rows.map(renderRow).join('\n\n')].join('\n');
  // Drop whole rows from the tail rather than letting Telegram reject the
  // message: a truncated mid-tag body is a parse error, which costs the entire
  // board, and a board that silently never posts is worse than a shorter one.
  if (message.length <= TELEGRAM_MAX_LEN) return message;
  for (let keep = board.rows.length - 1; keep > 0; keep--) {
    const trimmed = frame(title, { ...board, rows: board.rows.slice(0, keep) });
    if (trimmed.length <= TELEGRAM_MAX_LEN) return trimmed;
  }
  return [title, `<i>${span}</i>`, '', '<i>(board too large to render)</i>'].join('\n');
}

// Both v3 boards share a renderer and differ only in the header, because the ROWS
// cannot tell you which board you are looking at: a row shows a symbol, an address
// and USD figures, never the currency the pair is quoted in. The header is the only
// place that information exists, so it is not decoration.
const V3_PAIR_LABEL: Record<BoardKey, string> = {
  wbnb: 'WBNB pairs',
  usdt: 'USDT pairs',
};

export function formatMoversBoardV3(board: MoversBoard, pair: BoardKey): string {
  return frame(
    `🥞 <b>PancakeSwap v3 — Top Movers</b> · <i>${V3_PAIR_LABEL[pair]}</i>`,
    board
  );
}

export function formatMoversBoardCl(board: MoversBoard): string {
  return frame('♾️ <b>PancakeSwap Infinity — Top Movers</b>', board);
}

// Sub-threshold and unknown-market-cap tokens from BOTH boards land in one place,
// so the header has to carry the origin label.
export function formatDangerZoneBoard(board: MoversBoard): string {
  return frame(`⚠️ <b>Danger Zone — ${htmlEscape(board.label ?? 'PancakeSwap')}</b>`, board);
}
