import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    // Several tests deliberately exercise the failure paths, which log a warning
    // by design. Silence the logger so a passing run stays readable.
    env: { LOG_LEVEL: 'silent' },
  },
});
