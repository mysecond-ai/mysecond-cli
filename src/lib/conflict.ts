// Conflict resolution for context files — minimum safety net (Option 1).
//
// Per Ron + CXO call (PR 4b design session 2026-04-22): when both local and cloud
// versions of a context file have changed since last sync, take the cloud version
// and write a timestamped backup of the local version so the customer can recover
// it manually. Emit a single stderr line. No interactive prompt by default.
//
// Solo conflicts are rare (0-2x/month per customer). Heavier UX (interactive
// strategy flag, recent-conflicts log file, CLAUDE.md @import surface) deferred
// until Team tier or until customer feedback demands it.
//
// The --strategy flag (parsed in src/lib/context.ts) gives advanced users an
// override: prompt | cloud-wins | local-wins | skip. The default is set by
// buildContext() based on TTY detection.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { CommandContext } from './context.js';
import { projectPaths, sha256, writeLocalFile } from './files.js';
import type { ContextFile } from './payload.js';
import type { SyncState } from './sync-state.js';

export type ConflictOutcome =
  | { kind: 'unchanged' }
  | { kind: 'created'; writtenPath: string }
  | { kind: 'updated-from-cloud'; writtenPath: string }
  | { kind: 'kept-local' }
  | { kind: 'conflict-cloud-kept'; writtenPath: string; backupPath: string }
  | { kind: 'conflict-local-kept'; backupPath: string }
  | { kind: 'conflict-skipped' };

interface SyncContextFileInput {
  file: ContextFile;
  localContent: string | null;
  syncState: SyncState;
  ctx: CommandContext;
}

// Pure conflict classifier — no I/O. Decides the resolution path based on what
// changed since last sync. Caller does the actual writes.
export function classifyConflict(input: SyncContextFileInput): {
  cloudChanged: boolean;
  localChanged: boolean;
  isFirstSeen: boolean;
} {
  const { file, localContent, syncState } = input;
  const lastSynced = syncState.files[file.file_path];

  if (localContent === null) {
    return { cloudChanged: true, localChanged: false, isFirstSeen: true };
  }
  if (!lastSynced) {
    // First sync after the file already existed locally. Treat byte-equal as
    // "in sync"; otherwise the divergence is a conflict.
    const sameBytes = localContent === file.content;
    return { cloudChanged: !sameBytes, localChanged: !sameBytes, isFirstSeen: true };
  }

  const localHash = sha256(localContent);
  return {
    cloudChanged: file.current_hash !== lastSynced.cloudHash,
    localChanged: localHash !== lastSynced.localHash,
    isFirstSeen: false,
  };
}

// Resolve a conflict according to ctx.strategy. Writes any backup files needed
// and returns the outcome for the caller to summarize.
export function resolveConflict(input: SyncContextFileInput): ConflictOutcome {
  const { file, localContent, syncState, ctx } = input;
  const { contextDir, conflictsDir } = projectPaths(ctx.rootDir);
  const lastSynced = syncState.files[file.file_path];
  const nowIso = new Date().toISOString();

  // Branch 1: local doesn't exist — pure create from cloud.
  if (localContent === null) {
    const ok = writeLocalFile(contextDir, file.file_path, file.content);
    if (!ok) return { kind: 'conflict-skipped' };
    syncState.files[file.file_path] = {
      localHash: sha256(file.content),
      cloudHash: file.current_hash,
      lastSyncedAt: nowIso,
    };
    return { kind: 'created', writtenPath: file.file_path };
  }

  const { cloudChanged, localChanged, isFirstSeen } = classifyConflict(input);

  // Branch 2: nothing diverged — record current hashes and move on.
  if (!cloudChanged && !localChanged) {
    if (!lastSynced) {
      syncState.files[file.file_path] = {
        localHash: sha256(localContent),
        cloudHash: file.current_hash,
        lastSyncedAt: nowIso,
      };
    }
    return { kind: 'unchanged' };
  }

  // Branch 3: only cloud changed — pull cloud over local.
  if (cloudChanged && !localChanged) {
    const ok = writeLocalFile(contextDir, file.file_path, file.content);
    if (!ok) return { kind: 'conflict-skipped' };
    syncState.files[file.file_path] = {
      localHash: sha256(file.content),
      cloudHash: file.current_hash,
      lastSyncedAt: nowIso,
    };
    return { kind: 'updated-from-cloud', writtenPath: file.file_path };
  }

  // Branch 4: only local changed — keep local; record so future syncs see this
  // as the new baseline. Cloud version remains stale on the server (legacy
  // architecture: context files don't push up via this path).
  if (localChanged && !cloudChanged) {
    syncState.files[file.file_path] = {
      localHash: sha256(localContent),
      cloudHash: file.current_hash,
      lastSyncedAt: nowIso,
    };
    return { kind: 'kept-local' };
  }

  // Branch 5: both changed (or first-seen with divergent bytes) — real conflict.
  // Apply the strategy. For Option 1 minimum safety net, "cloud-wins" is the
  // default for non-TTY surfaces; backups always written either way.
  const safeName = file.file_path.replace(/[^A-Za-z0-9._-]+/g, '_');
  const stamp = nowIso.replace(/[:.]/g, '-');
  mkdirSync(conflictsDir, { recursive: true });

  if (ctx.strategy === 'skip' || (ctx.strategy === 'prompt' && isFirstSeen && ctx.silent)) {
    // Skip resolution but still record the cloud version so the customer can
    // diff manually if they care.
    const cloudBackup = join(conflictsDir, `${safeName}-cloud-${stamp}.md`);
    writeLocalFile(conflictsDir, `${safeName}-cloud-${stamp}.md`, file.content);
    process.stderr.write(
      `Conflict in context/${file.file_path} — skipped. Cloud version saved to ${cloudBackup}\n`
    );
    return { kind: 'conflict-skipped' };
  }

  if (ctx.strategy === 'local-wins') {
    const cloudBackup = join(conflictsDir, `${safeName}-cloud-${stamp}.md`);
    writeLocalFile(conflictsDir, `${safeName}-cloud-${stamp}.md`, file.content);
    syncState.files[file.file_path] = {
      localHash: sha256(localContent),
      cloudHash: file.current_hash,
      lastSyncedAt: nowIso,
    };
    process.stderr.write(
      `Conflict in context/${file.file_path} — kept local. Cloud version saved to ${cloudBackup}\n`
    );
    return { kind: 'conflict-local-kept', backupPath: cloudBackup };
  }

  // Default + cloud-wins + non-interactive prompt fallback: take cloud, back up
  // local. This is the Option 1 minimum safety net path most customers hit.
  const localBackup = join(conflictsDir, `${safeName}-local-${stamp}.md`);
  writeLocalFile(conflictsDir, `${safeName}-local-${stamp}.md`, localContent);
  const ok = writeLocalFile(contextDir, file.file_path, file.content);
  if (!ok) return { kind: 'conflict-skipped' };
  syncState.files[file.file_path] = {
    localHash: sha256(file.content),
    cloudHash: file.current_hash,
    lastSyncedAt: nowIso,
  };
  process.stderr.write(
    `Conflict in context/${file.file_path} — kept cloud version (your local edits saved to ${localBackup})\n`
  );
  return { kind: 'conflict-cloud-kept', writtenPath: file.file_path, backupPath: localBackup };
}
