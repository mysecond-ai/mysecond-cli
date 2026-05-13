// v1.4.4 — step 15 deprecation-aware rejection message.
//
// When /whoami rejects an existing credential, step 15 clears ctx.apiKey
// and emits a re-auth log line. The message must distinguish two cases:
//
//   1. The rejected key was a legacy team-shared companion_api_key
//      (not msd_-prefixed). Server-side PR3b stops accepting these;
//      the customer needs to know *why* their key was retired, not just
//      that "something was wrong."
//   2. The rejected key was a genuine msd_ device token (revoked via
//      dashboard, expired, or unauthenticatable). The existing generic
//      message is correct here.
//
// Structural assertions matching the established pattern in
// reauth-on-revoked.test.ts. Behavioral coverage of the runner would
// require mocking step 15's /whoami call, keychain I/O, and pending-auth
// state — out of scope for a one-branch message split.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const STEP15_PATH = join(
  import.meta.dirname ?? __dirname,
  '..',
  '..',
  'src',
  'lib',
  'steps',
  'step-15.ts'
);

describe('v1.4.4 — step 15 deprecation-aware rejection message', () => {
  const source = readFileSync(STEP15_PATH, 'utf8');

  it('snapshots the rejected key before clearing ctx.apiKey', () => {
    // The rejection branch must capture ctx.apiKey into rejectedKey
    // BEFORE the (ctx as { apiKey: string }).apiKey = '' clear, so the
    // message branch can read the prefix. If the snapshot moves after
    // the clear, the prefix check always sees '' and the legacy message
    // never fires.
    const snapshotIdx = source.indexOf('const rejectedKey = ctx.apiKey');
    expect(snapshotIdx).toBeGreaterThan(0);
    // The clear we care about is the one in the rejection branch, AFTER
    // the snapshot. step-15 has an earlier clear in the --resume path
    // (line ~98); using lastIndexOf or scanning past the snapshot avoids
    // a false positive against that one.
    const clearIdxAfterSnapshot = source.indexOf(
      "(ctx as { apiKey: string }).apiKey = ''",
      snapshotIdx
    );
    expect(clearIdxAfterSnapshot).toBeGreaterThan(snapshotIdx);
  });

  it('branches the rejection message on the msd_ prefix', () => {
    // Source-based gating at context-build catches legacy keys at startup;
    // step 15's rejection message is the second-line safety net. If a
    // legacy key slips past the warning (silent mode, missed env capture),
    // the rejection line must still tell the customer their team key was
    // retired, not just that "something was rejected."
    expect(source).toMatch(/rejectedKey\.startsWith\(['"]msd_['"]\)/);
  });

  it('emits a deprecation-aware message for non-msd_ rejected keys', () => {
    expect(source).toContain('your legacy team key has been retired');
  });

  it('preserves the generic message for genuine msd_ token revoke/expire', () => {
    // Regression guard: a future refactor must not collapse both branches
    // into the legacy-deprecation wording. Customers whose msd_ tokens
    // were revoked via the dashboard would get a confusing "legacy team
    // key" message that doesn't match their situation.
    expect(source).toContain('existing credential rejected by server — re-authenticating');
  });
});
