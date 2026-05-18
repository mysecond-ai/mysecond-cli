// v1.4.8 — `is_invited_pm` propagation through step-15.
//
// Structural source-level assertions (matching the established pattern in
// reauth-on-revoked.test.ts + auth-only-invariants.test.ts). `fetchWhoami`
// is private to step-15.ts, so we verify the contract at the source level
// rather than mocking the global `fetch` + AbortSignal stack.
//
// Contract being defended:
//   1. fetchWhoami's return type includes `isInvitedPm: boolean`.
//   2. The response body is parsed for `is_invited_pm` and defaulted to false.
//   3. The network-error catch defaults `isInvitedPm: false`.
//   4. The non-200 branch defaults `isInvitedPm: false`.
//   5. All THREE fetchWhoami call sites in step-15 capture isInvitedPm into
//      shared.isInvitedPm — full device-code flow, runPollOnly, and the
//      existing-credential-validated path. Missing any one means the invited
//      PM whose token was minted via that path gets the wrong success copy.

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

const STEP13_PATH = join(
  import.meta.dirname ?? __dirname,
  '..',
  '..',
  'src',
  'lib',
  'steps',
  'step-13.ts'
);

const TYPES_PATH = join(
  import.meta.dirname ?? __dirname,
  '..',
  '..',
  'src',
  'lib',
  'steps',
  'types.ts'
);

describe('v1.4.8 — fetchWhoami extends return with isInvitedPm', () => {
  const source = readFileSync(STEP15_PATH, 'utf8');

  it('declares isInvitedPm in the fetchWhoami return type', () => {
    expect(source).toMatch(/isInvitedPm:\s*boolean/);
  });

  it('parses body.is_invited_pm with a false default', () => {
    expect(source).toMatch(/body\?\.is_invited_pm\s*\?\?\s*false/);
  });

  it('returns isInvitedPm: false on non-200 response', () => {
    // The non-200 branch must include isInvitedPm: false so the type stays
    // consistent across all return paths.
    expect(source).toMatch(
      /response\.status\s*!==\s*200[\s\S]{0,200}isInvitedPm:\s*false/
    );
  });

  it('returns isInvitedPm: false on network error (catch branch)', () => {
    expect(source).toMatch(/networkError:\s*true[\s\S]{0,200}?}|isInvitedPm:\s*false[\s\S]{0,200}?networkError:\s*true/);
    // Belt-and-suspenders: ensure the catch return literally contains both.
    const catchBlock = source.slice(source.indexOf('} catch {'));
    expect(catchBlock).toMatch(/isInvitedPm:\s*false/);
    expect(catchBlock).toMatch(/networkError:\s*true/);
  });
});

describe('v1.4.8 — all three fetchWhoami call sites capture isInvitedPm', () => {
  const source = readFileSync(STEP15_PATH, 'utf8');

  it('every fetchWhoami call is followed by a shared.isInvitedPm assignment', () => {
    // There are exactly THREE fetchWhoami invocations in step-15.ts (full
    // device-code flow, runPollOnly, existing-credential-validated path).
    // Each must propagate isInvitedPm into shared — otherwise the invited
    // PM whose token came through the un-instrumented path sees the wrong
    // success message.
    const callMatches = source.match(/await fetchWhoami\(ctx\)/g) ?? [];
    expect(callMatches.length).toBe(3);

    const assignMatches = source.match(/shared\.isInvitedPm\s*=\s*whoami\.isInvitedPm/g) ?? [];
    expect(assignMatches.length).toBe(3);
  });
});

describe('v1.4.8 — StepContext.shared exposes isInvitedPm', () => {
  const source = readFileSync(TYPES_PATH, 'utf8');

  it('declares isInvitedPm?: boolean on shared', () => {
    expect(source).toMatch(/isInvitedPm\?:\s*boolean/);
  });
});

describe('v1.4.8 — step-13 forwards isInvitedPm into successBox', () => {
  const source = readFileSync(STEP13_PATH, 'utf8');

  it('passes shared.isInvitedPm (defaulting false) as the 4th successBox arg', () => {
    expect(source).toMatch(/successBox\([^)]*shared\.isInvitedPm\s*\?\?\s*false\s*\)/);
  });
});
