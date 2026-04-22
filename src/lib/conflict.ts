// Conflict resolution for context files — minimum safety net (Option 1 per
// Ron + CXO 2026-04-22 design call). When local and cloud both diverged since
// last sync: pick a side per ctx.strategy, write a timestamped backup of the
// loser, emit one notification line. Solo conflicts are 0-2x/month per
// customer; heavier UX (interactive prompt protocol, RECENT.md log surface,
// CLAUDE.md @import breadcrumb) deferred until customer feedback demands it.
//
// CAIO finding (PR 4b review): stderr from SessionStart hooks is silently
// dropped on exit 0. Conflict notifications must go to STDOUT in --silent mode
// so Claude sees them as session-start context and can mention them to the
// customer. TTY (terminal) keeps stderr where it's visible directly.

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

interface ChangeFlags {
  cloudChanged: boolean;
  localChanged: boolean;
  isFirstSeen: boolean;
}

function classifyConflict(input: SyncContextFileInput): ChangeFlags {
  const { file, localContent, syncState } = input;
  const lastSynced = syncState.files[file.file_path];

  if (localContent === null) {
    return { cloudChanged: true, localChanged: false, isFirstSeen: true };
  }
  if (!lastSynced) {
    // First sync after the file already existed locally. Treat byte-equal as
    // "in sync"; otherwise flag both sides as changed so it falls into the
    // conflict path. The asymmetric assignment (both true OR both false from
    // a single sameBytes check) is intentional — we have no baseline to
    // distinguish which side moved, so we treat any divergence as a conflict.
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

function recordSyncedFile(
  state: SyncState,
  filePath: string,
  localContent: string,
  cloudHash: string,
  nowIso: string
): void {
  state.files[filePath] = {
    localHash: sha256(localContent),
    cloudHash,
    lastSyncedAt: nowIso,
  };
}

function emitNotice(message: string, ctx: CommandContext): void {
  // CAIO: stdout in silent mode (SessionStart hook) so Claude reads it as
  // session-start context. Stderr in TTY mode where the customer sees it.
  const stream = ctx.silent ? process.stdout : process.stderr;
  stream.write(message + '\n');
}

export function resolveConflict(input: SyncContextFileInput): ConflictOutcome {
  const { file, localContent, syncState, ctx } = input;
  const { contextDir, conflictsDir } = projectPaths(ctx.rootDir);
  const nowIso = new Date().toISOString();

  if (localContent === null) {
    const ok = writeLocalFile(contextDir, file.file_path, file.content);
    if (!ok) return { kind: 'conflict-skipped' };
    recordSyncedFile(syncState, file.file_path, file.content, file.current_hash, nowIso);
    return { kind: 'created', writtenPath: file.file_path };
  }

  const { cloudChanged, localChanged, isFirstSeen } = classifyConflict(input);

  if (!cloudChanged && !localChanged) {
    if (!syncState.files[file.file_path]) {
      recordSyncedFile(syncState, file.file_path, localContent, file.current_hash, nowIso);
    }
    return { kind: 'unchanged' };
  }

  if (cloudChanged && !localChanged) {
    const ok = writeLocalFile(contextDir, file.file_path, file.content);
    if (!ok) return { kind: 'conflict-skipped' };
    recordSyncedFile(syncState, file.file_path, file.content, file.current_hash, nowIso);
    return { kind: 'updated-from-cloud', writtenPath: file.file_path };
  }

  if (localChanged && !cloudChanged) {
    recordSyncedFile(syncState, file.file_path, localContent, file.current_hash, nowIso);
    return { kind: 'kept-local' };
  }

  // Real conflict — both sides moved. Write backup, apply chosen side per
  // strategy, emit notification. Backup naming uses path-safe characters so
  // file_paths with slashes/dots produce a single readable filename.
  const safeName = file.file_path.replace(/[^A-Za-z0-9._-]+/g, '_');
  const stamp = nowIso.replace(/[:.]/g, '-');
  mkdirSync(conflictsDir, { recursive: true });

  // Edge case (CTO finding): in --silent mode, ctx.strategy defaults to
  // cloud-wins via buildContext, so this branch only fires when the customer
  // explicitly passed --strategy=prompt (unusual in a hook context). On a
  // brand-new install isFirstSeen is true for every file — a real conflict
  // there gets silently skipped rather than auto-resolved. Acceptable given
  // 0-2 conflicts/month, but documented so a future dev doesn't "fix" it.
  if (ctx.strategy === 'skip' || (ctx.strategy === 'prompt' && isFirstSeen && ctx.silent)) {
    const cloudBackup = join(conflictsDir, `${safeName}-cloud-${stamp}.md`);
    writeLocalFile(conflictsDir, `${safeName}-cloud-${stamp}.md`, file.content);
    emitNotice(
      `Conflict in context/${file.file_path} — skipped. Cloud version saved to ${cloudBackup}`,
      ctx
    );
    return { kind: 'conflict-skipped' };
  }

  if (ctx.strategy === 'local-wins') {
    const cloudBackup = join(conflictsDir, `${safeName}-cloud-${stamp}.md`);
    writeLocalFile(conflictsDir, `${safeName}-cloud-${stamp}.md`, file.content);
    recordSyncedFile(syncState, file.file_path, localContent, file.current_hash, nowIso);
    emitNotice(
      `Conflict in context/${file.file_path} — kept local. Cloud version saved to ${cloudBackup}`,
      ctx
    );
    return { kind: 'conflict-local-kept', backupPath: cloudBackup };
  }

  // Default + cloud-wins + non-interactive prompt fallback: take cloud, back
  // up local. Most customers hit this path.
  const localBackup = join(conflictsDir, `${safeName}-local-${stamp}.md`);
  writeLocalFile(conflictsDir, `${safeName}-local-${stamp}.md`, localContent);
  const ok = writeLocalFile(contextDir, file.file_path, file.content);
  if (!ok) return { kind: 'conflict-skipped' };
  recordSyncedFile(syncState, file.file_path, file.content, file.current_hash, nowIso);
  emitNotice(
    `Conflict in context/${file.file_path} — kept cloud version (your local edits saved to ${localBackup})`,
    ctx
  );
  return { kind: 'conflict-cloud-kept', writtenPath: file.file_path, backupPath: localBackup };
}
