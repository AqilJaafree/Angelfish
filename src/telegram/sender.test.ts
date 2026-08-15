import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearMute,
  isMuted,
  MAX_INLINE_WAIT_MS,
  muteRemainingMs,
  sendMessage,
} from './sender';

// A 429 carrying retry_after, as the Bot API returns it.
const flood = (retryAfterSec: number): Response =>
  new Response(
    JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: retryAfterSec } }),
    { status: 200 }
  );
const ok = (): Response => new Response(JSON.stringify({ ok: true }), { status: 200 });

describe('sendMessage flood-wait handling', () => {
  let realFetch: typeof globalThis.fetch;
  let calls: number;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    calls = 0;
    clearMute();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    clearMute();
    vi.useRealTimers();
  });

  const stub = (responses: Response[]): void => {
    globalThis.fetch = (async () => {
      const r = responses[Math.min(calls, responses.length - 1)];
      calls++;
      return r.clone();
    }) as unknown as typeof fetch;
  };

  // THE regression this file exists for. A 1.6h flood-wait against a 120s poll
  // used to leave every tick sleeping inside its own send: ~96 queued messages
  // that would all fire the instant the window expired and re-trip the limit.
  // A long wait must be RECORDED, never slept through.
  it('mutes instead of sleeping when the wait is long, and returns promptly', async () => {
    stub([flood(5849)]); // the value observed in production
    const started = Date.now();
    const sent = await sendMessage('board');
    const elapsed = Date.now() - started;

    expect(sent).toBe(false);
    expect(elapsed).toBeLessThan(1000); // did NOT sleep 1.6 hours
    expect(calls).toBe(1); // and did NOT burn its retry budget
    expect(isMuted()).toBe(true);
    expect(muteRemainingMs()).toBeGreaterThan(5_000_000);
  });

  it('refuses every later send while muted, without touching the network', async () => {
    stub([flood(5849)]);
    await sendMessage('first');
    const afterFirst = calls;

    for (let i = 0; i < 5; i++) expect(await sendMessage(`queued ${i}`)).toBe(false);
    expect(calls).toBe(afterFirst); // no further requests at all
  });

  // A short wait is the common case and must still behave as before: sleep the
  // exact interval Telegram asked for, then post. Muting there would drop boards
  // over a hiccup.
  it('still sleeps and retries a short wait, and posts on the retry', async () => {
    stub([flood(1), ok()]);
    expect(await sendMessage('board')).toBe(true);
    expect(calls).toBe(2);
    expect(isMuted()).toBe(false);
  });

  it('draws the line at MAX_INLINE_WAIT_MS', async () => {
    stub([flood(Math.floor(MAX_INLINE_WAIT_MS / 1000) + 1)]);
    await sendMessage('board');
    expect(isMuted()).toBe(true);
  });

  it('lets the mute expire rather than needing a restart', async () => {
    stub([flood(120)]);
    await sendMessage('board');
    expect(isMuted()).toBe(true);
    // Far enough forward that the recorded window has passed.
    const later = Date.now() + 121_000;
    expect(isMuted(later)).toBe(false);
    expect(muteRemainingMs(later)).toBe(0);
  });

  it('does not mute on an ordinary rejection', async () => {
    stub([new Response(JSON.stringify({ ok: false, error_code: 400, description: 'bad' }), { status: 200 })]);
    expect(await sendMessage('board')).toBe(false);
    expect(isMuted()).toBe(false);
  });
});
