import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    // Several tests deliberately exercise the failure paths, which log a warning
    // by design. Silence the logger so a passing run stays readable.
    //
    // The Telegram credentials are DUMMIES, and both halves matter. sender.ts reads
    // them at module scope and short-circuits when either is missing, so without
    // them its tests would pass vacuously against a transport that never ran — and
    // pinning them here also guarantees a test run can never reach the real bot,
    // whatever is in the developer's .env.
    env: {
      LOG_LEVEL: 'silent',
      TELEGRAM_BOT: 'test:token',
      TELEGRAM_CHAT_ID: '-1000000000000',
    },
  },
});
