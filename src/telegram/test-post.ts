import '../env';
import { isConfigured, sendBoard, sendMessage } from './sender';
import { MoversRow } from '../types';

// `npm run test-post` — a deliberately synthetic board sent through the REAL
// formatter and sender, to prove the transport end to end without waiting for a
// window that happens to contain the interesting cases.
//
// Every row here is an edge case the live boards only produce occasionally:
// a hostile symbol that must be HTML-escaped, an unknown market cap, a v4
// dynamic fee tier, both RSI extremes, and a row whose audit lookup failed and
// must therefore render no badge at all.
//
// The rows are clearly labelled as a test in the header so nobody mistakes them
// for live data.

const rows: MoversRow[] = [
  {
    pool: '0xtest1',
    token: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    symbol: 'CLEAN',
    volumeUsd: 12_400_000_000_000_000_000n,
    swaps: 88,
    traders: 41,
    feesUsd: 37_000_000_000_000_000n,
    feeTier: '0.3%',
    marketCapUsd: 1_200_000,
    verified: true,
    risk: 'clean',
    rsi: 62,
  },
  {
    pool: '0xtest2',
    token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    symbol: 'RISKY',
    volumeUsd: 5_500_000_000_000_000_000n,
    swaps: 30,
    traders: 12,
    feesUsd: 16_000_000_000_000_000n,
    feeTier: 'dynamic',
    marketCapUsd: 49_800_000_000,
    verified: true,
    risk: 'high',
    rsi: 78,
    rsiLabel: 'overbought',
  },
  {
    // The escaping case: a token that names itself as markup.
    pool: '0xtest3',
    token: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    symbol: '<b>NOT_BOLD</b> & co',
    volumeUsd: 900_000_000_000_000_000n,
    swaps: 7,
    traders: 5,
    feesUsd: 2_700_000_000_000_000n,
    feeTier: '1%',
    marketCapUsd: undefined, // unknown cap -> "MC —"
    verified: false,
    risk: 'unknown',
    rsi: 24,
    rsiLabel: 'oversold',
  },
  {
    // Audit lookup failed this cycle: no badge at all, RSI still warming up.
    pool: '0xtest4',
    token: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    symbol: 'NOBADGE',
    volumeUsd: 40_000_000_000_000_000n,
    swaps: 1,
    traders: 1,
    feesUsd: 120_000_000_000n,
    feeTier: '0.05%',
    marketCapUsd: 0.4, // sub-dollar -> "MC <$1"
  },
];

async function main(): Promise<void> {
  if (!isConfigured()) {
    console.error('Telegram not configured — run `npm run chat-id` first.');
    process.exit(1);
  }

  const header = await sendMessage(
    '🧪 <b>angelfish test post</b>\n<i>synthetic data — not a live board</i>'
  );
  console.log('header message:', header ? 'sent' : 'FAILED');

  const main = await sendBoard(
    { rows, block: 25_740_450, fromBlock: 25_740_445, variant: 'main', label: 'test' },
    'v3'
  );
  console.log('v3 board:', main ? 'sent' : 'FAILED');

  const danger = await sendBoard(
    {
      rows: rows.slice(2),
      block: 25_740_450,
      fromBlock: 25_740_445,
      variant: 'danger',
      label: 'Uniswap v4 (ETH) — TEST',
    },
    'cl'
  );
  console.log('danger board:', danger ? 'sent' : 'FAILED');

  if (!header || !main || !danger) process.exit(1);
  console.log('\nAll test messages delivered.');
}

void main();
