// .claude/sync-state.json — read/write the local sync ledger.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';

import { atomicWriteFile } from './atomic-write.js';
import { projectPaths } from './files.js';

export interface SyncStateFileEntry {
  localHash: string;
  cloudHash: string;
  lastSyncedAt: string;
}

export interface SyncStateArtifactEntry {
  hash: string;
  pushedAt: string;
}

export interface SyncStateContextEntry {
  hash: string;
  pushedAt: string;
}

export interface SyncState {
  files: Record<string, SyncStateFileEntry>;
  artifacts: Record<string, SyncStateArtifactEntry>;
  contextFiles: Record<string, SyncStateContextEntry>;
  lastSyncedAt: string | null;
  // EDD §5.3 — 24h npm-update timebox cache.
  lastNpmUpdateAt: string | null;
  // PR 4c additions per EDD §6.2 (init step ledger + counters).
  // initCompletedSteps[] is the resume marker (§6.2 step ledger). On re-run,
  // steps in the array are skipped; ledger only advances after a step's
  // post-step health check passes.
  initCompletedSteps: number[];
  // Auth-thrash circuit breaker (§6.2 step 9 + RT-3 + CTO-v1.3-B3).
  // Increments on signed-URL fetch 401, resets to 0 on every successful step 9.
  step9Auth401RetryCount: number;
  // Customer-id captured from install-ready response (step 4) — written into
  // sync-state so re-runs and support tooling can refer to a single
  // customer_id without re-querying.
  customerId: string | null;
  // Workspace scope (Solo vs Team) captured from install-ready response.
  workspaceScope: 'solo' | 'team' | null;
  // Customer slug — used to build marketplace name + paths everywhere.
  customerSlug: string | null;
  // Issue #34 — upgrade-nag plumbing.
  // `lastKnownLatestNpmVersion` is the last value `fetchLatestNpmVersion`
  // returned successfully. Cached here so the nag-decision path can compare
  // `__VERSION__` against it without re-hitting the registry on every sync
  // (the registry call itself is 24h-gated separately by `lastNpmUpdateAt`).
  // `lastUpgradePromptAt` debounces the stderr nag — without it, every silent
  // SessionStart sync that crosses the registry-refresh boundary would re-emit
  // the same upgrade line.
  lastKnownLatestNpmVersion: string | null;
  lastUpgradePromptAt: string | null;
  // Last-seen working `claude` CLI path (resolveClaudeBin persists it on a
  // successful spawn). Lets a plain-terminal context — where
  // $CLAUDE_CODE_EXECPATH is unset (e.g. the `plugin-install` remediation) —
  // still resolve the binary instead of falling through to PATH lookups that
  // fail on desktop-app installs.
  lastClaudeBinPath: string | null;
  // Plugin version (the `1.{unix-ms}.0` minted by regen) that Claude Code
  // currently has MATERIALIZED for this customer. Written by step-9 and
  // `plugin-refresh` to the version they ACTUALLY installed — which may be an
  // older last-known-good cache on a network/registration failure, never
  // blindly the latest available. `plugin-refresh` compares the latest
  // available version against this to decide whether a re-install is needed.
  // Null on installs that predate this field → treated as "refresh once".
  installedPluginVersion: string | null;
}

function freshEmptyState(): SyncState {
  return {
    files: {},
    artifacts: {},
    contextFiles: {},
    lastSyncedAt: null,
    lastNpmUpdateAt: null,
    initCompletedSteps: [],
    step9Auth401RetryCount: 0,
    customerId: null,
    workspaceScope: null,
    customerSlug: null,
    lastKnownLatestNpmVersion: null,
    lastUpgradePromptAt: null,
    lastClaudeBinPath: null,
    installedPluginVersion: null,
  };
}

export function readSyncState(rootDir: string): SyncState {
  const path = projectPaths(rootDir).syncStatePath;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SyncState>;
    return {
      ...freshEmptyState(),
      ...parsed,
      files: parsed.files ?? {},
      artifacts: parsed.artifacts ?? {},
      contextFiles: parsed.contextFiles ?? {},
      initCompletedSteps: parsed.initCompletedSteps ?? [],
      step9Auth401RetryCount: parsed.step9Auth401RetryCount ?? 0,
    };
  } catch {
    return freshEmptyState();
  }
}

