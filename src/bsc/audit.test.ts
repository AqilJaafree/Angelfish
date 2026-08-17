import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchEtherscan,
  fetchGoPlus,
  flattenSource,
  goPlusVerdict,
  resolveAudit,
  scanSource,
  SourceFetcher,
} from './audit';
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
  const skipped = (): SourceFetcher => async () => ({ status: 'skipped' });
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

  // THE bug this chain was rewritten for. A source that never ran — no API key, or no
  // record of the address — has said nothing about it, and counting that silence as a
  // vote for "unverified" is what badged four BscScan-verified tokens ⚠️ on
  // 2026-08-16. A skipped source keeps the chain moving but must not decide it.
  it('does not cache a negative when a source was skipped rather than answering', async () => {
    const cache: Record<string, AuditResult> = {};
    const checkedAt: Record<string, number> = {};
    const res = await resolveAudit(TOKEN, cache, checkedAt, 1000, [missing(), skipped()]);
    expect(res).toBeUndefined(); // no badge beats a wrong badge
    expect(TOKEN in cache).toBe(false);
    expect(TOKEN in checkedAt).toBe(false);
  });

  it('falls through a skipped source to one that has the contract', async () => {
    const log: string[] = [];
    const res = await resolveAudit(TOKEN, {}, {}, 1000, [
      counted(skipped(), log, 'a'),
      counted(found(), log, 'b'),
    ]);
    expect(log).toEqual(['a', 'b']);
    expect(res?.verified).toBe(true);
  });

  // GoPlus knows an address is verified but cannot hand over the source, so it reports
  // its own risk read. That verdict must be taken as given, not fed to the scanner —
  // scanning an empty string would downgrade every such token to 'unknown'.
  it('takes a verdict source at its word instead of scanning', async () => {
    const verdict: SourceFetcher = async () => ({
      status: 'verified',
      risk: 'caution',
      flags: ['owner-privileged'],
    });
    const cache: Record<string, AuditResult> = {};
    const res = await resolveAudit(TOKEN, cache, {}, 1000, [missing(), verdict]);
    expect(res).toEqual({ verified: true, risk: 'caution', flags: ['owner-privileged'] });
    expect(cache[TOKEN]?.verified).toBe(true); // verified is cached permanently
  });
});

// The keyless source that actually closes the gap. Sourcify and BscScan are separate
// databases, so these mappings are what decide whether a BscScan-verified token gets
// its ✅.
describe('goPlusVerdict', () => {
  it('reads is_open_source=1 as verified', () => {
    expect(goPlusVerdict({ is_open_source: '1' })?.status).toBe('verified');
  });

  it('reads is_open_source=0 as a definitive not-found', () => {
    expect(goPlusVerdict({ is_open_source: '0' })).toEqual({ status: 'not-found' });
  });

  // An address GoPlus has no record of is ignorance, not evidence. Its response for
  // one is `{"code":1,"result":{}}` — a success with nothing in it.
  it('skips rather than voting when the field is missing entirely', () => {
    expect(goPlusVerdict({})).toEqual({ status: 'skipped' });
    expect(goPlusVerdict(undefined)).toEqual({ status: 'skipped' });
  });

  it('maps rug-enabling powers to high risk under the existing flag names', () => {
    const res = goPlusVerdict({
      is_open_source: '1',
      is_mintable: '1',
      is_blacklisted: '1',
      transfer_pausable: '1',
      is_proxy: '1',
      slippage_modifiable: '1',
    });
    expect(res).toMatchObject({ status: 'verified', risk: 'high' });
    expect(res && 'flags' in res && res.flags).toEqual(
      expect.arrayContaining(['has-mint', 'blacklist', 'transfer-gate', 'upgradeable', 'settable-tax'])
    );
  });

  it('maps a live owner to caution, not high', () => {
    const res = goPlusVerdict({
      is_open_source: '1',
      owner_address: '0xae26ca6dceb56172d2af180aa04b90e54caffb0f',
    });
    expect(res).toMatchObject({ status: 'verified', risk: 'caution' });
  });

  // A renounced contract reports the zero address, which is the ABSENCE of a
  // privileged owner. Treating the string as truthy would badge every renounced
  // token 🟡 and make the caution light meaningless.
  it('does not treat a renounced (zero-address) owner as privileged', () => {
    const res = goPlusVerdict({
      is_open_source: '1',
      owner_address: '0x0000000000000000000000000000000000000000',
    });
    expect(res).toEqual({ status: 'verified', risk: 'clean', flags: [] });
  });

  it('reports clean when every power is off', () => {
    expect(goPlusVerdict({ is_open_source: '1', is_mintable: '0', is_proxy: '0' })).toEqual({
      status: 'verified',
      risk: 'clean',
      flags: [],
    });
  });
});

