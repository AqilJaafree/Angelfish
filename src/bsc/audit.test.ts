import { describe, expect, it } from 'vitest';
import { fetchEtherscan, flattenSource, resolveAudit, scanSource, SourceFetcher } from './audit';
import { AuditResult } from '../types';

// Etherscan's shape, which is NOT Blockscout's. A multi-file verification arrives
// as one string holding a JSON document wrapped in an EXTRA pair of braces; a
// single-file one arrives as plain Solidity. Getting this wrong means scanning only
// the entry file, which silently stops catching a mint or blacklist inherited from
// a base contract — the common case.
describe('flattenSource', () => {
  it('returns plain Solidity unchanged', () => {
    const src = 'pragma solidity ^0.8.0;\ncontract A { function mint() public {} }';
    expect(flattenSource(src)).toBe(src);
  });

  it('unwraps the double-brace multi-file form and joins every file', () => {
    const doc = {
      language: 'Solidity',
      sources: {
        'contracts/Token.sol': { content: 'pragma solidity ^0.8.0;\ncontract Token is Base {}' },
        'contracts/Base.sol': { content: 'contract Base { function mint() internal {} }' },
      },
    };
    const out = flattenSource('{' + JSON.stringify(doc) + '}');
    expect(out).toContain('contract Token');
    expect(out).toContain('function mint'); // the inherited file, not just the entry
  });

  it('handles the single-brace JSON form too', () => {
    const doc = { sources: { 'A.sol': { content: 'contract A {}' } } };
    expect(flattenSource(JSON.stringify(doc))).toBe('contract A {}');
  });

  // The scanner is a regex heuristic over text, so unparsed JSON still scans fine.
  // Degrading to a noisier scan beats returning no verdict at all.
  it('falls back to the raw string on malformed JSON rather than throwing', () => {
    const broken = '{{ not json at all';
    expect(() => flattenSource(broken)).not.toThrow();
    expect(flattenSource(broken)).toBe(broken);
  });

  it('falls back when the document has no sources map', () => {
    const doc = '{' + JSON.stringify({ language: 'Solidity' }) + '}';
    expect(flattenSource(doc)).toBe(doc);
  });

  it('is empty-safe', () => {
    expect(flattenSource('')).toBe('');
    expect(flattenSource('   ')).toBe('');
  });
});

// The heuristic itself is chain-independent and carried over unchanged, but it is
// what the adapter above feeds, so the join is worth pinning end to end.
describe('scanSource through flattenSource', () => {
  it('flags a mint that lives only in an imported file', () => {
    const doc = {
      sources: {
        'Token.sol': { content: 'pragma solidity ^0.8.20;\ncontract Token is ERC20Mintable {}' },
        'ERC20Mintable.sol': { content: 'contract ERC20Mintable { function mint(address to) external onlyOwner {} }' },
      },
    };
    const { level, flags } = scanSource(flattenSource('{' + JSON.stringify(doc) + '}'));
    expect(flags).toContain('has-mint');
    expect(level).toBe('high');
  });

  it('reports unparseable for a blob with no pragma', () => {
    expect(scanSource('{"abi":[]}').level).toBe('unknown');
  });
});

// The two-source chain. These pin the rules that govern CACHING, which is where a
// mistake is invisible on the board but persistent in state: a wrongly-cached
// "unverified" sticks for the TTL, and a wrongly-cached "verified" sticks forever.
//
// The sources are injected rather than mocked through `fetch`, because the ordering
// and caching rules are the part worth pinning; each fetcher is covered separately
// against its own provider's response shape.
describe('resolveAudit source chain', () => {
  const TOKEN = '0x1111111111111111111111111111111111111111';
  const VERIFIED = 'pragma solidity ^0.8.0;\ncontract A { function mint() public {} }';

  const found = (): SourceFetcher => async () => ({ status: 'found', source: VERIFIED });
  const missing = (): SourceFetcher => async () => ({ status: 'not-found' });
  const broken = (): SourceFetcher => async () => undefined;
  const counted = (f: SourceFetcher, log: string[], name: string): SourceFetcher => async (t) => {
    log.push(name);
    return f(t);
  };

  it('scans the first source that has the contract and caches it permanently', async () => {
    const log: string[] = [];
    const cache = {};
    const sources = [counted(found(), log, 'a'), counted(found(), log, 'b')];
    const res = await resolveAudit(TOKEN, cache, {}, 1000, sources);
    expect(res).toEqual({ verified: true, risk: 'high', flags: ['has-mint'] });
    expect(log).toEqual(['a']); // second source never consulted
    // A verified verdict cannot go stale, so a later call must not re-fetch.
    await resolveAudit(TOKEN, cache, {}, 1e15, sources);
    expect(log).toEqual(['a']);
  });

  // Sourcify only holds contracts someone submitted, so its 404 means "not here",
  // not "not verified anywhere". Stopping there would badge the ~20% it lacks as
  // unverified when the second source could have answered.
  it('falls through to the next source when the first has no record', async () => {
    const log: string[] = [];
    const res = await resolveAudit(TOKEN, {}, {}, 1000, [
      counted(missing(), log, 'a'),
      counted(found(), log, 'b'),
    ]);
    expect(log).toEqual(['a', 'b']);
    expect(res?.verified).toBe(true);
  });

  it('caches the negative only when EVERY source says not-found', async () => {
    const cache: Record<string, AuditResult> = {};
    const checkedAt: Record<string, number> = {};
    const res = await resolveAudit(TOKEN, cache, checkedAt, 1000, [missing(), missing()]);
    expect(res).toEqual({ verified: false, risk: 'unknown' });
    expect(cache[TOKEN]).toEqual({ verified: false, risk: 'unknown' });
    expect(checkedAt[TOKEN]).toBe(1000); // TTL'd, so it is re-checked later
  });

  // THE important failure mode. If a transient error were treated as "not-found" and
  // the chain then cached a negative, a Sourcify outage would write "unverified"
  // across the whole board and keep it there for the TTL.
  it('caches NOTHING when a source fails transiently', async () => {
    const cache = {};
    expect(await resolveAudit(TOKEN, cache, {}, 1000, [broken(), found()])).toBeUndefined();
    expect(TOKEN in cache).toBe(false);
  });

  it('abandons the lookup rather than trusting a later source when an earlier one is down', async () => {
    const log: string[] = [];
    const res = await resolveAudit(TOKEN, {}, {}, 1000, [
      counted(broken(), log, 'a'),
      counted(found(), log, 'b'),
    ]);
    expect(res).toBeUndefined();
    expect(log).toEqual(['a']); // never fell through
  });
});

// Etherscan is optional: with no key configured it must not fire a request that can
// only come back "Missing/Invalid API Key". The key is unset in the test env.
describe('fetchEtherscan without a key', () => {
  it('reports not-found without touching the network', async () => {
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      expect(await fetchEtherscan('0x1')).toEqual({ status: 'not-found' });
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
