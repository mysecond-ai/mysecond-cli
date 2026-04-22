// `mysecond sync` — pull context/skills/agents/workflows from mysecond.ai,
// push local artifacts back up. Ported from legacy sync-context.js per EDD §5.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { cliSync, artifactsSync, confirmFirstSetup } from '../lib/api.js';
import type { CommandContext } from '../lib/context.js';
import { resolveConflict, type ConflictOutcome } from '../lib/conflict.js';
import { MysecondError } from '../lib/errors.js';
import {
  projectPaths,
  readLocalFile,
  shortHash,
  writeLocalFile,
  deleteLocalFile,
} from '../lib/files.js';
import { markNpmUpdated, shouldRunNpmUpdate } from '../lib/npm.js';
import {
  ARTIFACT_DIRS,
  type ArtifactPayload,
  type CompanionFile,
  type ContextFile,
} from '../lib/payload.js';
import { readSyncState, writeSyncState, type SyncState } from '../lib/sync-state.js';

const TEAM_OVERRIDE_START = '<!-- TEAM_OVERRIDE:START -->';
const TEAM_OVERRIDE_END = '<!-- TEAM_OVERRIDE:END -->';

interface SyncSummary {
  created: number;
  updatedFromCloud: number;
  keptLocal: number;
  conflictsCloudKept: number;
  conflictsLocalKept: number;
  conflictsSkipped: number;
  unchanged: number;
  deleted: number;
  skillsUpdated: number;
  agentsUpdated: number;
  workflowsUpdated: number;
  artifactsPushed: number;
  claudeMdUpdated: boolean;
  npmUpdateRan: boolean;
}

function emptySummary(): SyncSummary {
  return {
    created: 0,
    updatedFromCloud: 0,
    keptLocal: 0,
    conflictsCloudKept: 0,
    conflictsLocalKept: 0,
    conflictsSkipped: 0,
    unchanged: 0,
    deleted: 0,
    skillsUpdated: 0,
    agentsUpdated: 0,
    workflowsUpdated: 0,
    artifactsPushed: 0,
    claudeMdUpdated: false,
    npmUpdateRan: false,
  };
}

function tally(summary: SyncSummary, outcome: ConflictOutcome): void {
  switch (outcome.kind) {
    case 'created':
      summary.created++;
      break;
    case 'updated-from-cloud':
      summary.updatedFromCloud++;
      break;
    case 'kept-local':
      summary.keptLocal++;
      break;
    case 'conflict-cloud-kept':
      summary.conflictsCloudKept++;
      break;
    case 'conflict-local-kept':
      summary.conflictsLocalKept++;
      break;
    case 'conflict-skipped':
      summary.conflictsSkipped++;
      break;
    case 'unchanged':
      summary.unchanged++;
      break;
  }
}

function syncCompanionFile(baseDir: string, file: CompanionFile): boolean {
  const local = readLocalFile(baseDir, file.file_path);
  if (local === file.content) return false;
  return writeLocalFile(baseDir, file.file_path, file.content);
}

function mergeClaudeMdOverride(claudeMdPath: string, override: string): void {
  let base = '';
  if (existsSync(claudeMdPath)) {
    base = readFileSync(claudeMdPath, 'utf8');
  }

  const startIdx = base.indexOf(TEAM_OVERRIDE_START);
  const endIdx = base.indexOf(TEAM_OVERRIDE_END);
  const block = `${TEAM_OVERRIDE_START}\n${override}\n${TEAM_OVERRIDE_END}`;

  let next: string;
  if (startIdx !== -1 && endIdx !== -1) {
    next = base.slice(0, startIdx) + block + base.slice(endIdx + TEAM_OVERRIDE_END.length);
  } else {
    let separator = '';
    if (base.length > 0) {
      separator = base.endsWith('\n') ? '\n' : '\n\n';
    }
    next = `${base}${separator}${block}\n`;
  }

  writeFileSync(claudeMdPath, next);
}

