import { RiskLevel, AuditResult } from '../types';
import { logger } from '../logger';
import {
  AUDIT_ENABLED,
  EXPLORER_API,
  EXPLORER_API_KEY,
  EXPLORER_CHAIN_ID,
} from './config';

// Etherscan's V2 multichain API, at chainid=56.
//
// THE ETHEREUM BUILD USED BLOCKSCOUT AND THAT IS NOT AVAILABLE HERE. There is no
// Blockscout instance for BNB Chain at all — bsc.blockscout.com,
// bscscan.blockscout.com, binance.blockscout.com and bnb.blockscout.com all answer
// 404 — and BscScan's own V1 API is retired, answering every request with
// `"You are using a deprecated V1 endpoint, switch to Etherscan API V2"`. So this is
// a different provider with a different response shape, not a changed base URL, and
// it needs a (free) API key where Blockscout needed none.
function sourceUrl(token: string): string {
  const q = new URLSearchParams({
    chainid: EXPLORER_CHAIN_ID,
    module: 'contract',
    action: 'getsourcecode',
    address: token,
    apikey: EXPLORER_API_KEY,
  });
  return `${EXPLORER_API}?${q}`;
}

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

interface EtherscanSourceResult {
  SourceCode?: string;
  ABI?: string;
  ContractName?: string;
}

interface EtherscanResponse {
  status?: string;
  message?: string;
  result?: EtherscanSourceResult[] | string;
}

// Etherscan packs a multi-file verification into the SINGLE `SourceCode` string, and
// does it in a non-obvious way: for a multi-file contract the value is a JSON
// document wrapped in an EXTRA pair of braces (`{{ ... }}`), whose `sources` map
// holds one entry per file. A single-file contract is returned as plain Solidity.
//
// Both forms are flattened to one blob here, because the scan must see imported
// files too — a mint or blacklist usually lives in an inherited base, so scanning
// only the entry file would quietly stop catching the common case.
//
// A parse failure falls back to the raw string rather than throwing: the scanner is
// a regex heuristic over text and works perfectly well on the unparsed JSON, so a
// surprising shape degrades to a slightly noisier scan instead of no verdict at all.
export function flattenSource(sourceCode: string): string {
  const trimmed = sourceCode.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  const unwrapped = trimmed.startsWith('{{') ? trimmed.slice(1, -1) : trimmed;
  try {
    const parsed = JSON.parse(unwrapped) as {
      sources?: Record<string, { content?: string }>;
    };
    const sources = parsed.sources;
    if (!sources) return trimmed;
    return Object.values(sources)
      .map((f) => f.content ?? '')
      .join('\n');
  } catch {
    return trimmed;
  }
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
      const res = await fetch(sourceUrl(token), {
        headers: { 'user-agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 429 || res.status === 503) {
        if (attempt < 2) await sleep(400 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        logger.warn({ token, status: res.status }, 'movers: audit lookup failed');
        return undefined;
      }
      const body = (await res.json()) as EtherscanResponse;
      // Etherscan answers HTTP 200 for everything and puts the verdict in `status`,
      // so — unlike Blockscout's 404 — an error is not visible from the status code.
      // `result` is a bare string on error ("Missing/Invalid API Key",
      // "Max rate limit reached") and an array on success.
      if (!Array.isArray(body.result)) {
        const detail = typeof body.result === 'string' ? body.result : body.message;
        if (/rate limit/i.test(detail ?? '')) {
          if (attempt < 2) await sleep(400 * (attempt + 1));
          continue;
        }
        // Not transient (a bad key, a malformed address): log once and give no
        // verdict. Caching nothing means a fixed key takes effect immediately.
        logger.warn({ token, detail }, 'movers: audit lookup rejected');
        return undefined;
      }
      const entry = body.result[0];
      // An unverified address still returns a row, with an empty SourceCode and an
      // ABI of "Contract source code not verified". Definitive, so it is cached —
      // but under the TTL, since it is exactly the verdict that goes stale.
      const source = entry?.SourceCode ?? '';
      if (!source.trim()) return remember({ verified: false, risk: 'unknown' });
      const { level, flags } = scanSource(flattenSource(source));
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
