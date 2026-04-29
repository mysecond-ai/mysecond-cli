// `proper-lockfile` wrapper for `~/.mysecond/marketplaces/` serialization.
// Spec §6.2 + §12.1 (v1.5 successor to v1.4's `~/.npmrc` lock).
//
// Same `proper-lockfile` semantics as the v1.4 `npmrc-lock.ts` (Team-sync still
// uses that path). Different anchor: parent dir `~/.mysecond/marketplaces/`
// covers concurrent inits across customers AND concurrent sub-step writes
// within a single init. {stale: 30000} auto-releases locks held by dead
// processes after 30s (CTO-3 carry).

import { mkdirSync } from 'node:fs';
import lockfile from 'proper-lockfile';

import { MysecondError } from './errors.js';
import { marketplacesRoot } from './mysecond-paths.js';

const STALE_MS = 30_000;
const RETRIES = 5;
const MIN_TIMEOUT_MS = 100;

export interface LockHandle {
  release: () => Promise<void>;
}

// Acquire the marketplaces parent-dir lock. Caller MUST `await release()` in a
// `finally` block. Throws MysecondError on lock-timeout (5×100ms + stale auto-
// release window exhausted).
export async function acquireMarketplaceLock(): Promise<LockHandle> {
  // proper-lockfile requires the target path to exist before lock(). The lock
  // itself is created at `<path>.lock`. We lock the parent dir, not any single
  // marketplace, so concurrent inits across customers also serialize.
  mkdirSync(marketplacesRoot(), { recursive: true });

  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(marketplacesRoot(), {
      retries: { retries: RETRIES, minTimeout: MIN_TIMEOUT_MS },
      stale: STALE_MS,
    });
  } catch (err) {
    throw new MysecondError(
      1,
      `Couldn't acquire a lock on ~/.mysecond/marketplaces/ (${RETRIES} retries over ${RETRIES * MIN_TIMEOUT_MS}ms). Another mysecond process may be running, or the lock file is corrupted. Try: rm -rf ~/.mysecond/marketplaces.lock && mysecond init.`,
      { cause: err }
    );
  }
  return { release };
}

// Test helper — exposed for vitest fixtures.
export const __testing = { STALE_MS, RETRIES, MIN_TIMEOUT_MS };
