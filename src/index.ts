// MUST stay first — see the note in env.ts. Every bsc module reads
// process.env at module scope, so the file has to be loaded before they load.
import './env';
import fs from 'fs';
import path from 'path';
import { logger } from './logger';
import { POLL_SECONDS, BSC_RPC_URL, BSC_LOG_RPC_URL } from './bsc/config';
import { formatBoard } from './bsc/format';
import { initMovers, moversCycle, CycleResult } from './bsc/v3/worker';
import { initMoversCl, moversCycleCl } from './bsc/infinity/worker';
import { isConfigured, isMuted, muteRemainingMs, sendBoard } from './telegram/sender';
import { MoversBoard } from './types';

const STATE_DIR = process.env.STATE_DIR ?? path.join(process.cwd(), 'tmp');
// Set to 0 to run the indexer without posting (stdout only).
const TELEGRAM_ENABLED = process.env.TELEGRAM_ENABLED !== '0';

// Render to stdout and post to Telegram. Output lives here rather than in the
// workers so the indexing path stays transport-agnostic: the workers return rows
// and know nothing about where they end up.
async function publish(
  result: CycleResult | undefined,
  version: 'v3' | 'cl',
  label: string
): Promise<void> {
  if (!result) return;
  const { fromBlock, toBlock } = result;
  const boards: MoversBoard[] = [];
  if (result.main.length) {
    boards.push({ rows: result.main, block: toBlock, fromBlock, variant: 'main', label });
  }
  if (result.danger.length) {
    boards.push({ rows: result.danger, block: toBlock, fromBlock, variant: 'danger', label });
  }
  // A long flood-wait mutes the transport (see telegram/sender.ts). Check it once
  // per publish so a muted cycle skips posting outright instead of formatting every
  // board and having each send refuse it in turn — the indexing work still
  // happened and the cursor still advanced, only the posting is dropped.
  const muted = TELEGRAM_ENABLED && isMuted();
  if (muted) {
    logger.warn(
      { version, remainingMs: muteRemainingMs(), boards: boards.length },
      'telegram: muted, printing boards to stdout only'
    );
  }
  for (const board of boards) {
    console.log(formatBoard(board));
    // sendBoard never throws — a Telegram outage must not stop the next board
    // from posting, and the block cursor has already been advanced by the worker.
    if (TELEGRAM_ENABLED && !muted) await sendBoard(board, version);
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  initMovers(path.join(STATE_DIR, 'movers-v3.json'));
  initMoversCl(path.join(STATE_DIR, 'movers-infinity.json'));

  const once = process.argv.includes('--once');
  logger.info(
    {
      rpc: BSC_RPC_URL,
      logRpc: BSC_LOG_RPC_URL,
      pollSeconds: POLL_SECONDS,
      once,
      telegram: TELEGRAM_ENABLED ? (isConfigured() ? 'on' : 'unconfigured') : 'off',
    },
    'angelfish: starting'
  );

  // v3 then Infinity, sequentially. They share the call endpoint and free providers
  // rate-limit per-IP, so running them concurrently would only trade a shorter cycle
  // for 429s that both workers then have to back off from. (The v3 sweep uses its
  // own endpoint, but everything after the sweep — every pool resolution, symbol and
  // supply read — goes to the shared one, and that is where the volume is.)
  const tick = async (): Promise<void> => {
    await publish(await moversCycle(), 'v3', 'PancakeSwap v3 (BNB)');
    await publish(await moversCycleCl(), 'cl', 'PancakeSwap Infinity (BNB)');
  };

  await tick();
  if (once) return;
  setInterval(() => {
    void tick();
  }, POLL_SECONDS * 1000);
}

void main();