function scanArtifacts(rootDir: string): ArtifactPayload[] {
  const found: ArtifactPayload[] = [];
  for (const entry of ARTIFACT_DIRS) {
    const dir = join(rootDir, entry.relativeDir);
    if (!existsSync(dir)) continue;
    walkArtifactDir(rootDir, dir, entry.type, found);
  }
  return found;
}

function walkArtifactDir(
  rootDir: string,
  currentDir: string,
  artifactType: ArtifactPayload['artifact_type'],
  results: ArtifactPayload[]
): void {
  const entries = readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      walkArtifactDir(rootDir, fullPath, artifactType, results);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

    const content = readFileSync(fullPath, 'utf8');
    const relativePath = relative(rootDir, fullPath);
    // Parent dir naming convention: YYYY-MM-DD-HHMM-<pm-name>
    const parentDir = currentDir.split('/').pop() ?? '';
    const pmNameMatch = parentDir.match(/^\d{4}-\d{2}-\d{2}-\d{4}-(.+)$/);
    const pmName = pmNameMatch && pmNameMatch[1] !== undefined ? pmNameMatch[1] : null;
    const skillSlug = entry.name
      .replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, '')
      .replace(/\.md$/, '');
    results.push({
      file_path: relativePath,
      content,
      current_hash: shortHash(content),
      artifact_type: artifactType,
      pm_name: pmName,
      skill_slug: skillSlug.length > 0 ? skillSlug : null,
      produced_at: new Date().toISOString(),
    });
  }
}

async function upSyncArtifacts(
  ctx: CommandContext,
  state: SyncState
): Promise<number> {
  const artifacts = scanArtifacts(ctx.rootDir);
  const toSync = artifacts.filter((a) => {
    const last = state.artifacts[a.file_path];
    return !last || last.hash !== a.current_hash;
  });
  if (toSync.length === 0) return 0;

  const result = await artifactsSync(ctx, toSync);
  if (result.synced > 0) {
    const now = new Date().toISOString();
    for (const a of toSync) {
      state.artifacts[a.file_path] = { hash: a.current_hash, pushedAt: now };
    }
  }
  return result.synced;
}

function printSummary(summary: SyncSummary, ctx: CommandContext): void {
  if (ctx.silent) {
    const parts: string[] = [];
    const contextChanges =
      summary.created + summary.updatedFromCloud + summary.conflictsCloudKept;
    if (contextChanges > 0) parts.push(`${contextChanges} context updates`);
    if (summary.skillsUpdated > 0) parts.push(`${summary.skillsUpdated} skills`);
    if (summary.agentsUpdated > 0) parts.push(`${summary.agentsUpdated} agents`);
    if (summary.workflowsUpdated > 0) parts.push(`${summary.workflowsUpdated} workflows`);
    if (summary.artifactsPushed > 0) parts.push(`${summary.artifactsPushed} artifacts pushed`);
    const conflicts =
      summary.conflictsCloudKept + summary.conflictsLocalKept + summary.conflictsSkipped;
    if (conflicts > 0) parts.push(`${conflicts} conflicts`);
    if (parts.length > 0) {
      process.stdout.write(`mysecond: ${parts.join(', ')}\n`);
    }
    return;
  }

  const parts: string[] = [];
  if (summary.created) parts.push(`${summary.created} new`);
  if (summary.updatedFromCloud) parts.push(`${summary.updatedFromCloud} updated`);
  const conflicts =
    summary.conflictsCloudKept + summary.conflictsLocalKept + summary.conflictsSkipped;
  if (conflicts) parts.push(`${conflicts} conflicts handled`);
  if (summary.deleted) parts.push(`${summary.deleted} removed`);
  if (summary.unchanged) parts.push(`${summary.unchanged} unchanged`);
  if (summary.skillsUpdated) parts.push(`${summary.skillsUpdated} skills`);
  if (summary.agentsUpdated) parts.push(`${summary.agentsUpdated} agents`);
  if (summary.workflowsUpdated) parts.push(`${summary.workflowsUpdated} workflows`);
  if (summary.artifactsPushed) parts.push(`${summary.artifactsPushed} artifacts pushed`);
  if (summary.claudeMdUpdated) parts.push('CLAUDE.md updated');
  if (parts.length === 0) parts.push('nothing changed');

  process.stdout.write(`✓ Sync complete: ${parts.join(', ')}.\n`);
  if (summary.conflictsCloudKept > 0 || summary.conflictsLocalKept > 0) {
    process.stdout.write(
      `  Recover backed-up versions from .claude/sync-conflicts/ if needed.\n`
    );
  }
}

