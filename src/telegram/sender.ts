import { logger } from '../logger';
import { MoversBoard } from '../types';
import { formatDangerZoneBoard, formatMoversBoardV3, formatMoversBoardCl } from './format';

// The token is named TELEGRAM_BOT here (not TELEGRAM_BOT_TOKEN as in nautilus)
// because that is the key already present in this project's .env.
const BOT_TOKEN = process.env.TELEGRAM_BOT ?? process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
// Optional forum-topic thread ids. Unset => everything goes to the group's
// General topic, which is the correct default for a plain (non-forum) chat.
const V3_TOPIC_ID = process.env.V3_MOVERS_TOPIC_ID;
// V4_MOVERS_TOPIC_ID is read last for continuity with deployments configured before
// the BNB Chain port: the board it routes is now PancakeSwap Infinity rather than
// Uniswap v4, but it is the same Telegram topic, and dropping the old name would
// silently reroute those boards to the group's General topic — a change that looks
// like the bot quietly breaking rather than a renamed setting.
const CL_TOPIC_ID =
  process.env.INFINITY_MOVERS_TOPIC_ID ??
  process.env.CL_MOVERS_TOPIC_ID ??
  process.env.V4_MOVERS_TOPIC_ID;
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

// Send one HTML message. Retries on 429 for exactly as long as Telegram asks —
// the Bot API returns the required wait in `parameters.retry_after`, and
// guessing a backoff instead of honouring it is what turns a brief flood-wait
// into a ban on the token.
export async function sendMessage(
  text: string,
  threadId?: string,
  tries = 3
): Promise<boolean> {
  if (!BOT_TOKEN || !CHAT_ID) return false;
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
      if (json.ok) return true;

      if (json.error_code === 429) {
        const wait = (json.parameters?.retry_after ?? 5) * 1000;
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
  version: 'v3' | 'cl'
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

  const versionTopic = version === 'v3' ? V3_TOPIC_ID : CL_TOPIC_ID;
  const isDanger = board.variant === 'danger';
  // A Danger Zone board falls back to its OWN version's topic, not to the
  // chat's General topic. Both boards describe the same version's swaps, so
  // splitting them across a configured topic and General would scatter one
  // version's data over two places — and General is where a forum puts
  // everything nobody routed, which is the wrong home for a routed board.
  // Set DANGER_ZONE_TOPIC_ID to collect both versions' danger rows in one topic.
  const topic = isDanger ? (DANGER_TOPIC_ID ?? versionTopic) : versionTopic;
  const text = isDanger
    ? formatDangerZoneBoard(board)
    : version === 'v3'
      ? formatMoversBoardV3(board)
      : formatMoversBoardCl(board);

  const sent = await sendMessage(text, topic);
  if (sent) {
    logger.info(
      { version, variant: board.variant ?? 'main', topic, rows: board.rows.length, block: board.block },
      'telegram: board sent'
    );
  }
  return sent;
}
