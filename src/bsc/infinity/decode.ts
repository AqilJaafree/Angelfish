// PancakeSwap Infinity (CL) log decoders. Reuses the v3 word/address helpers — the
// ABI word layout is identical, only the event shapes differ.
import { RawLog, wordAt, toInt256, addressFromTopic } from '../decode';

export interface DecodedClSwap {
  poolId: string; // bytes32 pool identifier (topics[1], kept as 0x-hex)
  sender: string; // swapper (topics[2]); there is no separate recipient
  amount0: bigint; // int128 currency0 delta (sign-extended in its 32-byte word)
  amount1: bigint; // int128 currency1 delta
  sqrtPriceX96: bigint;
  fee: bigint; // uint24 pips actually charged on this swap (dynamic/hook pools resolve here)
}

// Infinity CL Swap data words:
//   [amount0, amount1, sqrtPriceX96, liquidity, tick, fee, protocolFee]
//
// Uniswap v4's event is the same list WITHOUT the trailing protocolFee. Because the
// extra field is appended rather than inserted, every word this decoder reads keeps
// its index and the function is byte-for-byte the same as the Ethereum build's.
// The signature differs, so the topic0 does too — see CL_SWAP_TOPIC0.
export function decodeClSwapLog(log: RawLog): DecodedClSwap {
  return {
    poolId: log.topics[1],
    sender: addressFromTopic(log.topics[2]),
    amount0: toInt256(wordAt(log.data, 0)),
    amount1: toInt256(wordAt(log.data, 1)),
    sqrtPriceX96: wordAt(log.data, 2),
    fee: wordAt(log.data, 5),
  };
}
