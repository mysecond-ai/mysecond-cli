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

export interface SyncState {
  files: Record<string, SyncStateFileEntry>;
  artifacts: Record<string, SyncStateArtifactEntry>;
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
}

const EMPTY_STATE: SyncState = {
  files: {},
  artifacts: {},
  lastSyncedAt: null,
  lastNpmUpdateAt: null,
  initCompletedSteps: [],
  step9Auth401RetryCount: 0,
  customerId: null,
  workspaceScope: null,
  customerSlug: null,
};

export function readSyncState(rootDir: string): SyncState {
  const path = projectPaths(rootDir).syncStatePath;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SyncState>;
    return {
      ...EMPTY_STATE,
      ...parsed,
      files: parsed.files ?? {},
      artifacts: parsed.artifacts ?? {},
      initCompletedSteps: parsed.initCompletedSteps ?? [],
      step9Auth401RetryCount: parsed.step9Auth401RetryCount ?? 0,
    };
  } catch {
    return { ...EMPTY_STATE };
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
