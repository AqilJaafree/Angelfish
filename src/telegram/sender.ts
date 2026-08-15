import { logger } from '../logger';
import { BoardKey } from '../bsc/anchors';
import { MoversBoard } from '../types';
import { formatDangerZoneBoard, formatMoversBoardV3, formatMoversBoardCl } from './format';

// The token is named TELEGRAM_BOT here (not TELEGRAM_BOT_TOKEN as in nautilus)
// because that is the key already present in this project's .env.
const BOT_TOKEN = process.env.TELEGRAM_BOT ?? process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
// Which board goes to which forum topic. Both topics now carry PancakeSwap v3,
// split by the currency the pair is quoted in rather than by DEX version.
//
// The OLD names are the fallbacks on purpose. V3_MOVERS_TOPIC_ID kept its meaning
// (it routed the v3 board, and the WBNB board is the v3 board minus its
// stable-quoted pools), and V4_MOVERS_TOPIC_ID now routes the USDT board — the
// topic that used to hold Infinity. Reading them means an existing deployment
// needs no variable changes to land on the intended topics; requiring new names
// would silently reroute both boards to the group's General topic, which looks
// like the bot breaking rather than like a renamed setting.
//
// An unset value is not an error: everything then goes to General, which is the
// correct default for a plain (non-forum) chat.
export type BoardTarget = BoardKey | 'infinity';

// Pure and env-injectable so the fallback chain is testable: it is read once at
// module scope, and getting it wrong does not throw — it quietly posts to General.
export function boardTopics(
  env: NodeJS.ProcessEnv = process.env
): Record<BoardTarget, string | undefined> {
  return {
    wbnb: env.V3_WBNB_MOVERS_TOPIC_ID ?? env.V3_MOVERS_TOPIC_ID,
    usdt: env.V3_USDT_MOVERS_TOPIC_ID ?? env.V4_MOVERS_TOPIC_ID,
    // Infinity has no legacy fallback: both of the topics it could have inherited
    // now belong to a v3 board, so defaulting it to either would put two different
    // boards in one topic. Unset also means the worker does not run — see index.ts.
    infinity: env.INFINITY_MOVERS_TOPIC_ID ?? env.CL_MOVERS_TOPIC_ID,
  };
}

const TOPIC_BY_BOARD = boardTopics();

// Whether a board has somewhere of its own to go. Used to decide whether to RUN
// the Infinity cycle at all: an unrouted board would otherwise spend a full sweep
// and hundreds of eth_calls to produce rows nobody asked for.
export function isBoardRouted(target: BoardTarget): boolean {
  return Boolean(TOPIC_BY_BOARD[target]);
}

const DANGER_TOPIC_ID = process.env.DANGER_ZONE_TOPIC_ID;

const API = 'https://api.telegram.org';

