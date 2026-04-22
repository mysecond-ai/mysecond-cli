import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // chalk@5 and ora@8 are ESM-only; run tests in Node's native ESM mode.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
