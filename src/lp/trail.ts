import * as kh from './keeperhub';
import { POSITION_MANAGER, TOKENS, V3_FACTORY } from './config';

// The audit trail: what this wallet actually signed, read back from KeeperHub.
//
// Sourced from KeeperHub rather than accumulated in this process on purpose.
// The bot holds no durable state (see pending.ts), so anything it remembered
// would reset on every redeploy — and a trail with gaps is worse than no trail,
// because it reads as complete. KeeperHub's record is server-side, survives
// redeploys, and is the same record that settled whether each transaction
// actually landed.

export interface TrailEntry {
  id: string;
  status: string;
  startedAt?: string;
  fn?: string;
  contract?: string;
  hash?: string;
  blockNumber?: number;
  gasUnits?: string;
  sponsored?: boolean;
  error?: string | null;
}

export const DEFAULT_TRAIL_LIMIT = 6;
export const MAX_TRAIL_LIMIT = 15;

// Fetch the last `limit` executions and enrich each with what it called.
export async function fetchTrail(limit = DEFAULT_TRAIL_LIMIT): Promise<TrailEntry[]> {
  const capped = Math.min(Math.max(limit, 1), MAX_TRAIL_LIMIT);
  const runs = await kh.listExecutions(capped);
  const out: TrailEntry[] = [];
  for (const run of runs.slice(0, capped)) {
    const base: TrailEntry = {
      id: run.id,
      status: run.status ?? 'unknown',
      startedAt: run.startedAt,
      hash: run.transactionHashes?.[0]?.hash,
      error: run.error,
    };
    try {
      const d = await kh.executionDetail(run.id);
      out.push({
        ...base,
        fn: d.functionName,
        contract: d.contractAddress,
        hash: d.transactionHash ?? base.hash,
        blockNumber: d.blockNumber,
        gasUnits: d.gasUnits,
        sponsored: d.sponsored,
      });
    } catch {
      // A detail lookup failing must not cost the whole trail — the row is
      // still evidence that an execution happened, which is the point.
      out.push(base);
    }
  }
  return out;
}

// Name the well-known contracts so a row reads as an action rather than a hex
// string. Anything unrecognised keeps its address: guessing would be worse.
export function contractLabel(address: string | undefined): string {
  if (!address) return '';
  const a = address.toLowerCase();
  if (a === POSITION_MANAGER.toLowerCase()) return 'position manager';
  if (a === V3_FACTORY.toLowerCase()) return 'v3 factory';
  for (const [symbol, t] of Object.entries(TOKENS)) {
    if (t.address.toLowerCase() === a) return symbol;
  }
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

const STATUS_ICON: Record<string, string> = {
  success: '✅',
  error: '❌',
  system_error: '❌',
  external_error: '❌',
  cancelled: '⬜',
  pending: '⏳',
  running: '⏳',
};

export function statusIcon(status: string): string {
  return STATUS_ICON[status] ?? '❔';
}

// "2026-08-13 09:15" — UTC, and said so, because a trail whose timestamps are
// silently in some local zone cannot be lined up against a block explorer.
export function formatWhen(iso: string | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
}

function shortHash(h: string): string {
  return `${h.slice(0, 10)}…`;
}

export function renderTrailEntry(e: TrailEntry): string {
  const what = e.fn ? `<b>${e.fn}</b>` : '<i>call</i>';
  const where = contractLabel(e.contract);
  const head = `${statusIcon(e.status)} ${what}${where ? ` · ${where}` : ''}`;
  const bits: string[] = [];
  if (e.blockNumber) bits.push(`block ${e.blockNumber.toLocaleString('en-US')}`);
  if (e.gasUnits) bits.push(`${Number(e.gasUnits).toLocaleString('en-US')} gas`);
  if (e.sponsored) bits.push('sponsored');
  const link = e.hash
    ? `<a href="https://etherscan.io/tx/${e.hash}">${shortHash(e.hash)}</a>`
    : `<i>no tx</i>`;
  const lines = [`${head} · ${formatWhen(e.startedAt)}Z`, `     ${link}${bits.length ? ` · ${bits.join(' · ')}` : ''}`];
  if (e.error) lines.push(`     <i>${e.error}</i>`);
  return lines.join('\n');
}

export function renderTrail(entries: TrailEntry[]): string {
  if (!entries.length) return 'no executions recorded yet.';
  return [
    `🧾 <b>audit trail</b> — last ${entries.length}, newest first`,
    '<i>from KeeperHub, the record that outlives this process</i>',
    '',
    ...entries.map(renderTrailEntry),
  ].join('\n');
}
