import { describe, it, expect } from 'vitest';
import { flattenSource, scanSource } from './audit';

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
