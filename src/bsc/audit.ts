import { RiskLevel, AuditResult } from '../types';
import { logger } from '../logger';
import {
  AUDIT_ENABLED,
  EXPLORER_API,
  EXPLORER_API_KEY,
  EXPLORER_CHAIN_ID,
  GOPLUS_API,
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

// What one source can say about an address. The outcomes are deliberately distinct,
// because conflating any two of them breaks the caching rules:
//   'found'     — verified, with source attached; scan it and cache permanently
//   'verified'  — verified, but the source cannot hand over the code, so it reports
//                 its own risk read instead (GoPlus). Cached permanently, unscanned.
//   'not-found' — definitively not verified HERE; another source may still have it
//   'skipped'   — this source never answered the question: unconfigured, or holding
//                 no record of the address. It moves the chain along but casts NO
//                 vote, because silence is not evidence of anything.
//   undefined   — transient (timeout, rate limit, provider error); cache NOTHING
export type SourceLookup =
  | { status: 'found'; source: string }
  | { status: 'verified'; risk: RiskLevel; flags: string[] }
  | { status: 'not-found' }
  | { status: 'skipped' }
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
  // 'skipped', not 'not-found'. An unconfigured source knows nothing about the
  // address, and reporting "not verified here" handed the chain a vote it had not
  // earned — which, with Sourcify holding only ~80% of BSC, is what cached
  // "unverified" against contracts that were verified on BscScan all along.
  if (!EXPLORER_API_KEY) return { status: 'skipped' };
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

// --- GoPlus ---
//
// The keyless source that closes the Sourcify gap. Verifying a contract on BscScan
// does NOT publish it to Sourcify — they are separate databases — so Sourcify's 404
// means "not submitted here" and can never, on its own, justify a ⚠️.
//
// GoPlus reports BscScan's verification state as `is_open_source` and needs no key, so
// this works out of the box rather than only for whoever configures an Etherscan key.
// What it does NOT return is source code, so it reports a verdict instead of feeding
// the regex scan — and its flags are first-hand answers to the exact questions the
// regexes are guessing at, so this is the better read on the tokens it covers.
//
// Every field is a "0"/"1" STRING, and any of them may be absent (a proxy commonly
// omits is_mintable). Absent is read as not-flagged; only the verification field
// itself being absent means "no record".
type GoPlusRecord = Record<string, unknown>;

const isOn = (v: unknown): boolean => v === '1';

// Rug-enabling powers, under the same flag names the source scan already emits so a
// row reads identically whichever source answered for it.
const GOPLUS_HIGH: Array<[field: string, flag: string]> = [
  ['is_honeypot', 'honeypot'],
  ['cannot_sell_all', 'cannot-sell-all'],
  ['is_mintable', 'has-mint'],
  ['is_blacklisted', 'blacklist'],
  ['slippage_modifiable', 'settable-tax'],
  ['personal_slippage_modifiable', 'settable-tax'],
  ['is_proxy', 'upgradeable'],
  ['transfer_pausable', 'transfer-gate'],
  ['can_take_back_ownership', 'reclaimable-ownership'],
  ['hidden_owner', 'hidden-owner'],
  ['owner_change_balance', 'owner-balance-control'],
  ['selfdestruct', 'selfdestruct'],
];

// Privileged but not by itself catastrophic.
const GOPLUS_CAUTION: Array<[field: string, flag: string]> = [
  ['is_whitelisted', 'whitelist'],
  ['external_call', 'external-call'],
  ['is_anti_whale', 'temp-limit'],
  ['anti_whale_modifiable', 'temp-limit'],
  ['trading_cooldown', 'trading-cooldown'],
];

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Pure, offline. Split out from the fetch so the mapping — the part that decides what
// badge a token gets — is testable without a network.
export function goPlusVerdict(record: GoPlusRecord | undefined): SourceLookup {
  // No record at all. GoPlus answers for an address it does not track with a
  // successful `{"code":1,"result":{}}`, which is ignorance, not a verdict.
  const openSource = record?.is_open_source;
  if (openSource !== '0' && openSource !== '1') return { status: 'skipped' };
  if (openSource === '0') return { status: 'not-found' };

  const flags: string[] = [];
  let high = false;
  let caution = false;
  for (const [field, flag] of GOPLUS_HIGH) {
    if (isOn(record?.[field])) {
      if (!flags.includes(flag)) flags.push(flag);
      high = true;
    }
  }
  for (const [field, flag] of GOPLUS_CAUTION) {
    if (isOn(record?.[field])) {
      if (!flags.includes(flag)) flags.push(flag);
      caution = true;
    }
  }
  // A renounced contract reports the ZERO address rather than dropping the field, so
  // this has to compare rather than test for truthiness — otherwise every renounced
  // token comes back 🟡 and the caution light stops meaning anything.
  const owner = record?.owner_address;
  if (typeof owner === 'string' && owner !== '' && owner.toLowerCase() !== ZERO_ADDRESS) {
    flags.push('owner-privileged');
    caution = true;
  }
  return { status: 'verified', risk: high ? 'high' : caution ? 'caution' : 'clean', flags };
}

export async function fetchGoPlus(token: string): Promise<SourceLookup> {
  // ONE address per request, lowercased. The endpoint takes a comma-separated list but
  // does not answer for all of it — a four-address batch returned a single entry with
  // all four already warm in its cache — and it keys the result map by the lowercased
  // address whatever case was sent, so a checksummed lookup reads as "no record".
  const address = token.toLowerCase();
  const url = `${GOPLUS_API}/token_security/56?contract_addresses=${address}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 429 || res.status === 503) {
        if (attempt < 2) await sleep(400 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        logger.warn({ token, status: res.status }, 'movers: goplus lookup failed');
        return undefined;
      }
      const body = (await res.json()) as { code?: number; message?: string; result?: GoPlusRecord };
      // GoPlus answers HTTP 200 for its own failures too and puts the verdict in
      // `code` (1 = OK). Anything else is transient, so cache nothing.
      if (body.code !== 1) {
        logger.warn({ token, code: body.code, detail: body.message }, 'movers: goplus rejected');
        return undefined;
      }
      return goPlusVerdict(body.result?.[address] as GoPlusRecord | undefined);
    } catch (err) {
      logger.warn({ err, token }, 'movers: goplus lookup failed');
      return undefined;
    }
  }
  logger.warn({ token, attempts: 3 }, 'movers: goplus rate-limited, giving up');
  return undefined;
}

// Resolve a token's audit result, cache-first. Verification and risk both come from
// one source lookup. Definitive results are cached — permanently when verified, under
// UNVERIFIED_TTL_MS when not. Transient failures return `undefined` WITHOUT caching
// (no badge, retry next cycle).
//
// THREE SOURCES, TRIED IN ORDER, cheapest-and-richest first:
//   1. Sourcify — keyless, holds ~80% of real board tokens, returns real source.
//   2. Etherscan V2 — real source for what Sourcify lacks, but needs a key, so it is
//      skipped outright when unconfigured.
//   3. GoPlus — keyless, and the only source in the chain that can speak for BSCSCAN'S
//      verification state. No source code, so it reports a verdict.
//
// The first two are ahead of GoPlus because real source lets the scanner see exactly
// what a contract does; GoPlus is the backstop that makes the badge right without any
// configuration at all.
//
// THE NEGATIVE IS CACHED ONLY WHEN EVERY SOURCE ACTUALLY VOTED. A skipped source
// (unconfigured, or holding no record) has said nothing, and treating that silence as
// agreement is precisely what put a ⚠️ on four BscScan-verified tokens: Sourcify 404'd
// them, Etherscan was keyless, and the chain read one 404 as unanimity. When the vote
// is incomplete the lookup returns undefined instead, which renders NO badge — an
// honest blank beats a confident wrong answer.
//
// A transient failure from any source abandons the whole lookup rather than falling
// through. Otherwise a Sourcify outage would silently demote every token to whatever
// the next source happened to say, and — worse — a total outage would cache
// "unverified" across the board.
//
// The chain is injectable so the ordering and caching rules can be tested without
// mocking `fetch` — the rules are the part worth pinning, and each fetcher is covered
// separately against its own provider's response shape.
export const DEFAULT_SOURCES: SourceFetcher[] = [fetchSourcify, fetchEtherscan, fetchGoPlus];

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

  let everySourceVoted = true;
  for (const lookup of sources) {
    const found = await lookup(token);
    if (found === undefined) return undefined; // transient — cache nothing, retry
    if (found.status === 'skipped') {
      everySourceVoted = false; // it never answered; it does not get to decide
      continue;
    }
    if (found.status === 'not-found') continue; // ask the next source
    if (found.status === 'verified') {
      // Verified, but no source to scan — take the provider's own risk read. Scanning
      // the empty string here would downgrade every such token to 'unknown' (⬜).
      logger.debug({ token, flags: found.flags, level: found.risk }, 'movers: audit verdict');
      return remember({ verified: true, risk: found.risk, flags: found.flags });
    }
    const { level, flags } = scanSource(found.source);
    logger.debug({ token, flags, level }, 'movers: audit scan');
    return remember({ verified: true, risk: level, flags });
  }
  // Nobody has it. Cache the negative ONLY on a complete vote — otherwise the answer
  // is "we do not know", which is left uncached and unbadged so the next cycle (or a
  // newly-configured key) can settle it.
  if (!everySourceVoted) return undefined;
  // Every source agrees. Definitive, so it is cached — but under the TTL, since a
  // token often gets verified days after it starts trading.
  return remember({ verified: false, risk: 'unknown' });
}
