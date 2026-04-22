// .claude/sync-state.json — read/write the local sync ledger.
//
// Schema preserved from legacy sync-context.js. Adds last_npm_update_at for
// the 24-hour npm-update timebox per EDD §5.3.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
}
