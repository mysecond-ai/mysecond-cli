// `mysecond sync` — pull context/skills/agents/workflows from mysecond.ai,
// push local artifacts back up. EDD §5.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { cliSync, artifactsSync, confirmFirstSetup } from '../lib/api.js';
import type { CommandContext } from '../lib/context.js';
import { resolveConflict, type ConflictOutcome } from '../lib/conflict.js';
import { MysecondError } from '../lib/errors.js';
import {
  projectPaths,
  readLocalFile,
  writeLocalFile,
  deleteLocalFile,
} from '../lib/files.js';
import { markNpmUpdated, shouldRunNpmUpdate } from '../lib/npm.js';
import {
  scanArtifacts,
  type CompanionFile,
  type ContextFile,
} from '../lib/payload.js';
import { readSyncState, writeSyncState, type SyncState } from '../lib/sync-state.js';

const TEAM_OVERRIDE_START = '<!-- TEAM_OVERRIDE:START -->';
const TEAM_OVERRIDE_END = '<!-- TEAM_OVERRIDE:END -->';

// CAIO finding: SessionStart hooks shouldn't block session start visibly. Tighten
// the cliSync timeout when running silently (hook path); keep the longer default
// for manual sync runs where the customer expects a live operation.
const SILENT_SYNC_TIMEOUT_MS = 8_000;

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
  // CAIO finding: stderr from SessionStart hooks is silently dropped on exit 0.
  // Customer-relevant messages MUST go to stdout when ctx.silent so Claude sees
  // them as session-start context and can mention them to the customer.
  const out = ctx.silent ? process.stdout : process.stdout;

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
    if (conflicts > 0) parts.push(`${conflicts} conflicts (see .claude/sync-conflicts/)`);
    if (parts.length > 0) {
      out.write(`mysecond: ${parts.join(', ')}\n`);
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

  out.write(`✓ Sync complete: ${parts.join(', ')}.\n`);
  if (summary.conflictsCloudKept > 0 || summary.conflictsLocalKept > 0) {
    out.write(`  Recover backed-up versions from .claude/sync-conflicts/ if needed.\n`);
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

  // Quality bug-catch: capture lastSyncedAt BEFORE the response overwrites it
  // on line ~225. Without this snapshot, the wasFirstSync check below would
  // always be true and confirmFirstSetup() would fire on every sync.
  const priorLastSyncedAt = state.lastSyncedAt;

  const cliSyncOpts: { timeoutMs?: number } = ctx.silent
    ? { timeoutMs: SILENT_SYNC_TIMEOUT_MS }
    : {};
  const response = await cliSync(ctx, previousPaths, cliSyncOpts);
  const contextFiles: ContextFile[] = response.context_files ?? response.files ?? [];
  const customSkills = response.custom_skills ?? [];
  const customAgents = response.custom_agents ?? [];
  const customWorkflows = response.custom_workflows ?? [];
  const claudeMdOverride = response.claude_md_override ?? null;
  const deletedPaths = response.deleted_paths ?? [];

  const paths = projectPaths(ctx.rootDir);

  for (const file of contextFiles) {
    const localContent = readLocalFile(paths.contextDir, file.file_path);
    const outcome = resolveConflict({ file, localContent, syncState: state, ctx });
    tally(summary, outcome);
  }

  for (const filePath of deletedPaths) {
    if (deleteLocalFile(paths.contextDir, filePath)) {
      delete state.files[filePath];
      summary.deleted++;
    }
  }

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

  // Up-sync is best-effort: failure here doesn't fail the sync command. In
  // silent mode we swallow the failure entirely (transient hook noise isn't
  // worth surfacing on session start); in interactive mode we report it.
  try {
    summary.artifactsPushed = await upSyncArtifacts(ctx, state);
  } catch (err) {
    if (!ctx.silent) {
      process.stderr.write(
        `mysecond: artifact up-sync failed (${err instanceof Error ? err.message : String(err)}). Down-sync OK.\n`
      );
    }
  }

  // The 24h gate is honored; actual `npm update -g @mysecond/customer-{slug}`
  // invocation lands when PR 4c provisions the customer plugin slug to local
  // state. Until then the gate just stamps the timestamp so the cadence starts
  // from install day.
  if (shouldRunNpmUpdate(state, ctx)) {
    markNpmUpdated(state);
    summary.npmUpdateRan = true;
  }

  state.lastSyncedAt = response.syncedAt;
  writeSyncState(ctx.rootDir, state);

  // First-sync = no prior server timestamp AND no prior tracked paths. Both
  // checks must use the snapshots captured before any state mutations above.
  const wasFirstSync = priorLastSyncedAt === null && previousPaths.length === 0;
  if (wasFirstSync) {
    await confirmFirstSetup(ctx);
  }

  printSummary(summary, ctx);
  return 0;
}
