import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearMute,
  isMuted,
  MAX_INLINE_WAIT_MS,
  muteRemainingMs,
  PROBE_INTERVAL_MS,
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

// retry_after is an upper bound, not a countdown — a quoted 5,255s was observed
// accepting again well before it elapsed. Serving out the full sentence idles
// through a limit that is already gone, so the mute probes.
describe('mute probing', () => {
  let realFetch: typeof globalThis.fetch;
  let attempts: number;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    attempts = 0;
    clearMute();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    clearMute();
  });

  // Every request is counted, so "did anything reach the wire" is checkable.
  const respond = (fn: () => Response): void => {
    globalThis.fetch = (async () => {
      attempts++;
      const r = fn();
      return r.clone();
    }) as unknown as typeof fetch;
  };

  it('lets exactly ONE message through per interval, not the whole cycle', async () => {
    respond(() => flood(5255));
    await sendMessage('trips the mute');
    const afterTrip = attempts;
    expect(isMuted()).toBe(true);

    // A cycle publishing three boards must put at most one probe on the wire —
    // and the trip itself already consumed this interval's slot.
    for (const b of ['board 1', 'board 2', 'board 3']) expect(await sendMessage(b)).toBe(false);
    expect(attempts).toBe(afterTrip);
  });

  it('unmutes the moment a probe succeeds, without waiting out the quote', async () => {
    respond(() => flood(5255));
    await sendMessage('trips the mute');
    expect(muteRemainingMs()).toBeGreaterThan(5_000_000);

    // Force the probe window open, then let Telegram accept.
    clearMute();
    respond(() => ok());
    expect(await sendMessage('probe')).toBe(true);
    expect(isMuted()).toBe(false);
    expect(muteRemainingMs()).toBe(0);
  });

  // The probe must be scheduled well inside the quoted wait, or it never fires.
  it('schedules the next probe inside the quoted wait, not after it', async () => {
    respond(() => flood(5255));
    await sendMessage('trips the mute');
    const quoted = muteRemainingMs();
    expect(quoted).toBeGreaterThan(PROBE_INTERVAL_MS);
    // Just past one probe interval, sending is allowed again even though the
    // quoted wait has hours left.
    const afterInterval = Date.now() + PROBE_INTERVAL_MS + 1000;
    expect(isMuted(afterInterval)).toBe(false);
    expect(muteRemainingMs(afterInterval)).toBeGreaterThan(0);
  });
});
