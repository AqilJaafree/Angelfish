// MUST stay first — see the note in env.ts. Every bsc module reads
// process.env at module scope, so the file has to be loaded before they load.
import './env';
import fs from 'fs';
import path from 'path';
import { logger } from './logger';
import { POLL_SECONDS, BSC_RPC_URL, BSC_LOG_RPC_URL } from './bsc/config';
import { BOARDS } from './bsc/anchors';
import { formatBoard } from './bsc/format';
import { initMovers, moversCycle } from './bsc/v3/worker';
import { initMoversCl, moversCycleCl } from './bsc/infinity/worker';
import {
  BoardTarget,
  isBoardRouted,
  isConfigured,
  isMuted,
  muteRemainingMs,
  sendBoard,
} from './telegram/sender';
import { MoversBoard, MoversRow } from './types';

const STATE_DIR = process.env.STATE_DIR ?? path.join(process.cwd(), 'tmp');
// Set to 0 to run the indexer without posting (stdout only).
const TELEGRAM_ENABLED = process.env.TELEGRAM_ENABLED !== '0';

// Render to stdout and post to Telegram. Output lives here rather than in the
// workers so the indexing path stays transport-agnostic: the workers return rows
// and know nothing about where they end up.
interface Publishable {
  main: MoversRow[];
  danger: MoversRow[];
  fromBlock: number;
  toBlock: number;
}

async function publish(
  result: Publishable | undefined,
  target: BoardTarget,
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
      { board: target, remainingMs: muteRemainingMs(), boards: boards.length },
      'telegram: muted, printing boards to stdout only'
    );
  }
  for (const board of boards) {
    console.log(formatBoard(board));
    // sendBoard never throws — a Telegram outage must not stop the next board
    // from posting, and the block cursor has already been advanced by the worker.
    if (TELEGRAM_ENABLED && !muted) await sendBoard(board, target);
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  initMovers(path.join(STATE_DIR, 'movers-v3.json'));

  // Infinity runs ONLY when a topic of its own is configured. Both of the topics it
  // could inherit now carry a v3 board, and an unrouted board is not free: it costs
  // a full sweep and hundreds of eth_calls on the shared endpoint to produce rows
  // with nowhere to go. Set INFINITY_MOVERS_TOPIC_ID to bring it back.
  const infinityRouted = isBoardRouted('infinity');
  if (infinityRouted) initMoversCl(path.join(STATE_DIR, 'movers-infinity.json'));

  const once = process.argv.includes('--once');
  logger.info(
    {
      rpc: BSC_RPC_URL,
      logRpc: BSC_LOG_RPC_URL,
      pollSeconds: POLL_SECONDS,
      once,
      boards: [...BOARDS.map((b) => b.key), ...(infinityRouted ? ['infinity'] : [])],
      telegram: TELEGRAM_ENABLED ? (isConfigured() ? 'on' : 'unconfigured') : 'off',
    },
    'angelfish: starting'
  );

  // One v3 sweep produces BOTH boards — WBNB pairs and USDT pairs — so they are
  // published from a single cycle rather than by two workers re-reading the same
  // window. Each carries its own label, which is what the Danger Zone header and
  // the stdout renderer name the source with.
  const tick = async (): Promise<void> => {
    const v3 = await moversCycle();
    if (v3) {
      for (const board of v3.boards) {
        await publish(
          { ...board, fromBlock: v3.fromBlock, toBlock: v3.toBlock },
          board.key,
          board.label
        );
      }
    }
    // Sequential, not concurrent: the v3 sweep has its own endpoint, but every pool
    // resolution, symbol and supply read after it shares one, and free providers
    // rate-limit per-IP. Running both at once trades a shorter cycle for 429s.
    if (infinityRouted) {
      await publish(await moversCycleCl(), 'infinity', 'PancakeSwap Infinity (BNB)');
    }
  };

  await tick();
  if (once) return;
  setInterval(() => {
    void tick();
  }, POLL_SECONDS * 1000);
}

void main();
