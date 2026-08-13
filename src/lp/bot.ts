import '../env';
import { logger } from '../logger';
import { authorize, usernameMismatch } from './auth';
import { handle, parse } from './commands';
import { BOT_TOKEN, KEEPERHUB_API_KEY, OWNER_ID, WALLET_ADDRESS } from './config';

const API = 'https://api.telegram.org';

interface TgUser { id: number; username?: string; first_name?: string }
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
}
interface TgUpdate { update_id: number; message?: TgMessage }

async function api<T>(method: string, body: Record<string, unknown>, timeoutMs = 70_000): Promise<T | undefined> {
  try {
    const res = await fetch(`${API}/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) {
      logger.error({ method, description: json.description }, 'lp-bot: telegram rejected');
      return undefined;
    }
    return json.result;
  } catch (err) {
    logger.warn({ err, method }, 'lp-bot: telegram request failed');
    return undefined;
  }
}

async function reply(chatId: number, text: string): Promise<void> {
  await api('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

async function onMessage(msg: TgMessage): Promise<void> {
  const text = msg.text?.trim();
  if (!text) return;
  const from = msg.from;
  if (!from) return;

  const sender = {
    id: from.id,
    username: from.username,
    isPrivateChat: msg.chat.type === 'private',
  };
  const verdict = authorize(sender);
  if (!verdict.ok) {
    // Logged at warn: an unauthorised attempt against a wallet-signing bot is
    // worth seeing. The reply is deliberately terse and identical for both
    // rejection reasons, so it cannot be used to probe who the owner is.
    logger.warn(
      { fromId: from.id, username: from.username, chatType: msg.chat.type, reason: verdict.reason },
      'lp-bot: rejected unauthorised message'
    );
    if (sender.isPrivateChat) await reply(msg.chat.id, verdict.detail);
    return;
  }
  if (usernameMismatch(sender)) {
    logger.warn(
      { fromId: from.id, username: from.username },
      'lp-bot: owner id matched but username differs — update LP_OWNER_USERNAME or verify the pinned id'
    );
  }

  const cmd = parse(text);
  if (!cmd) return;
  logger.info({ cmd: cmd.name, args: cmd.args.length }, 'lp-bot: command');
  try {
    await reply(msg.chat.id, await handle(cmd));
  } catch (err) {
    logger.error({ err, cmd: cmd.name }, 'lp-bot: command failed');
    await reply(msg.chat.id, `❌ ${err instanceof Error ? err.message.slice(0, 500) : String(err)}`);
  }
}

async function main(): Promise<void> {
  if (!BOT_TOKEN) {
    logger.error('lp-bot: TELEGRAM_BOT is not set');
    process.exit(1);
  }
  if (!KEEPERHUB_API_KEY) {
    logger.warn('lp-bot: KEEPERHUB_API_KEY is not set — reads and execution will fail until it is');
  }
  if (!WALLET_ADDRESS) {
    logger.warn('lp-bot: LP_WALLET_ADDRESS is not set — /lp cannot build a plan until it is');
  }
  const me = await api<{ username: string }>('getMe', {});
  logger.info({ bot: me?.username, ownerId: OWNER_ID }, 'lp-bot: started, DM-only');

  // Long polling. offset acknowledges everything up to the last update, so a
  // command is never replayed after a restart — replaying a /confirm would be
  // the one bug here that costs money.
  let offset = 0;
  for (;;) {
    const updates = await api<TgUpdate[]>('getUpdates', {
      offset,
      timeout: 50,
      allowed_updates: ['message'],
    });
    if (!updates) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    for (const u of updates) {
      offset = Math.max(offset, u.update_id + 1);
      if (u.message) await onMessage(u.message);
    }
  }
}

main().catch((err) => {
  logger.error({ err }, 'lp-bot: fatal');
  process.exit(1);
});
