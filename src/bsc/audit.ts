import { RiskLevel, AuditResult } from '../types';
import { logger } from '../logger';
import {
  AUDIT_ENABLED,
  EXPLORER_API,
  EXPLORER_API_KEY,
  EXPLORER_CHAIN_ID,
  SOURCIFY_API,
} from './config';

// THE ETHEREUM BUILD USED BLOCKSCOUT AND THAT IS NOT AVAILABLE HERE. There is no
// Blockscout instance for BNB Chain at all — bsc.blockscout.com,
// bscscan.blockscout.com, binance.blockscout.com and bnb.blockscout.com all answer
// 404 — and BscScan's own V1 API is retired, answering every request with
// `"You are using a deprecated V1 endpoint, switch to Etherscan API V2"`. So the
// sources below are different providers with different response shapes, not a
// changed base URL.
//
// Etherscan's V2 multichain API, at chainid=56. Optional second source — see
// resolveAudit for the ordering and why Sourcify leads.
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

// What one source can say about an address. The three outcomes are deliberately
// distinct, because conflating any two of them breaks the caching rules:
//   'found'     — verified source, scan it and cache permanently
//   'not-found' — definitively not verified HERE; another source may still have it
//   undefined   — transient (timeout, rate limit, bad key); cache NOTHING
export type SourceLookup =
  | { status: 'found'; source: string }
  | { status: 'not-found' }
  | undefined;

export type SourceFetcher = (token: string) => Promise<SourceLookup>;

// Sourcify. No API key, and its `sources` is already a flat `{path: {content}}` map,
// so flattening is a join rather than Etherscan's brace-unwrapping.
export async function fetchSourcify(token: string): Promise<SourceLookup> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${SOURCIFY_API}/v2/contract/${EXPLORER_CHAIN_ID}/${token}?fields=sources`, {
        headers: { 'user-agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15000),
      });
      // A clean, definitive "nobody has verified this" — unlike Etherscan, which
      // signals the same condition with a 200 and an empty field.
      if (res.status === 404) return { status: 'not-found' };
      if (res.status === 429 || res.status === 503) {
        if (attempt < 2) await sleep(400 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        logger.warn({ token, status: res.status }, 'movers: sourcify lookup failed');
        return undefined;
      }
      const body = (await res.json()) as { sources?: Record<string, { content?: string }> };
      const files = Object.values(body.sources ?? {});
      if (files.length === 0) return { status: 'not-found' };
      // Joined, not just the entry file: a mint or blacklist usually lives in an
      // inherited base, so scanning one file would quietly miss the common case.
      return { status: 'found', source: files.map((f) => f.content ?? '').join('\n') };
    } catch (err) {
      logger.warn({ err, token }, 'movers: sourcify lookup failed');
      return undefined;
    }
  }
  logger.warn({ token, attempts: 3 }, 'movers: sourcify rate-limited, giving up');
  return undefined;
}

// Etherscan V2. Skipped entirely when no key is configured, rather than firing calls
// that can only come back "Missing/Invalid API Key".
export async function fetchEtherscan(token: string): Promise<SourceLookup> {
  if (!EXPLORER_API_KEY) return { status: 'not-found' };
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
        logger.warn({ token, status: res.status }, 'movers: etherscan lookup failed');
        return undefined;
      }
      const body = (await res.json()) as EtherscanResponse;
      // Etherscan answers HTTP 200 for everything and puts the verdict in `status`,
      // so an error is not visible from the status code. `result` is a bare string on
      // error ("Missing/Invalid API Key", "Max rate limit reached") and an array on
      // success.
      if (!Array.isArray(body.result)) {
        const detail = typeof body.result === 'string' ? body.result : body.message;
        if (/rate limit/i.test(detail ?? '')) {
          if (attempt < 2) await sleep(400 * (attempt + 1));
          continue;
        }
        // Not transient (a bad key, a malformed address). Returning undefined rather
        // than 'not-found' means nothing is cached, so a corrected key takes effect
        // immediately instead of after the negative TTL.
        logger.warn({ token, detail }, 'movers: etherscan lookup rejected');
        return undefined;
      }
      // An unverified address still returns a row, with an empty SourceCode and an
      // ABI of "Contract source code not verified".
      const source = body.result[0]?.SourceCode ?? '';
      if (!source.trim()) return { status: 'not-found' };
      return { status: 'found', source: flattenSource(source) };
    } catch (err) {
      logger.warn({ err, token }, 'movers: etherscan lookup failed');
      return undefined;
    }
  }
  logger.warn({ token, attempts: 3 }, 'movers: etherscan rate-limited, giving up');
  return undefined;
}

// Resolve a token's audit result, cache-first. Verification and risk both come from
// one source lookup. Definitive results are cached — permanently when verified, under
// UNVERIFIED_TTL_MS when not. Transient failures return `undefined` WITHOUT caching
// (no badge, retry next cycle).
//
// TWO SOURCES, TRIED IN ORDER. Sourcify first because it needs no key and covered 80%
// of real board tokens when measured; Etherscan second, covering what Sourcify lacks,
// and skipped when unconfigured. Only if BOTH say "not verified" is the negative
// cached — a single source's ignorance is not evidence a contract is unverified.
//
// A transient failure from either source abandons the whole lookup rather than
// falling through. Otherwise a Sourcify outage would silently demote every token to
// whatever Etherscan happened to say, and — worse — a total outage of both would cache
// "unverified" across the board.
// The default chain. Injectable so the ordering and caching rules can be tested
// without mocking `fetch` — the rules are the part worth pinning, and each fetcher
// is covered separately against its own provider's response shape.
export const DEFAULT_SOURCES: SourceFetcher[] = [fetchSourcify, fetchEtherscan];

export async function resolveAudit(
  token: string,
  cache: Record<string, AuditResult>,
  checkedAt: Record<string, number>,
  now: number = Date.now(),
  sources: SourceFetcher[] = DEFAULT_SOURCES
): Promise<AuditResult | undefined> {
  if (!AUDIT_ENABLED) return undefined;

  const hit = cache[token];
  if (hit && (hit.verified || now - (checkedAt[token] ?? 0) < UNVERIFIED_TTL_MS)) return hit;

  const remember = (result: AuditResult): AuditResult => {
    cache[token] = result;
    checkedAt[token] = now;
    return result;
  };

  for (const lookup of sources) {
    const found = await lookup(token);
    if (found === undefined) return undefined; // transient — cache nothing, retry
    if (found.status === 'not-found') continue; // ask the next source
    const { level, flags } = scanSource(found.source);
    logger.debug({ token, flags, level }, 'movers: audit scan');
    return remember({ verified: true, risk: level, flags });
  }
  // Every source agrees. Definitive, so it is cached — but under the TTL, since a
  // token often gets verified days after it starts trading.
  return remember({ verified: false, risk: 'unknown' });
}
