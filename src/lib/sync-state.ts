// .claude/sync-state.json — read/write the local sync ledger.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
}

const EMPTY_STATE: SyncState = {
  files: {},
  artifacts: {},
  lastSyncedAt: null,
  lastNpmUpdateAt: null,
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
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export function writeSyncState(rootDir: string, state: SyncState): void {
  const path = projectPaths(rootDir).syncStatePath;
  // mkdirSync recursive is a no-op if the directory exists.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
}
