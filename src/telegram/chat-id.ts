import '../env';
import fs from 'fs';
import path from 'path';

// Discover the chat id to post boards to.
//
// A Telegram bot cannot start a conversation — the chat has to reach out first,
// and only then does its id appear in getUpdates. So this waits: send any message
// to the bot (or add it to a group and post there), and this picks the chat up and
// writes TELEGRAM_CHAT_ID into .env.
//
// NOTE: getUpdates conflicts with a running long-poller on the same token. This
// project never polls, so there is nothing to conflict with here.

const TOKEN = process.env.TELEGRAM_BOT ?? process.env.TELEGRAM_BOT_TOKEN;
const ENV_FILE = path.join(process.cwd(), '.env');
const WAIT_SECONDS = parseInt(process.env.CHAT_ID_WAIT_SECONDS ?? '120', 10);

interface Chat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
}

interface Update {
  message?: { chat: Chat; message_thread_id?: number };
  channel_post?: { chat: Chat; message_thread_id?: number };
  my_chat_member?: { chat: Chat };
}

function describe(chat: Chat): string {
  const name = chat.title ?? chat.username ?? chat.first_name ?? '(no name)';
  return `${chat.id}  [${chat.type}]  ${name}`;
}

async function poll(): Promise<Map<number, Chat>> {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?timeout=25`, {
    signal: AbortSignal.timeout(35000),
  });
  const json = (await res.json()) as { ok: boolean; description?: string; result?: Update[] };
  if (!json.ok) throw new Error(`getUpdates failed: ${json.description}`);
  const chats = new Map<number, Chat>();
  for (const u of json.result ?? []) {
    const chat = (u.message ?? u.channel_post ?? u.my_chat_member)?.chat;
    if (chat) chats.set(chat.id, chat);
  }
  return chats;
}

function writeEnv(chatId: number): void {
  let contents = '';
  try {
    contents = fs.readFileSync(ENV_FILE, 'utf8');
  } catch {
    /* creating it fresh is fine */
  }
  if (/^TELEGRAM_CHAT_ID=/m.test(contents)) {
    contents = contents.replace(/^TELEGRAM_CHAT_ID=.*$/m, `TELEGRAM_CHAT_ID=${chatId}`);
  } else {
    contents = contents.replace(/\n*$/, '\n') + `TELEGRAM_CHAT_ID=${chatId}\n`;
  }
  fs.writeFileSync(ENV_FILE, contents);
}

async function main(): Promise<void> {
  if (!TOKEN) {
    console.error('No TELEGRAM_BOT token in .env — nothing to look up.');
    process.exit(1);
  }
  const me = (await (await fetch(`https://api.telegram.org/bot${TOKEN}/getMe`)).json()) as {
    ok: boolean;
    result?: { username?: string };
  };
  if (!me.ok) {
    console.error('Bot token rejected by Telegram.');
    process.exit(1);
  }
  const handle = me.result?.username ? `@${me.result.username}` : 'the bot';
  console.log(`Waiting for a chat to reach ${handle}…`);
  console.log(`  • DM it: open https://t.me/${me.result?.username ?? ''} and send /start`);
  console.log('  • or add it to a group and send any message there');
  console.log(`Listening for up to ${WAIT_SECONDS}s.\n`);

  const deadline = Date.now() + WAIT_SECONDS * 1000;
  do {
    const chats = await poll();
    if (chats.size) {
      console.log('Found:');
      for (const chat of chats.values()) console.log('  ' + describe(chat));
      const [first] = chats.values();
      writeEnv(first.id);
      console.log(`\nWrote TELEGRAM_CHAT_ID=${first.id} to .env`);
      if (chats.size > 1) console.log('(more than one chat seen — edit .env if that is the wrong one)');
      return;
    }
  } while (Date.now() < deadline);

  console.log('No chat reached the bot in time. Message it, then run this again.');
  process.exit(1);
}

void main();