export function isConfigured(): boolean {
  return Boolean(BOT_TOKEN && CHAT_ID);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface TelegramResponse {
  ok: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

// Longest flood-wait this will sit and sleep through. Below it, sleeping and
// retrying is right: the wait is a few seconds and the board still posts on time.
export const MAX_INLINE_WAIT_MS = parseInt(
  process.env.TELEGRAM_MAX_INLINE_WAIT_MS ?? '60000',
  10
);

// How often a mute lets a SINGLE message through to test whether the limit has
// actually lifted. Measured on 2026-08-15: Telegram quoted retry_after 5255s but
// was accepting again well before it elapsed — the value is an upper bound, not a
// countdown, so waiting it out blindly idles through a limit that is already gone.
export const PROBE_INTERVAL_MS = parseInt(
  process.env.TELEGRAM_PROBE_INTERVAL_MS ?? '300000',
  10
);

// When Telegram hands back a long flood-wait, sends are refused until this passes.
// Module state on purpose: the limit applies to the BOT, not to one call, so it has
// to be visible to every other caller.
let mutedUntil = 0;
// The earliest a probe may go out. Exactly one message is allowed per interval —
// consumed by whichever send arrives first, so a cycle publishing three boards
// still puts only ONE on the wire. That single-message ceiling is what keeps
// probing from re-becoming the burst this whole mechanism exists to prevent.
let nextProbeAt = 0;

export function isMuted(now: number = Date.now()): boolean {
  return now < mutedUntil && now < nextProbeAt;
}

export function muteRemainingMs(now: number = Date.now()): number {
  return Math.max(0, mutedUntil - now);
}

// Exported for tests; also lets an operator clear a mute without a restart.
export function clearMute(): void {
  mutedUntil = 0;
  nextProbeAt = 0;
}

// Send one HTML message, honouring `parameters.retry_after` exactly — guessing a
// backoff instead is what turns a brief flood-wait into a ban on the token.
//
// HOW a long wait is honoured is the load-bearing part, and sleeping through it is
// the wrong answer. Observed in production: a 5,849s (1.6h) flood-wait with a 120s
// poll meant every tick started a fresh cycle and its own sleeping send, because
// the `cycleRunning` guard covers the CYCLE and not the publish. That queued ~96
// sends, all of which would have fired the moment the window expired and instantly
// re-tripped the limit — the exact outcome the retry_after is there to prevent.
//
// So a long wait is RECORDED rather than slept through: it mutes the transport,
// later sends are refused cheaply, and no work piles up. Nothing is queued because a
// board is worthless by the time an hours-long wait expires — its block window is
// long gone, and the next cycle's board is strictly better.
//
// The mute PROBES rather than serving out the full sentence. retry_after is an upper
// bound, not a countdown: on 2026-08-15 a quoted 5,255s was accepting again long
// before it elapsed, and a blind wait would have idled ~55 minutes for nothing. So
// one message per PROBE_INTERVAL_MS is let through to test the water, and a success
// clears the mute immediately. The one-per-interval ceiling is what keeps probing
// from turning back into the burst this mechanism exists to prevent.
export async function sendMessage(
  text: string,
  threadId?: string,
  tries = 3
): Promise<boolean> {
  if (!BOT_TOKEN || !CHAT_ID) return false;
  const enteredAt = Date.now();
  if (enteredAt < mutedUntil) {
    if (enteredAt < nextProbeAt) {
      logger.warn(
        { remainingMs: muteRemainingMs(enteredAt) },
        'telegram: muted by an earlier flood-wait, dropping this message'
      );
      return false;
    }
    // This call IS the probe. Consume the slot before sending, so any other board
    // in the same cycle is refused rather than riding along behind it.
    nextProbeAt = enteredAt + PROBE_INTERVAL_MS;
    logger.info(
      { remainingMs: muteRemainingMs(enteredAt) },
      'telegram: probing whether the flood-wait has lifted'
    );
  }
  const body: Record<string, unknown> = {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'HTML',
    // Board rows are full of explorer links; previews would bury the board.
    disable_web_page_preview: true,
  };
  if (threadId) body.message_thread_id = Number(threadId);

  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(`${API}/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      const json = (await res.json()) as TelegramResponse;
      if (json.ok) {
        if (mutedUntil) {
          logger.info(
            { quotedRemainingMs: muteRemainingMs() },
            'telegram: probe succeeded, flood-wait lifted early, unmuting'
          );
          clearMute();
        }
        return true;
      }

      if (json.error_code === 429) {
        const wait = (json.parameters?.retry_after ?? 5) * 1000;
        if (wait > MAX_INLINE_WAIT_MS) {
          const at = Date.now();
          mutedUntil = at + wait;
          // Probe again well before the quoted wait expires — that value is an
          // upper bound, and the limit routinely lifts sooner.
          nextProbeAt = at + Math.min(wait, PROBE_INTERVAL_MS);
          logger.warn(
            { wait, mutedUntilMs: mutedUntil, nextProbeInMs: nextProbeAt - at },
            'telegram: long flood-wait, muting transport instead of sleeping'
          );
          return false;
        }
        logger.warn({ wait }, 'telegram: rate limited, honouring retry_after');
        await sleep(wait);
        continue;
      }
      // 400 is almost always a permanent content or configuration fault (bad
      // chat_id, a thread that does not exist, unparseable HTML). Retrying it
      // just burns the budget, so fail fast and say what Telegram said.
      logger.error(
        { code: json.error_code, description: json.description },
        'telegram: send rejected'
      );
      return false;
    } catch (err) {
      if (attempt >= tries - 1) {
        logger.error({ err }, 'telegram: send failed');
        return false;
      }
      await sleep(500 * 2 ** attempt);
    }
  }
  return false;
}

let warnedUnconfigured = false;

// Post a board. Returns false (having logged) rather than throwing: a send
// failure MUST NOT propagate into the worker, whose caller advances the block
// cursor. Letting it throw would leave the cursor put and re-sweep the same
// window next cycle — re-posting any board that had already succeeded.
export async function sendBoard(
  board: MoversBoard,
  target: BoardTarget
): Promise<boolean> {
  if (!board.rows.length) return false;
  if (!isConfigured()) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      logger.warn(
        { hasToken: Boolean(BOT_TOKEN), hasChatId: Boolean(CHAT_ID) },
        'telegram: not configured, boards will print to stdout only (run `npm run chat-id`)'
      );
    }
    return false;
  }

  const boardTopic = TOPIC_BY_BOARD[target];
  const isDanger = board.variant === 'danger';
  // A Danger Zone board falls back to its OWN board's topic, not to the chat's
  // General topic. Both describe the same pools' swaps, so splitting them across a
  // configured topic and General would scatter one board's data over two places —
  // and General is where a forum puts everything nobody routed, which is the wrong
  // home for a routed board. Set DANGER_ZONE_TOPIC_ID to collect every board's
  // danger rows in one topic instead.
  const topic = isDanger ? (DANGER_TOPIC_ID ?? boardTopic) : boardTopic;
  const text = isDanger
    ? formatDangerZoneBoard(board)
    : target === 'infinity'
      ? formatMoversBoardCl(board)
      : formatMoversBoardV3(board, target);

  const sent = await sendMessage(text, topic);
  if (sent) {
    logger.info(
      { board: target, variant: board.variant ?? 'main', topic, rows: board.rows.length, block: board.block },
      'telegram: board sent'
    );
  }
  return sent;
}