// Etherscan is optional: with no key configured it must not fire a request that can
// only come back "Missing/Invalid API Key". The key is unset in the test env.
//
// It reports 'skipped', NOT 'not-found'. That one word is the whole bug: an
// unconfigured source that claimed "not verified here" gave the chain a second vote it
// had not earned, and with Sourcify holding only ~80% of BSC the chain then cached
// "unverified" for every token Sourcify lacked.
describe('fetchEtherscan without a key', () => {
  it('skips without touching the network, rather than voting not-found', async () => {
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      expect(await fetchEtherscan('0x1')).toEqual({ status: 'skipped' });
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// The key is read at MODULE SCOPE, so these reset the registry and re-import rather
// than setting process.env and calling the existing binding.
describe('EXPLORER_API_KEY name resolution', () => {
  afterEach(() => {
    delete process.env.BSC_EXPLORER_API_KEY;
    delete process.env.ETHERSCAN_API_KEY;
    vi.resetModules();
  });

  const keyWith = async (env: Record<string, string>): Promise<string> => {
    vi.resetModules();
    Object.assign(process.env, env);
    return (await import('./config')).EXPLORER_API_KEY;
  };

  it('accepts the BSC-prefixed name', async () => {
    expect(await keyWith({ BSC_EXPLORER_API_KEY: 'bsc-key' })).toBe('bsc-key');
  });

  // What Etherscan itself calls the key, and so what a key already on the machine is
  // most likely to be named. Not accepting it left the source silently skipped with a
  // perfectly valid key sitting in .env.
  it('accepts the plain ETHERSCAN_API_KEY name', async () => {
    expect(await keyWith({ ETHERSCAN_API_KEY: 'plain-key' })).toBe('plain-key');
  });

  it('prefers the BSC-prefixed name so a chain-specific key can override a shared one', async () => {
    expect(
      await keyWith({ BSC_EXPLORER_API_KEY: 'bsc-key', ETHERSCAN_API_KEY: 'plain-key' })
    ).toBe('bsc-key');
  });

  // `BSC_EXPLORER_API_KEY=` with nothing after it is the commented-out-then-uncommented
  // state, and it is EMPTY not undefined — so this has to fall through on falsiness,
  // not on nullishness, or an empty prefixed name masks a real key.
  it('falls through an empty prefixed name to ETHERSCAN_API_KEY', async () => {
    expect(await keyWith({ BSC_EXPLORER_API_KEY: '', ETHERSCAN_API_KEY: 'plain-key' })).toBe(
      'plain-key'
    );
  });

  it('is empty when neither is set', async () => {
    expect(await keyWith({})).toBe('');
  });
});

describe('fetchGoPlus', () => {
  const TOKEN = '0x4E97F33EC3147E63e4027a5daB6d5bB7376478DD';
  const withFetch = async (
    impl: (url: string) => Response | Promise<Response>,
    run: (seen: string[]) => Promise<void>
  ): Promise<void> => {
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seen.push(String(url));
      return impl(String(url));
    }) as unknown as typeof fetch;
    try {
      await run(seen);
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  const body = (result: unknown): Response =>
    new Response(JSON.stringify({ code: 1, message: 'OK', result }), { status: 200 });

  // GoPlus keys its result map by the LOWERCASED address whatever case was sent, so a
  // checksummed address must not be looked up verbatim — that reads as "no record" and
  // silently costs the token its badge.
  it('finds the record under the lowercased address even when sent a checksummed one', async () => {
    await withFetch(
      () => body({ [TOKEN.toLowerCase()]: { is_open_source: '1' } }),
      async (seen) => {
        expect(await fetchGoPlus(TOKEN)).toMatchObject({ status: 'verified' });
        expect(seen[0]).toContain(TOKEN.toLowerCase());
      }
    );
  });

  it('treats an empty result map as no record rather than unverified', async () => {
    await withFetch(
      () => body({}),
      async () => expect(await fetchGoPlus(TOKEN)).toEqual({ status: 'skipped' })
    );
  });

  // A non-1 `code` is GoPlus reporting its own failure at HTTP 200. Cache nothing.
  it('is transient when GoPlus reports an error code', async () => {
    await withFetch(
      () => new Response(JSON.stringify({ code: 4029, message: 'busy' }), { status: 200 }),
      async () => expect(await fetchGoPlus(TOKEN)).toBeUndefined()
    );
  });

  it('is transient on a network failure', async () => {
    await withFetch(
      () => {
        throw new Error('socket hang up');
      },
      async () => expect(await fetchGoPlus(TOKEN)).toBeUndefined()
    );
  });

  it('retries a rate-limit response before giving up', async () => {
    await withFetch(
      () => new Response('', { status: 429 }),
      async (seen) => {
        expect(await fetchGoPlus(TOKEN)).toBeUndefined();
        expect(seen.length).toBe(3);
      }
    );
  });

  // One address per request. A batch silently answers for only some of them.
  it('asks for exactly one address', async () => {
    await withFetch(
      () => body({ [TOKEN.toLowerCase()]: { is_open_source: '1' } }),
      async (seen) => {
        await fetchGoPlus(TOKEN);
        expect(seen[0]?.match(/0x[0-9a-f]{40}/g)?.length).toBe(1);
      }
    );
  });
});
