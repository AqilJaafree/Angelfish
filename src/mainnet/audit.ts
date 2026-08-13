import { RiskLevel, AuditResult } from '../types';
import { logger } from '../logger';
import { AUDIT_ENABLED, EXPLORER_BASE } from './config';

// Blockscout's v2 API. The mainnet instance (eth.blockscout.com) speaks the same
// shape as the Robinhood one — verified 2026-08-13: a verified contract answers
// 200 with is_verified/name/source_code, an unverified address answers 404.
const SOURCE_API = `${EXPLORER_BASE}/api/v2/smart-contracts`;

// How long an "unverified" verdict is trusted before being re-checked. A verified
// result is permanent (source cannot be un-verified), but a token can be verified
// days after it starts trading, and caching the negative forever would leave those
// tokens badged ⚠️⬜ for good.
export const UNVERIFIED_TTL_MS = parseInt(
  process.env.MOVERS_AUDIT_UNVERIFIED_TTL_MS ?? String(6 * 60 * 60 * 1000),
  10
);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Rule {
  pattern: RegExp;
  severity: 'high' | 'caution';
  flag: string;
}

// Advisory heuristic, deliberately non-exhaustive — a 'clean' verdict is NOT a
// safety guarantee (e.g. mint variants like `mintTo`/`adminMint` are not caught).
// NB: no `g` flag — these regexes are reused across calls and `.test()` on a
// global regex is stateful (advances lastIndex). Keep them stateless.
const RULES: Rule[] = [
  // High severity — rug-enabling powers.
  { pattern: /\bfunction\s+mint\b/i, severity: 'high', flag: 'has-mint' },
  {
    pattern: /\bblacklist\b|\bdenylist\b|\bblocklist\b|_isBlacklisted|\bisBot\b/i,
    severity: 'high',
    flag: 'blacklist',
  },
  { pattern: /\bsetTax\b|\bsetFee\b|_taxFee|_feeOnTransfer/i, severity: 'high', flag: 'settable-tax' },
  {
    pattern: /\bdelegatecall\b|\bupgradeTo\b|__UUPS|_implementation|TransparentUpgradeable/i,
    severity: 'high',
    flag: 'upgradeable',
  },
  { pattern: /\bwhenNotPaused\b|\btradingEnabled\b/i, severity: 'high', flag: 'transfer-gate' },
  // Caution — privileged but non-catastrophic.
  { pattern: /\bonlyOwner\b/i, severity: 'caution', flag: 'owner-privileged' },
  {
    pattern: /\bmaxBalanceLimit\b|\bbalanceLimitEnd\b|\bmaxTx\b/i,
    severity: 'caution',
    flag: 'temp-limit',
  },
];

// Strip comments only — keep string literals (import paths live in strings).
// LIMITATION: a `//` inside a string literal (e.g. an https:// URL) is treated as
// a comment; acceptable for a heuristic.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function stripStrings(src: string): string {
  return src.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

// Pure, offline heuristic. Never throws.
export function scanSource(source: string): { level: RiskLevel; flags: string[] } {
  const decommented = stripComments(source);
  if (!/pragma\s+solidity/i.test(decommented)) {
    return { level: 'unknown', flags: ['unparseable'] };
  }
  const code = stripStrings(decommented);
  const flags: string[] = [];
  let high = false;
  let caution = false;
  for (const rule of RULES) {
    if (rule.pattern.test(code)) {
      flags.push(rule.flag);
      if (rule.severity === 'high') high = true;
      else caution = true;
    }
  }
  return { level: high ? 'high' : caution ? 'caution' : 'clean', flags };
}

interface V2Contract {
  is_verified?: boolean;
  name?: string;
  source_code?: string;
  additional_sources?: Array<{ source_code?: string }>;
}

// Blockscout v2 splits a multi-file verification across `source_code` (the primary
// file) and `additional_sources` (its imports). Scan ALL of them joined — scanning
// only the primary file would silently stop catching a mint / blacklist that lives
// in an imported file, which on mainnet is the common case (OpenZeppelin imports).
function combineSources(body: V2Contract): string {
  const extra = (body.additional_sources ?? []).map((s) => s.source_code ?? '');
  return [body.source_code ?? '', ...extra].join('\n');
}

// Resolve a token's audit result from the explorer, cache-first. Verification and
// risk both come from one fetch. Definitive results are cached — permanently when
// verified, under UNVERIFIED_TTL_MS when not. Transient failures return `undefined`
// WITHOUT caching (no badge, retry next cycle).
export async function resolveAudit(
  token: string,
  cache: Record<string, AuditResult>,
  checkedAt: Record<string, number>,
  now: number = Date.now()
): Promise<AuditResult | undefined> {
  if (!AUDIT_ENABLED) return undefined;

  const hit = cache[token];
  if (hit && (hit.verified || now - (checkedAt[token] ?? 0) < UNVERIFIED_TTL_MS)) return hit;

  const remember = (result: AuditResult): AuditResult => {
    cache[token] = result;
    checkedAt[token] = now;
    return result;
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${SOURCE_API}/${token}`, {
        headers: { 'user-agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15000),
      });
      // 404 = this address has no verified source. Definitive, so it is cached —
      // but under the TTL, since it is exactly the verdict that goes stale.
      if (res.status === 404) return remember({ verified: false, risk: 'unknown' });
      if (res.status === 429 || res.status === 503) {
        if (attempt < 2) await sleep(400 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        logger.warn({ token, status: res.status }, 'movers: audit lookup failed');
        return undefined;
      }
      const body = (await res.json()) as V2Contract;
      if (!body.is_verified) return remember({ verified: false, risk: 'unknown' });
      const { level, flags } = scanSource(combineSources(body));
      logger.debug({ token, flags, level }, 'movers: audit scan');
      return remember({ verified: true, risk: level, flags });
    } catch (err) {
      logger.warn({ err, token }, 'movers: audit lookup failed');
      return undefined;
    }
  }
  // Rate-limited on every attempt. Nothing is cached, so the next cycle retries —
  // but this MUST log: `undefined` renders as no badge at all, which on the board
  // is indistinguishable from a healthy row, so a fully-degraded detector would
  // otherwise be completely invisible.
  logger.warn({ token, attempts: 3 }, 'movers: audit lookup rate-limited, giving up');
  return undefined;
}
