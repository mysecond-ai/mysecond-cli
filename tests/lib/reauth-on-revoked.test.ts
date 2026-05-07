// v1.4.3 — re-auth on revoked token regression tests.
//
// The bug: when step 15 (device-code OAuth) is marked complete in the ledger,
// the runner skipped it on subsequent invocations. If the customer's
// companion_api_key had been revoked server-side (via dashboard "remove
// device" or expiry), the customer was stuck with a stale credential and
// silent 401s on every subsequent sync — with no recovery path short of
// passing --resume (which they don't know about).
//
// The fix: step 15 always runs, regardless of ledger state. It is
// self-idempotent (fetchWhoami short-circuits on success) and is the only
// mechanism that detects server-side token revocation.
//
// These are structural source-level assertions, matching the established
// pattern in auth-only-invariants.test.ts. Behavioral integration coverage
// of the runner would require mocking step 15's network calls, keychain,
// and pending-auth I/O — out of scope for a 3-line runner fix.

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

describe('v1.4.3 — re-auth on revoked token (step 15 always runs)', () => {
  const source = readFileSync(RUNNER_PATH, 'utf8');

  it('declares an alwaysRunStep15 gate that bypasses ledger-skip', () => {
    // The runner must compute alwaysRunStep15 from the entry number and
    // honor it in the ledger-skip condition. Removing this guard reverts
    // to the v1.4.2 bug.
    expect(source).toContain('const alwaysRunStep15 = entry.number === 15');
  });

  it('skips the ledger-completion gate when alwaysRunStep15 is true', () => {
    // The skip must check both completion AND !alwaysRunStep15. If a future
    // refactor drops the !alwaysRunStep15 clause, step 15 gets skipped on
    // every re-run after the first install — reintroducing the silent 401
    // bug for any customer who revokes a device.
    expect(source).toMatch(
      /isStepComplete\(state,\s*entry\.number\)\s*&&\s*!alwaysRunStep15/
    );
  });

  it('removes the obsolete resumeForcesStep15 variable', () => {
    // Subsumed by alwaysRunStep15. Keeping both creates two semantically
    // overlapping gates and invites drift. The fix replaces resumeForcesStep15
    // with the broader alwaysRunStep15 — the variable name should be gone
    // entirely.
    expect(source).not.toContain('resumeForcesStep15');
  });
});
