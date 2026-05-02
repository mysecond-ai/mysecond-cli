// Project hash — single source of truth for `~/.mysecond/projects/<hash>/`
// path computation. MUST match the hook's inline computation in
// `mysecond-ai/product-manager-os` companion-sync hooks (which use
// `crypto.createHash('sha256').update(project_dir).digest('hex').slice(0, 8)`).
//
// Cross-repo invariant: if the algorithm drifts here, every customer falls
// back to global ~/.mysecond/credentials silently — exactly the failure mode
// that caused the Apr 28 → May 1 silent-401 outage. The companion test
// `project-hash.test.ts` hardcodes an expected hash for a known input so
// drift screams.

import { createHash } from 'node:crypto';

/**
 * Compute the 8-hex-char SHA-256 slice used in the project-scoped credential
 * path: `~/.mysecond/projects/<projectHash(absDir)>/credentials`.
 *
 * The customer plugin hooks compute the same value inline. Keep this function
 * and the hook implementation in lockstep — see `project-hash.test.ts` for the
 * cross-repo invariant assertion.
 */
export function projectHash(absoluteProjectDir: string): string {
  return createHash('sha256').update(absoluteProjectDir).digest('hex').slice(0, 8);
}
