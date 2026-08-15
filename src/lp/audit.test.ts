import { describe, expect, it } from 'vitest';
import { AuditEntry, auditBadge, renderAuditLine, renderAuditReport, tokensNeedingAudit } from './audit';
import { TOKENS } from './config';
import { renderAuditBlock } from './commands';

const UNKNOWN = '0x1234567890abcdef1234567890abcdef12345678';
const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  token: UNKNOWN,
  symbol: 'FOO',
  at: 1000,
  ...over,
});

describe('tokensNeedingAudit', () => {
  // The heuristic is calibrated for new tokens, not blue chips: USDC and USDT
  // legitimately come back 🔴 (upgradeable proxies with mint). Auditing them on
  // every routine quote would train the reader to ignore the badge.
  it('skips the curated majors', () => {
    expect(tokensNeedingAudit([TOKENS.USDC.address, TOKENS.WBNB.address])).toEqual([]);
  });

  it('picks out a token reached by raw address — the case the audit is for', () => {
    expect(tokensNeedingAudit([TOKENS.WBNB.address, UNKNOWN])).toEqual([UNKNOWN]);
  });

  it('is case-insensitive against a checksummed address', () => {
    expect(tokensNeedingAudit(['0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'])).toEqual([]);
  });

  it('de-duplicates a pair of the same token', () => {
    expect(tokensNeedingAudit([UNKNOWN, UNKNOWN])).toEqual([UNKNOWN]);
  });
});

describe('auditBadge', () => {
  // Two badges, two questions: can we see the source, and what does it do.
  it('keeps verification separate from risk', () => {
    expect(auditBadge({ verified: true, risk: 'clean' })).toBe('✅🟢');
    expect(auditBadge({ verified: true, risk: 'high' })).toBe('✅🔴');
    expect(auditBadge({ verified: false, risk: 'unknown' })).toBe('⚠️⬜');
  });

  // A failed lookup must not be indistinguishable from a healthy result.
  it('marks an unavailable audit distinctly from a clean one', () => {
    expect(auditBadge(undefined)).toBe('❔');
    expect(auditBadge(undefined)).not.toBe('✅🟢');
  });
});

describe('renderAuditReport', () => {
  it('lists the flags that fired', () => {
    const out = renderAuditReport(entry({ result: { verified: true, risk: 'high', flags: ['has-mint', 'upgradeable'] } }));
    expect(out).toContain('has-mint, upgradeable');
    expect(out).toContain('✅ verified');
  });

  // "Unverified" is not "clean" — it is "nobody can read this".
  it('says an unverified contract could not be scanned at all', () => {
    const out = renderAuditReport(entry({ result: { verified: false, risk: 'unknown' } }));
    expect(out).toContain('no verified source');
    expect(out).toContain('unknown, not safe');
  });

  it('caveats a clean verdict rather than presenting it as a guarantee', () => {
    const out = renderAuditReport(entry({ result: { verified: true, risk: 'clean' } }));
    expect(out).toContain('not a safety guarantee');
  });

  it('reports an unavailable lookup as unavailable, and caches nothing', () => {
    expect(renderAuditReport(entry())).toContain('audit unavailable');
  });
});

describe('renderAuditLine', () => {
  it('links the token to the explorer', () => {
    const out = renderAuditLine(entry({ result: { verified: true, risk: 'caution', flags: ['owner-privileged'] } }));
    expect(out).toContain('✅🟡');
    expect(out).toContain('owner-privileged');
    expect(out).toContain(`/token/${UNKNOWN}`);
  });
});

describe('renderAuditBlock', () => {
  // A routine USDC/WETH quote must not be padded with a paragraph saying nothing.
  it('is empty when both sides are curated majors', () => {
    expect(renderAuditBlock([])).toBe('');
  });

  it('warns distinctly for unverified versus high-risk', () => {
    const unverified = renderAuditBlock([entry({ result: { verified: false, risk: 'unknown' } })]);
    expect(unverified).toContain('no published source');

    const high = renderAuditBlock([entry({ result: { verified: true, risk: 'high', flags: ['has-mint'] } })]);
    expect(high).toContain('rug-enabling');
    expect(high).not.toContain('no published source');
  });

  // Absence of a badge reads like a healthy row unless it is called out.
  it('calls out a lookup that could not be reached', () => {
    expect(renderAuditBlock([entry()])).toContain('absence of a badge is not a pass');
  });
});