export async function runSync(
  _args: readonly string[],
  ctx: CommandContext
): Promise<number> {
  if (ctx.apiKey.length === 0) {
    throw MysecondError.invalidApiKey('COMPANION_API_KEY not set');
  }

  const summary = emptySummary();
  const state = readSyncState(ctx.rootDir);
  const previousPaths = Object.keys(state.files);

  const response = await cliSync(ctx, previousPaths);
  const contextFiles: ContextFile[] = response.context_files ?? response.files ?? [];
  const customSkills = response.custom_skills ?? [];
  const customAgents = response.custom_agents ?? [];
  const customWorkflows = response.custom_workflows ?? [];
  const claudeMdOverride = response.claude_md_override ?? null;
  const deletedPaths = response.deleted_paths ?? [];

  const paths = projectPaths(ctx.rootDir);

  // Down-sync context files — conflict detection per src/lib/conflict.ts.
  for (const file of contextFiles) {
    const localContent = readLocalFile(paths.contextDir, file.file_path);
    const outcome = resolveConflict({ file, localContent, syncState: state, ctx });
    tally(summary, outcome);
  }

  // Deletions — cloud says these no longer apply; remove locally if present.
  for (const filePath of deletedPaths) {
    if (deleteLocalFile(paths.contextDir, filePath)) {
      delete state.files[filePath];
      summary.deleted++;
    }
  }

  // Companion-wins for skills / agents / workflows. No conflict detection — these
  // are owned by the server and customers should never edit the bundled files.
  for (const file of customSkills) {
    if (syncCompanionFile(paths.skillsDir, file)) summary.skillsUpdated++;
  }
  for (const file of customAgents) {
    if (syncCompanionFile(paths.agentsDir, file)) summary.agentsUpdated++;
  }
  for (const file of customWorkflows) {
    if (syncCompanionFile(paths.workflowsDir, file)) summary.workflowsUpdated++;
  }

  if (claudeMdOverride) {
    mergeClaudeMdOverride(paths.claudeMdPath, claudeMdOverride);
    summary.claudeMdUpdated = true;
  }

  // Up-sync artifacts (best-effort — failure is non-fatal so the down-sync still
  // succeeds for the customer).
  try {
    summary.artifactsPushed = await upSyncArtifacts(ctx, state);
  } catch (err) {
    if (!ctx.silent) {
      process.stderr.write(
        `mysecond: artifact up-sync failed (${err instanceof Error ? err.message : String(err)}). Down-sync OK.\n`
      );
    }
  }

  // 24h npm-update timebox — gate is honored, actual `npm update` lands in a
  // future PR once the customer plugin slug is provisioned by `mysecond init`.
  if (shouldRunNpmUpdate(state, ctx)) {
    markNpmUpdated(state);
    summary.npmUpdateRan = true;
  }

  // Persist updated state. lastSyncedAt comes from the server response so the
  // CLI's clock skew can't drift the ledger.
  state.lastSyncedAt = response.syncedAt;
  writeSyncState(ctx.rootDir, state);

  // First-sync confirmation — fire-and-forget; failure doesn't impact the user.
  const wasFirstSync =
    state.lastSyncedAt !== null && Object.keys(state.files).length > 0 && previousPaths.length === 0;
  if (wasFirstSync) {
    await confirmFirstSetup(ctx);
  }

  printSummary(summary, ctx);
  return 0;
}
