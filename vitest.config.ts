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
    //
    // The explorer keys are pinned EMPTY for the same reason. `fetchEtherscan` decides
    // whether to skip by reading them at module scope, and the "without a key" test
    // asserts it never touches the network — so a key present in the developer's .env
    // would turn that test into a live API call against Etherscan. Both names are
    // pinned because either one enables the source.
    env: {
      LOG_LEVEL: 'silent',
      TELEGRAM_BOT: 'test:token',
      TELEGRAM_CHAT_ID: '-1000000000000',
      BSC_EXPLORER_API_KEY: '',
      ETHERSCAN_API_KEY: '',
    },
  },
});
