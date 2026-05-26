import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// esbuild injects `__VERSION__` at build time (esbuild.config.mjs). vitest
// runs TS source directly with no esbuild step, so `__VERSION__` is
// undefined inside tests without an explicit define. Use the same value
// esbuild would inject — package.json#version — so any test that exercises
// version-aware code paths (e.g., issue #34 upgrade nag) sees the real
// shipping version.
const pkgVersion = JSON.parse(readFileSync('./package.json', 'utf-8')).version as string;

export default defineConfig({
  define: {
    __VERSION__: JSON.stringify(pkgVersion),
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
    // CI-flake fix (2026-04-22 PR 4c R2 fold): several tests stub
    // `process.env.HOME` to redirect ~/.mysecond to a tmpdir for cache-write
    // isolation. Default `pool: 'threads'` shares process.env across worker
    // threads — on multi-core CI, parallel test files race on HOME and one
    // file's stub leaks into another file's read. Symptom: lkg cache test
    // returns a pre-seeded version 0.9.0 from the back-compat fixture in a
    // different test file. `pool: 'forks'` gives each test file its own
    // process with isolated env; eliminates the race at a small startup cost.
    pool: 'forks',
  },
});
