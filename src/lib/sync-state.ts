// .claude/sync-state.json — read/write the local sync ledger.

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
