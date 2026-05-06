// v1.4.2 two-command auth flow — invariant tests.
//
// These are structural source-level assertions (same pattern used by
// step-timing.test.ts) because runInit has too many heavy dependencies
// (network, keychain, child_process, marketplace lock) to unit-test the full
// runner without a sprawling mock surface.
//
// What we're guarding against:
//
//   1. A future refactor of init-runner.ts removes the `!ctx.authOnly` guard
//      around `markStepComplete(... 15)`. If that happens, --resume would skip
//      step 15 (because the ledger says it's done), tries to use an empty
//      apiKey, and breaks every customer in the two-command flow.
//
//   2. A future refactor removes the `!ctx.authOnly` guard around the
//      install.completed telemetry emit. False positives inflate the install
//      funnel top-of-funnel metric for every --auth-only run.
//
//   3. A future refactor removes the unexpired-pending-state reuse in
//      step-15's runAuthOnlyMint. Without it, repeated --auth-only invocations
//      orphan the previous device_code server-side.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const RUNNER_PATH = join(
  import.meta.dirname ?? __dirname,
  '..',
  '..',
  'src',
  'lib',
  'init-runner.ts'
);
const STEP15_PATH = join(
  import.meta.dirname ?? __dirname,
  '..',
  '..',
  'src',
  'lib',
  'steps',
  'step-15.ts'
);

describe('--auth-only invariants — init-runner', () => {
  const source = readFileSync(RUNNER_PATH, 'utf8');

  it('does NOT mark step 15 complete in --auth-only mode (ledger invariant)', () => {
    // The runner must call markStepComplete only when NOT in auth-only mode
    // for step 15. Otherwise --resume would skip the device-token exchange
    // and downstream steps run with an empty apiKey.
    expect(source).toContain('!ctx.dryRun && !(ctx.authOnly && entry.number === 15)');
    expect(source).toContain('markStepComplete(ctx.rootDir, state, entry.number)');
  });

  it('does NOT emit install.completed telemetry in --auth-only mode', () => {
    // Auth-only is mint-only; install hasn't actually completed. Emitting
    // install.completed inflates the funnel metric.
    expect(source).toContain('!ctx.authOnly');
    expect(source).toContain("'mysecond.install.completed'");
    // The completed-emit branch must be guarded by !ctx.authOnly.
    const completedIdx = source.indexOf("'mysecond.install.completed'");
    expect(completedIdx).toBeGreaterThan(0);
    // Look for the guard within ~500 chars before the emit.
    const guardWindow = source.slice(Math.max(0, completedIdx - 500), completedIdx);
    expect(guardWindow).toMatch(/!\s*ctx\.authOnly/);
  });

  it('breaks out of the step loop in --auth-only mode after step 15', () => {
    // Sanity check: the runner's auth-only short-circuit must remain.
    expect(source).toContain('ctx.authOnly && entry.number !== 15');
    expect(source).toMatch(/break;/);
  });
});

describe('--auth-only invariants — step-15 runAuthOnlyMint', () => {
  const source = readFileSync(STEP15_PATH, 'utf8');

  it('reuses an unexpired pending-auth state instead of overwriting', () => {
    // Repeated --auth-only must not orphan a previously-minted device_code.
    expect(source).toContain('readPendingAuth(ctx.rootDir)');
    expect(source).toContain('isPendingAuthExpired(existing)');
    // The reuse path must short-circuit BEFORE requestDeviceCode is called.
    const reuseIdx = source.indexOf('isPendingAuthExpired(existing)');
    const mintIdx = source.indexOf('requestDeviceCode(codeOpts)', reuseIdx);
    expect(reuseIdx).toBeGreaterThan(0);
    expect(mintIdx).toBeGreaterThan(reuseIdx);
  });

  it('writes pending-auth state on a fresh mint', () => {
    // Sanity: the mint path still persists state for --resume to pick up.
    expect(source).toContain('writePendingAuth(ctx.rootDir, state)');
  });
});
