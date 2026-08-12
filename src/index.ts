// MUST stay first — see the note in env.ts. Every mainnet module reads
// process.env at module scope, so the file has to be loaded before they load.
import './env';
import fs from 'fs';
import path from 'path';
import { logger } from './logger';
import { POLL_SECONDS, ETH_RPC_URL } from './mainnet/config';
import { formatBoard } from './mainnet/format';
import { initMovers, moversCycle, CycleResult } from './mainnet/v3/worker';
import { initMoversV4, moversCycleV4 } from './mainnet/v4/worker';
import { isConfigured, sendBoard } from './telegram/sender';
import { MoversBoard } from './types';

const STATE_DIR = process.env.STATE_DIR ?? path.join(process.cwd(), 'tmp');
// Set to 0 to run the indexer without posting (stdout only).
const TELEGRAM_ENABLED = process.env.TELEGRAM_ENABLED !== '0';

// Render to stdout and post to Telegram. Output lives here rather than in the
// workers so the indexing path stays transport-agnostic: the workers return rows
// and know nothing about where they end up.
async function publish(
  result: CycleResult | undefined,
  version: 'v3' | 'v4',
  label: string
): Promise<void> {
  if (!result) return;
  const { fromBlock, toBlock } = result;
  const boards: Array<{ board: MoversBoard; kind: 'v3' | 'v4' | 'danger' }> = [];
  if (result.main.length) {
    boards.push({
      board: { rows: result.main, block: toBlock, fromBlock, variant: 'main', label },
      kind: version,
    });
  }
  if (result.danger.length) {
    boards.push({
      board: { rows: result.danger, block: toBlock, fromBlock, variant: 'danger', label },
      kind: 'danger',
    });
  }
  for (const { board, kind } of boards) {
    console.log(formatBoard(board));
    // sendBoard never throws — a Telegram outage must not stop the next board
    // from posting, and the block cursor has already been advanced by the worker.
    if (TELEGRAM_ENABLED) await sendBoard(board, kind);
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  initMovers(path.join(STATE_DIR, 'movers-v3.json'));
  initMoversV4(path.join(STATE_DIR, 'movers-v4.json'));

  const once = process.argv.includes('--once');
  logger.info(
    {
      rpc: ETH_RPC_URL,
      pollSeconds: POLL_SECONDS,
      once,
      telegram: TELEGRAM_ENABLED ? (isConfigured() ? 'on' : 'unconfigured') : 'off',
    },
    'angelfish: starting'
  );

  // v3 then v4, sequentially. They share one RPC endpoint and free providers
  // rate-limit per-IP, so running them concurrently would only trade a shorter
  // cycle for 429s that both workers then have to back off from.
  const tick = async (): Promise<void> => {
    await publish(await moversCycle(), 'v3', 'Uniswap v3 (ETH)');
    await publish(await moversCycleV4(), 'v4', 'Uniswap v4 (ETH)');
  };

  await tick();
  if (once) return;
  setInterval(() => {
    void tick();
  }, POLL_SECONDS * 1000);
}

void main();
