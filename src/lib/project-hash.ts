// Project hash — single source of truth for `~/.mysecond/projects/<hash>/`
// path computation. MUST match the hook's inline computation in
// `mysecond-ai/product-manager-os` companion-sync hooks, which apply
// `os.path.realpath(PROJECT_DIR)` BEFORE hashing:
//   ABS_PROJ=$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$PROJECT_DIR")
//   sha256(ABS_PROJ).hex[:8]
// (See `mysecond-ai/product-manager-os/hooks/pre-tool-use-context-guard.sh`
// and `pre-tool-use-bash-guard.sh`. The hook's bash falls back to the
// literal `PROJECT_DIR` if realpath fails — same fallback below.)
//
// Cross-repo invariant: if the algorithm drifts here, every customer falls
// back to global ~/.mysecond/credentials silently — exactly the failure mode
// that caused the Apr 28 → May 1 silent-401 outage. The companion test
// `project-hash.test.ts` hardcodes an expected hash for a known input so
// drift screams.
//
// Track T3 (Closure D2) symlink fix: prior versions hashed the raw
// path. On macOS, `mktemp` (and any tmp-dir creation) returns paths
// under `/var/folders/...` which is a SYMLINK to `/private/var/folders/...`.
// The CLI receives the unresolved path via `--project-dir` / cwd, while
// the hook (Python) calls `os.path.realpath` and gets the resolved path.
// Resulting hashes differ → CLI writes creds at one hash, hook reads at
// another → MYSECOND_TEAM_ID never reaches the hook → team-mode silently OFF.
// Fix: apply `realpathSync.native` HERE so both sides hash the same input.
// Falls back to the input verbatim when realpath fails (path doesn't
// exist, permission denied) — matches the hook's `|| echo "$PROJECT_DIR"`
// fallback and keeps the cross-repo invariant tests' fixed-string vectors
// passing (they use synthetic non-existent paths).

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';

function tryRealpath(path: string): string {
  // Empty string is a known fixture in the cross-repo invariant tests; skip
  // the syscall so we hash exactly what the test feeds in.
  if (path.length === 0) return path;
  try {
    // `.native` calls into the OS realpath(3) directly. Slightly faster than
    // the JS implementation and — more importantly — produces identical
    // output to Python's `os.path.realpath` (which the hook uses), which
    // also calls the libc helper. Without `.native`, edge cases on
    // case-insensitive filesystems can diverge.
    return realpathSync.native(path);
  } catch {
    // Path doesn't exist (test fixtures, dry-run scenarios, --project-dir
    // pointed at a not-yet-created tree) or permission denied. Mirror the
    // hook's fallback and hash the input verbatim. Risk surface: if the
    // hook DOES successfully realpath where the CLI couldn't, the hashes
    // would still drift — but every realistic install scenario has the
    // CLI running with full read access to its own --project-dir, so the
    // asymmetric-access case is extremely narrow.
    return path;
  }
}

/**
 * Compute the 8-hex-char SHA-256 slice used in the project-scoped credential
 * path: `~/.mysecond/projects/<projectHash(absDir)>/credentials`.
 *
 * The customer plugin hooks compute the same value inline (after realpath).
 * Keep this function and the hook implementation in lockstep — see
 * `project-hash.test.ts` for the cross-repo invariant assertion.
 */
export function projectHash(absoluteProjectDir: string): string {
  const resolved = tryRealpath(absoluteProjectDir);
  return createHash('sha256').update(resolved).digest('hex').slice(0, 8);
}