// Append a step number to the ledger and persist. Atomic via writeSyncState
// (which uses fs.writeFileSync — adequate for this small JSON; a crash mid-
// write leaves the prior file intact since writeFileSync writes to the same
// inode atomically on POSIX for files <4KB). Idempotent: re-appending a step
// already in the ledger is a no-op.
export function markStepComplete(rootDir: string, state: SyncState, step: number): void {
  if (!state.initCompletedSteps.includes(step)) {
    state.initCompletedSteps.push(step);
    state.initCompletedSteps.sort((a, b) => a - b);
  }
  writeSyncState(rootDir, state);
}

// True if step N is already in the ledger (skip on re-run).
export function isStepComplete(state: SyncState, step: number): boolean {
  return state.initCompletedSteps.includes(step);
}

export function writeSyncState(rootDir: string, state: SyncState): void {
  const path = projectPaths(rootDir).syncStatePath;
  // RED-TEAM R2 P1-B: atomicWriteFile (temp + rename) replaces direct
  // writeFileSync. Without this, a disk-full event mid-write or a SIGKILL
  // truncates sync-state.json — readSyncState then swallows the parse error
  // and returns EMPTY_STATE, silently losing customerSlug/customerId/ledger.
  // Customer's next init starts from step 1 and may fail at "Missing customer
  // slug" if env var was only set in the original install command's process.
  // mkdirSync recursive is a no-op if the directory exists.
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFile(path, JSON.stringify(state, null, 2) + '\n');
}

// Lock tuning for sync-state writes — mirror marketplace-lock's proven values.
const SYNC_STATE_LOCK_STALE_MS = 30_000;
const SYNC_STATE_LOCK_RETRIES = 5;
const SYNC_STATE_LOCK_MIN_TIMEOUT_MS = 100;

/**
 * Read-modify-write sync-state.json under a file lock so concurrent writers
 * don't clobber each other. `writeSyncState` replaces the WHOLE file, so two
 * writers that each `read → mutate → write` can lose one another's keys: the
 * PostToolUse `artifact-sync` hook (records one context-file hash) and the Stop
 * `push` sweep (records many artifact/context hashes) fire close together, and
 * without serialization the later write would drop the earlier one's
 * freshly-recorded hash. The mutator runs against state read FRESH under the
 * lock, so it only ever adds to the latest on-disk state.
 *
 * Best-effort by contract: callers must never crash on lock contention. If the
 * lock can't be acquired we SKIP the write — we do NOT write unlocked, which
 * could clobber a concurrent locked writer. The common (uncontended) case
 * always serializes; on the rare miss the mutation is simply re-done next time.
 * `opts.retries` lets an important, low-frequency writer (e.g. plugin-refresh
 * recording installedPluginVersion) wait harder so it effectively never skips,
 * while hot-path hooks keep the default fast-skip.
 */
export async function updateSyncState(
  rootDir: string,
  mutate: (state: SyncState) => void,
  opts: { retries?: number } = {}
): Promise<void> {
  const path = projectPaths(rootDir).syncStatePath;
  mkdirSync(dirname(path), { recursive: true });
  // proper-lockfile requires the target to exist before lock(). A brand-new
  // workspace may not have written sync-state yet; materialize an empty one so
  // the very first concurrent writers still serialize.
  if (!existsSync(path)) {
    atomicWriteFile(path, JSON.stringify(freshEmptyState(), null, 2) + '\n');
  }

  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(path, {
      retries: {
        retries: opts.retries ?? SYNC_STATE_LOCK_RETRIES,
        minTimeout: SYNC_STATE_LOCK_MIN_TIMEOUT_MS,
      },
      stale: SYNC_STATE_LOCK_STALE_MS,
    });
  } catch {
    // Couldn't acquire the lock (contention or an unsupported FS). SKIP the
    // write rather than doing an UNLOCKED read-modify-write: an unlocked writer
    // could clobber a concurrent locked writer's keys (the very thing this
    // helper exists to prevent). These are best-effort hook writes — the
    // mutation is simply re-done on the next turn / SessionStart.
    return;
  }

  try {
    const state = readSyncState(rootDir);
    mutate(state);
    writeSyncState(rootDir, state);
  } finally {
    try {
      await release();
    } catch {
      // Lock auto-releases after the stale window; ignore release errors.
    }
  }
}
