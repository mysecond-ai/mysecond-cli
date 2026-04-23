// RED-TEAM P0-1 regression: step 9 must reset step9Auth401RetryCount to 0
// after a successful LKG fallback (in ALL three fallback code paths).
//
// Without this, a customer who hits 2 transient 401s served from cache is
// permanently locked out on the 3rd install attempt by the auth-thrash
// circuit breaker (exit 8).
//
// True end-to-end coverage of this requires mocking `child_process.spawnSync`
// + `probeLayerOne` + the `claude` binary itself, which is fragile under
// vitest 1.x. Instead this test is a STRUCTURAL assertion that the fix is
// present in all three fallback return paths in step-9.ts. If a future
// refactor removes any of the resets, this test fails immediately.
//
// The full E2E coverage of this lives in the Phase 6 customer-install smoke
// test (Phase 6 condition #9 — synthetic mysecond init --dry-run).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const STEP9_PATH = join(import.meta.dirname ?? __dirname, '..', '..', 'src', 'lib', 'steps', 'step-9.ts');

describe('RED-TEAM P0-1: step9 resets auth-thrash counter on LKG fallback', () => {
  const source = readFileSync(STEP9_PATH, 'utf8');

  it('source contains the counter-reset line in EVERY LKG fallback success path', () => {
    // Three fallback paths exist:
    //   1. pluginTarball throws network → fallback returned
    //   2. SHA mismatch retry exhausted with network err → fallback returned
    //   3. claude plugin marketplace add failed → fallback returned
    // Each path MUST reset state.step9Auth401RetryCount to 0 + writeSyncState.

    // Count occurrences of the canonical reset pattern.
    const resetPattern = /state\.step9Auth401RetryCount = 0;\s*writeSyncState\(ctx\.rootDir, state\)/g;
    const matches = source.match(resetPattern) ?? [];

    // Expected count:
    //   1 reset on main-path success (post-cache-write, end of doStep9)
    //   3 resets on fallback success paths (per RED-TEAM P0-1 fix)
    // Total = 4.
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  it('every fallback success block contains RED-TEAM P0-1 reset', () => {
    // R2 telemetry calls landed between the counter-reset and the
    // staleCacheBanner, so the original tighter window (600 chars) no longer
    // captures the reset. Widen the window to cover the full ~25-line
    // fallback success block from `fallback !== null` through the return.
    const fallbackReturns = source.match(
      /fallback !== null[\s\S]{0,1200}?return \{ step: 9, outcome: \{ kind: 'completed' \} \};/g
    ) ?? [];

    // 3 fallback return blocks (per the 3 paths above). Each must contain
    // both the counter-reset assignment AND the writeSyncState call.
    expect(fallbackReturns.length).toBe(3);
    for (const block of fallbackReturns) {
      expect(block).toContain('state.step9Auth401RetryCount = 0');
      expect(block).toContain('writeSyncState(ctx.rootDir, state)');
    }
  });

  it('marker comments cite RED-TEAM P0-1 so future readers know why', () => {
    // Anti-rot: link the fix to the finding so a future "looks dead, remove
    // it" cleanup doesn't reintroduce the bug.
    expect(source).toContain('RED-TEAM P0-1');
  });
});
