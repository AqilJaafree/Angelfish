import { logger } from '../logger';
import { resolveAudit } from '../mainnet/audit';
import { AuditResult } from '../types';
import { EXPLORER_BASE } from '../mainnet/config';
import { TOKENS } from './config';

// Contract-verification audit for the LP bot.
//
// The indexer already resolves this for every token that reaches a board, so
// the fetching, caching, TTL and rate-limit handling are reused wholesale from
// mainnet/audit.ts rather than reimplemented. What is added here is the part
// the boards do not need: WHICH rules fired, a record of every check, and the
// judgement about which token in a pair is worth checking at all.
//
// This informs, it does not block. The codebase's stance throughout is to
// surface a verdict and let the operator decide — the boards route a risky
// token to Danger Zone rather than hiding it — and /confirm is already the gate
// that stands between a quote and a signature.

// Process-local. The bot holds no durable state by design (see pending.ts), and
// an audit is cheap to redo on restart. The TTL semantics inside resolveAudit
// still apply: a verified result is permanent, an unverified one expires.
const cache: Record<string, AuditResult> = {};
const checkedAt: Record<string, number> = {};

export interface AuditEntry {
  token: string;
  symbol: string;
  at: number;
  result?: AuditResult; // undefined = the lookup itself failed
}

// Audit one token and record the check.
//
// Deliberately keeps NO local history. What the bot actually did — every
// approval, mint and burn it signed — is already recorded durably by KeeperHub
// and read back by trail.ts. A second, in-memory list here would be a worse
// copy of a better record: it would die on restart, cover only this process,
// and disagree with the authoritative one the moment the bot was redeployed.
// The pino line below is the durable trace of the check itself.
export async function auditToken(
  token: string,
  symbol: string,
  now: number = Date.now()
): Promise<AuditEntry> {
  const address = token.toLowerCase();
  const result = await resolveAudit(address, cache, checkedAt, now);
  logger.info(
    { token: address, symbol, verified: result?.verified, risk: result?.risk, flags: result?.flags },
    result ? 'lp: token audit' : 'lp: token audit unavailable'
  );
  return { token: address, symbol, at: now, result };
}

// Which side of a pair is worth auditing.
//
// Only tokens absent from the curated alias table. This is not laziness about
// the majors — it is that the heuristic is miscalibrated for them, and running
// it anyway would be actively misleading. The scan was tuned against memecoin
// launches, and on blue chips it fires on things that are normal for a blue
// chip: USDC and USDT come back 🔴 because they genuinely are upgradeable
// proxies with a mint function. Printing that warning above every routine
// USDC/WETH quote would train the reader to ignore the one time it matters.
//
// A token reached by raw address is exactly the case the audit exists for.
export function tokensNeedingAudit(addresses: string[]): string[] {
  const known = new Set(Object.values(TOKENS).map((t) => t.address.toLowerCase()));
  const out: string[] = [];
  for (const a of addresses) {
    const lower = a.toLowerCase();
    if (!known.has(lower) && !out.includes(lower)) out.push(lower);
  }
  return out;
}

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

// The two badges answer two different questions and stay separate, exactly as
// they do on the boards: ✅/⚠️ is "can we see the source", 🟢🟡🔴⬜ is "what does
// the source do". `✅🔴` and `⚠️⬜` are very different situations.
export function auditBadge(result: AuditResult | undefined): string {
  if (!result) return '❔';
  const mark = result.verified ? '✅' : '⚠️';
  const light =
    result.risk === 'clean' ? '🟢' : result.risk === 'caution' ? '🟡' : result.risk === 'high' ? '🔴' : '⬜';
  return `${mark}${light}`;
}

// A one-line verdict for embedding in a quote.
export function renderAuditLine(entry: AuditEntry): string {
  const link = `<a href="${EXPLORER_BASE}/token/${entry.token}">${shortAddr(entry.token)}</a>`;
  if (!entry.result) return `❔ <b>${entry.symbol}</b> ${link} — audit unavailable, retry`;
  const flags = entry.result.flags?.length ? ` · <i>${entry.result.flags.join(', ')}</i>` : '';
  return `${auditBadge(entry.result)} <b>${entry.symbol}</b> ${link}${flags}`;
}

// The full report for an explicit /audit request.
export function renderAuditReport(entry: AuditEntry): string {
  const link = `<a href="${EXPLORER_BASE}/token/${entry.token}">${shortAddr(entry.token)}</a>`;
  const head = `🔎 <b>${entry.symbol}</b> ${link}`;
  if (!entry.result) {
    return `${head}\n<i>audit unavailable — the explorer lookup failed. Nothing is cached, so try again.</i>`;
  }
  const r = entry.result;
  const lines = [
    head,
    r.verified ? 'source   ✅ verified on the explorer' : 'source   ⚠️ no verified source published',
    `risk     ${auditBadge(r)} ${r.risk}`,
  ];
  if (r.flags?.length) lines.push(`flags    ${r.flags.join(', ')}`);
  if (!r.verified) {
    // An unverified contract is not a clean one — it is one nobody can read.
    lines.push('', '<i>The source is not published, so it could not be scanned at all. ⬜ means unknown, not safe.</i>');
  } else if (r.risk === 'high') {
    lines.push('', '<i>Flags above are rug-enabling powers. On an established token they are often normal — read the flags rather than treating 🔴 as a verdict.</i>');
  } else if (r.risk === 'clean') {
    lines.push('', '<i>Heuristic and deliberately non-exhaustive — clean is not a safety guarantee.</i>');
  }
  return lines.join('\n');
}
