import { describe, it, expect } from 'vitest';
import {
  addressArg,
  addressAt,
  decodeSwapLog,
  decodeSymbol,
  hasWords,
  bytes32Arg,
  toInt256,
  uintArg,
  wordAt,
} from './decode';

const word = (hex: string): string => hex.padStart(64, '0');

describe('bytes32Arg', () => {
  // PancakeSwap Infinity keys poolIdToPoolKey on the FULL bytes32, so the id must
  // survive untouched. The Ethereum build had to truncate to bytes25 for Uniswap
  // v4's mapping; doing that here reads the wrong slot and returns an empty key.
  it('passes a full bytes32 through unchanged', () => {
    const poolId = '0x' + 'ab'.repeat(32);
    const arg = bytes32Arg(poolId);
    expect(arg).toHaveLength(64);
    expect(arg).toBe('ab'.repeat(32));
  });

  it('does not truncate the low 7 bytes', () => {
    const poolId = '0x' + 'ab'.repeat(25) + 'cd'.repeat(7);
    expect(bytes32Arg(poolId).slice(50)).toBe('cd'.repeat(7));
  });
});

describe('hasWords', () => {
  it('rejects the bare 0x an RPC can return in place of an error', () => {
    expect(hasWords('0x', 1)).toBe(false);
    expect(hasWords(undefined, 1)).toBe(false);
  });

  it('accepts a genuine zero word', () => {
    expect(hasWords('0x' + word('0'), 1)).toBe(true);
  });

  it('counts words, not bytes', () => {
    expect(hasWords('0x' + word('1').repeat(4), 5)).toBe(false);
    expect(hasWords('0x' + word('1').repeat(5), 5)).toBe(true);
  });
});

describe('toInt256', () => {
  it('sign-extends a negative two\'s-complement word', () => {
    expect(toInt256(BigInt('0x' + 'f'.repeat(64)))).toBe(-1n);
  });

  it('leaves a positive word alone', () => {
    expect(toInt256(1234n)).toBe(1234n);
  });
});

describe('argument encoders', () => {
  it('right-pads addresses to a full word', () => {
    expect(addressArg('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')).toBe(
      word('c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')
    );
  });

  it('encodes a fee tier as a uint word', () => {
    expect(uintArg(3000)).toBe(word('bb8'));
  });
});

describe('decodeSwapLog', () => {
  it('reads sender/recipient from topics and the amounts from data', () => {
    const log = {
      address: '0xPOOL',
      topics: [
        '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67',
        '0x' + word('aa'.repeat(20)),
        '0x' + word('bb'.repeat(20)),
      ],
      data:
        '0x' +
        'f'.repeat(64) + // amount0 = -1
        word('64') + // amount1 = 100
        word('1' + '0'.repeat(20)), // sqrtPriceX96
    };
    const s = decodeSwapLog(log);
    expect(s.sender).toBe('0x' + 'aa'.repeat(20));
    expect(s.recipient).toBe('0x' + 'bb'.repeat(20));
    expect(s.amount0).toBe(-1n);
    expect(s.amount1).toBe(100n);
    expect(s.sqrtPriceX96).toBeGreaterThan(0n);
  });
});

describe('decodeSymbol', () => {
  it('decodes an ABI-encoded string', () => {
    const text = Buffer.from('WBNB', 'utf8').toString('hex');
    const result = '0x' + word('20') + word('4') + text.padEnd(64, '0');
    expect(decodeSymbol(result)).toBe('WBNB');
  });

  it('returns empty for a truncated response rather than throwing', () => {
    expect(decodeSymbol('0x')).toBe('');
  });
});

describe('wordAt / addressAt', () => {
  it('returns 0n past the end of the data', () => {
    expect(wordAt('0x' + word('1'), 5)).toBe(0n);
  });

  it('reads the low 20 bytes as the address', () => {
    expect(addressAt('0x' + word('c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'), 0)).toBe(
      '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
    );
  });
});
