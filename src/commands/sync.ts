// `mysecond sync` — pull context/skills/agents/workflows from mysecond.ai,
// push local artifacts back up. EDD §5.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  cliSync,
  artifactsSync,
  contextFilesPush,
  confirmFirstSetup,
  emitTelemetry,
} from '../lib/api.js';
import type { CommandContext } from '../lib/context.js';
import { resolveConflict, type ConflictOutcome } from '../lib/conflict.js';
import { getProjectScopedCredsPath } from '../lib/creds-path.js';
import { MysecondError } from '../lib/errors.js';
import {
  projectPaths,
  readLocalFile,
  shortHash,
  writeLocalFile,
  deleteLocalFile,
} from '../lib/files.js';
import {
  readInstallState,
  writeInstallState,
  type InstallState,
} from '../lib/install-state.js';
import {
  fetchLatestNpmVersion,
  markNpmUpdated,
  maybePrintUpgradeNag,
  shouldRunNpmUpdate,
} from '../lib/npm.js';
import { resolvePluginRefreshNudge } from '../lib/plugin-refresh-nag.js';
import {
  scanArtifacts,
  scanContextFiles,
  type BasePluginFile,
  type CompanionFile,
  type ContextFile,
} from '../lib/payload.js';
import {
  CLAUDE_MD_MARKER_END,
  CLAUDE_MD_MARKER_START,
  claudeMdBlock,
  isValidImportPath,
  spliceBetweenMarkers,
} from '../lib/copy.js';
import { pruneStalePlugins } from '../lib/prune-stale-plugins.js';
import {
  readSyncState,
  updateSyncState,
  writeSyncState,
  type SyncState,
  type SyncStateArtifactEntry,
  type SyncStateContextEntry,
} from '../lib/sync-state.js';

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
  contextFilesPushed: number;
  claudeMdUpdated: boolean;
  npmUpdateRan: boolean;
  // Workstream H — base plugin update counters. baseSkippedDueToCustomization
  // is telemetry-only; never surfaced to the customer per locked product
  // decision (customizations are invisible to mySecond).
  baseSkillsUpdated: number;
  baseAgentsUpdated: number;
  baseWorkflowsUpdated: number;
  baseSkippedDueToCustomization: number;
  // The product-manager-os base SHA this project is now synced to. Surfaced
  // so a customer/support can see which base a session is running — a cheap
  // substitute for version pinning, and the signal for spotting a base-SHA
  // shift mid-workflow. Null when the server didn't return one this round.
  basePluginVersion: string | null;
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
    contextFilesPushed: 0,
    claudeMdUpdated: false,
    npmUpdateRan: false,
    baseSkillsUpdated: 0,
    baseAgentsUpdated: 0,
    baseWorkflowsUpdated: 0,
    baseSkippedDueToCustomization: 0,
    basePluginVersion: null,
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

// Workstream H: write a single base plugin file (skill/agent/workflow) into
// the project, but ONLY if the customer hasn't customized it. Customization
// detection: compare the local SHA to the SHA we recorded in install-state
// the last time WE wrote the file. If they match → safe overwrite. If they
// differ → SILENTLY skip per locked product decision; bump telemetry counter
// for ops visibility.
//
// Returns 'updated' if we wrote, 'skipped-customized' if the local file
// diverged from our last write, or 'unchanged' if local already matches the
// new content.
function syncBasePluginFile(
  ctx: CommandContext,
  file: BasePluginFile,
  installState: InstallState
): 'updated' | 'skipped-customized' | 'unchanged' {
  const local = readLocalFile(ctx.rootDir, file.file_path);
  const installTimeHash = installState.files[file.file_path];

  // Fresh install OR file we've never seen — always write. The first time we
  // touch a file, install-time hash IS the cloud hash (no customization
  // possible yet). Same path serves the new-customer "no install-state.json
  // yet" graceful initialization.
  if (local === null || installTimeHash === undefined) {
    if (local === file.content) {
      installState.files[file.file_path] = file.current_hash;
      return 'unchanged';
    }
    if (writeLocalFile(ctx.rootDir, file.file_path, file.content)) {
      installState.files[file.file_path] = file.current_hash;
      return 'updated';
    }
    return 'unchanged';
  }

  // Customization detection: did the customer edit our last-written copy?
  const localHash = shortHash(local);
  if (localHash !== installTimeHash) {
    // Customer forked this skill — leave their edits alone. No notification,
    // no log surfaced, no mention in printSummary. Bump the telemetry-only
    // counter so we can see drift in aggregate without exposing it to
    // individual customers.
    return 'skipped-customized';
  }

  // Customer hasn't touched it. Safe to overwrite.
  if (local === file.content) return 'unchanged';
  if (writeLocalFile(ctx.rootDir, file.file_path, file.content)) {
    installState.files[file.file_path] = file.current_hash;
    return 'updated';
  }
  return 'unchanged';
}

function syncBaseTree(
  ctx: CommandContext,
  files: readonly BasePluginFile[] | undefined,
  installState: InstallState
): { updated: number; skipped: number } {
  if (!files || files.length === 0) return { updated: 0, skipped: 0 };
  let updated = 0;
  let skipped = 0;
  for (const f of files) {
    const outcome = syncBasePluginFile(ctx, f, installState);
    if (outcome === 'updated') updated++;
    else if (outcome === 'skipped-customized') skipped++;
  }
  return { updated, skipped };
}

// Extract companyName from the first line of the existing mySecond block.
// Format: "# mySecond PM OS — <companyName>"
// CRLF-tolerant: trailing \r / whitespace is trimmed before matching.
// Returns null if the line is absent or doesn't match the expected pattern.
function extractCompanyName(blockContent: string): string | null {
  const firstLine = (blockContent.split('\n')[0] ?? '').replace(/\r$/, '');
  const match = firstLine.match(/^# mySecond PM OS — (.+)$/);
  return match?.[1]?.trim() ?? null;
}

// Extract pmName from the second non-empty paragraph of the existing mySecond block.
// Format: "This workspace has a mySecond PM OS installed for <pmName> at <companyName>."
// CRLF-tolerant: trailing \r is trimmed before matching.
// Returns null if the line is absent or doesn't match.
function extractPmName(blockContent: string): string | null {
  for (const rawLine of blockContent.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const match = line.match(/^This workspace has a mySecond PM OS installed for (.+?) at .+\.$/);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

// Workstream B Phase 2, Track C: re-splice the mysecond block in CLAUDE.md
// from `resolvedImports` whenever the server returns them.
//
// Fail-closed contract (delegates to spliceBetweenMarkers):
//   - If the CLAUDE.md file is missing, no-op + warn (sync never creates on
//     sync — only init writes it the first time).
//   - If markers are absent, duplicated, nested, or reversed, leave the file
//     untouched and warn. Never append on sync.
//   - Codex P1: every import path is validated; hostile/malformed entries are
//     dropped (with a warning) before rendering and before any disk check.
//   - If we cannot read the existing company/PM names from the block, fall
//     back to "your company"/"you" rather than failing.
//
// Returns `true` only when the file was actually rewritten; `false` on any
// fail-closed path (missing file, corrupt markers). Codex P5 — the caller
// uses this to set the "CLAUDE.md updated" summary flag accurately.
export function regenerateMysecondBlock(
  claudeMdPath: string,
  rootDir: string,
  resolvedImports: readonly string[]
): boolean {
  if (!existsSync(claudeMdPath)) {
    process.stderr.write(
      '[mysecond] CLAUDE.md not found — skipping mysecond-block regeneration. Re-run `mysecond init` to restore it.\n'
    );
    return false;
  }

  const base = readFileSync(claudeMdPath, 'utf8');

  // Codex P1: validate every server-provided import path before it is
  // rendered into CLAUDE.md or used in a filesystem lookup. Drop + warn on any
  // entry that fails (control chars, traversal, absolute path, non-context,
  // non-.md). A raw `@import` line is otherwise an injection vector.
  const validImports: string[] = [];
  for (const importPath of resolvedImports) {
    if (isValidImportPath(importPath)) {
      validImports.push(importPath);
    } else {
      process.stderr.write(
        `[mysecond] Warning: ignoring invalid @import path from server: ${JSON.stringify(importPath)} — must be a project-relative context/*.md path.\n`
      );
    }
  }

  // Extract the existing block so we can read the company/pm names from it.
  // CRLF-tolerant: the marker may be followed by \r\n or trailing whitespace.
  const startIdx = base.indexOf(CLAUDE_MD_MARKER_START);
  const endIdx = base.indexOf(CLAUDE_MD_MARKER_END);
  let companyName = 'your company';
  let pmName = 'you';
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Slice from just after the start marker; extractCompanyName/extractPmName
    // each trim trailing \r per line, so a \r\n or trailing-space after the
    // marker no longer breaks extraction.
    const existingBlock = base.slice(
      startIdx + CLAUDE_MD_MARKER_START.length,
      endIdx
    );
    companyName = extractCompanyName(existingBlock.replace(/^[ \t\r]*\n/, '')) ?? companyName;
    pmName = extractPmName(existingBlock) ?? pmName;
  }

  const newBlock = claudeMdBlock(companyName, pmName, validImports);
  const spliced = spliceBetweenMarkers(
    base,
    CLAUDE_MD_MARKER_START,
    CLAUDE_MD_MARKER_END,
    newBlock
  );

  if (spliced === null) {
    process.stderr.write(
      '[mysecond] CLAUDE.md mysecond markers are missing, duplicated, or reversed — skipping regeneration to avoid corrupting the file. Re-run `mysecond init` to restore them.\n'
    );
    return false;
  }

  writeFileSync(claudeMdPath, spliced);

  // Warn for any (already-validated) @import target that doesn't exist on
  // disk. A broken @import is silent — the user just sees a generic agent
  // instead of their context.
  for (const importPath of validImports) {
    const fullPath = join(rootDir, importPath);
    if (!existsSync(fullPath)) {
      process.stderr.write(
        `[mysecond] Warning: @import target not found on disk: ${importPath} — sync the project to download the missing file.\n`
      );
    }
  }
  return true;
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

// Timeout opts for SessionStart-context up-syncs. Silent mode = fast-fail at
// 8s so a slow server doesn't stall Claude Code Desktop launch. Non-silent
// callers fall through to the 30s default in companionFetch.
function silentSyncOpts(ctx: CommandContext): { timeoutMs?: number } {
  return ctx.silent ? { timeoutMs: SILENT_SYNC_TIMEOUT_MS } : {};
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

  const result = await artifactsSync(ctx, toSync, silentSyncOpts(ctx));
  if (result.synced > 0) {
    const now = new Date().toISOString();
    for (const a of toSync) {
      state.artifacts[a.file_path] = { hash: a.current_hash, pushedAt: now };
    }
  }
  return result.synced;
}

async function upSyncContextFiles(
  ctx: CommandContext,
  state: SyncState
): Promise<number> {
  const files = scanContextFiles(ctx.rootDir);
  const toSync = files.filter((f) => {
    const last = state.contextFiles[f.file_path];
    return !last || last.hash !== f.current_hash;
  });
  if (toSync.length === 0) return 0;

  const result = await contextFilesPush(ctx, toSync, silentSyncOpts(ctx));
  if (result.synced > 0 || result.skipped > 0) {
    const now = new Date().toISOString();
    for (const f of toSync) {
      state.contextFiles[f.file_path] = { hash: f.current_hash, pushedAt: now };
    }
  }
  return result.synced;
}

function printSummary(
  summary: SyncSummary,
  ctx: CommandContext,
  pluginRefreshNudge: string | null = null,
): void {
  if (ctx.silent) {
    // SessionStart-hook output protocol. The hook's stdout is parsed as JSON, so
    // route notices by audience: top-level `systemMessage` is shown DIRECTLY to
    // the user by Claude Code; `hookSpecificOutput.additionalContext` is a system
    // reminder Claude reads but the user doesn't see. Plain stdout would ALL become
    // additionalContext (and stderr on exit 0 is dropped) — neither reliably reaches
    // the user — so the plugin-refresh nudge MUST ride in systemMessage. Verified
    // against code.claude.com/docs/en/hooks.
    const summaryLines: string[] = [];
    const parts: string[] = [];
    const contextChanges =
      summary.created + summary.updatedFromCloud + summary.conflictsCloudKept;
    if (contextChanges > 0) parts.push(`${contextChanges} context updates`);
    if (summary.skillsUpdated > 0) parts.push(`${summary.skillsUpdated} skills`);
    if (summary.agentsUpdated > 0) parts.push(`${summary.agentsUpdated} agents`);
    if (summary.workflowsUpdated > 0) parts.push(`${summary.workflowsUpdated} workflows`);
    if (summary.artifactsPushed > 0) parts.push(`${summary.artifactsPushed} artifacts pushed`);
    if (summary.contextFilesPushed > 0) parts.push(`${summary.contextFilesPushed} context files pushed`);
    const conflicts =
      summary.conflictsCloudKept + summary.conflictsLocalKept + summary.conflictsSkipped;
    if (conflicts > 0) parts.push(`${conflicts} conflicts (see .claude/sync-conflicts/)`);
    if (parts.length > 0) {
      summaryLines.push(`mysecond: ${parts.join(', ')}`);
    }
    // Workstream H: base-plugin updates as a distinct line so Claude (which reads
    // additionalContext) can distinguish "your customs synced" from "mySecond
    // shipped improvements." Link to /changelog so the customer can dig in.
    const baseTotal =
      summary.baseSkillsUpdated + summary.baseAgentsUpdated + summary.baseWorkflowsUpdated;
    if (baseTotal > 0) {
      const baseParts: string[] = [];
      if (summary.baseSkillsUpdated > 0) baseParts.push(`${summary.baseSkillsUpdated} skills`);
      if (summary.baseAgentsUpdated > 0) baseParts.push(`${summary.baseAgentsUpdated} agents`);
      if (summary.baseWorkflowsUpdated > 0) baseParts.push(`${summary.baseWorkflowsUpdated} workflows`);
      const baseTag = summary.basePluginVersion
        ? ` (base ${summary.basePluginVersion.slice(0, 7)})`
        : '';
      summaryLines.push(
        `mysecond: ${baseParts.join(', ')} updated${baseTag} — see https://app.mysecond.ai/changelog`,
      );
    }

    const additionalContext = summaryLines.join('\n');
    const payload: {
      systemMessage?: string;
      hookSpecificOutput: { hookEventName: 'SessionStart'; additionalContext?: string };
    } = { hookSpecificOutput: { hookEventName: 'SessionStart' } };
    if (additionalContext.length > 0) {
      payload.hookSpecificOutput.additionalContext = additionalContext;
    }
    if (pluginRefreshNudge) payload.systemMessage = pluginRefreshNudge;
    // Emit the single hook-protocol JSON object only when there's something to
    // say — otherwise stay quiet so SessionStart isn't noisy.
    if (
      payload.systemMessage !== undefined ||
      payload.hookSpecificOutput.additionalContext !== undefined
    ) {
      process.stdout.write(JSON.stringify(payload) + '\n');
    }
    return;
  }

  const out = process.stdout;
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
  if (summary.contextFilesPushed) parts.push(`${summary.contextFilesPushed} context files pushed`);
  if (summary.claudeMdUpdated) parts.push('CLAUDE.md updated');
  if (summary.baseSkillsUpdated)
    parts.push(`${summary.baseSkillsUpdated} skills updated from mysecond.ai`);
  if (summary.baseAgentsUpdated)
    parts.push(`${summary.baseAgentsUpdated} agents updated from mysecond.ai`);
  if (summary.baseWorkflowsUpdated)
    parts.push(`${summary.baseWorkflowsUpdated} workflows updated from mysecond.ai`);
  if (parts.length === 0) parts.push('nothing changed');

  out.write(`✓ Sync complete: ${parts.join(', ')}.\n`);
  if (summary.basePluginVersion) {
    // Short SHA — which product-manager-os base this project is synced to.
    out.write(`  Base plugin: ${summary.basePluginVersion.slice(0, 7)} (mysecond.ai)\n`);
  }
  if (summary.conflictsCloudKept > 0 || summary.conflictsLocalKept > 0) {
    out.write(`  Recover backed-up versions from .claude/sync-conflicts/ if needed.\n`);
  }
  if (
    summary.baseSkillsUpdated > 0 ||
    summary.baseAgentsUpdated > 0 ||
    summary.baseWorkflowsUpdated > 0
  ) {
    out.write(`  See what changed: https://app.mysecond.ai/changelog\n`);
  }

  // Interactive `mysecond sync`: print the nudge as a plain line (the terminal is
  // user-visible here; the JSON `systemMessage` protocol is only for the hook).
  if (pluginRefreshNudge) {
    out.write(`${pluginRefreshNudge}\n`);
  }
}

/**
 * Migration nudge for install-once customers who never re-ran `mysecond
 * init` after v1.3.4 shipped, so step-5b never migrated their .env key
 * into the project-scoped global path. Surface a one-liner so the
 * customer's next routine `sync` produces a remediation prompt without
 * forcing it. Cheap, idempotent, doesn't block the sync.
 *
 * Skipped on Windows (step-5b doesn't run there in v1.3.4) and when
 * `--silent` is set (used by the SessionStart hook — don't pollute logs).
 */
function maybeNudgeCredsMigration(ctx: CommandContext): void {
  if (process.platform === 'win32') return;
  if (ctx.silent) return;
  const projectScoped = getProjectScopedCredsPath(ctx.rootDir);
  const envPath = `${ctx.rootDir}/.env`;
  if (existsSync(projectScoped)) return; // already migrated
  if (!existsSync(envPath)) return;       // no .env to migrate
  // Cheap content check — only nudge if .env actually has the key.
  try {
    const raw = readFileSync(envPath, 'utf8');
    if (!/^(?:export\s+)?COMPANION_API_KEY=/m.test(raw)) return;
  } catch {
    return;
  }
  process.stderr.write(
    '[mysecond] 💡 Your COMPANION_API_KEY only lives in .env, which can be committed to git.\n' +
    '   Run `mysecond init` to migrate it into a project-scoped global file. (One-time, ~2 sec.)\n'
  );
}

/**
 * Reads `MYSECOND_TEAM_ID` from the project-scoped credentials file, if
 * present. step-5b writes this line for invited-PM team-joins; it is absent
 * for Solo customers, team owners, and upgrade customers whose creds file
 * predates the team-id write. When absent we return null and `cliSync` omits
 * `team_id` — the server auto-derives it from the credential, so omitting it
 * is a safe no-op. Synchronous, local-only read; no network.
 *
 * Parsing mirrors step-5b's `readProjectScopedCreds` (same trim + quote-strip).
 */
export function readTeamIdFromCreds(rootDir: string): string | null {
  const credsPath = getProjectScopedCredsPath(rootDir);
  if (!existsSync(credsPath)) return null;
  try {
    const raw = readFileSync(credsPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('MYSECOND_TEAM_ID=')) {
        const eqIdx = trimmed.indexOf('=');
        const value = trimmed
          .slice(eqIdx + 1)
          .replace(/^["']|["']$/g, '')
          .trim();
        return value.length > 0 ? value : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * `mysecond sync --push-all` — the deterministic repair. Normal `sync` only
 * pulls; the PostToolUse `artifact-sync` hook only fires on an editor write;
 * and the SessionStart sweep silently no-ops when it can't find a credential.
 * So a customer whose context never reached the server (empty `context_files`,
 * "Install PM OS" screen despite being installed) has no in-product way to
 * catch up. This scans local context/ + work outputs and pushes them UP using
 * the resolved credential (admin-capable device token via buildContext).
 *
 * Crucially it SURFACES failure: `/api/companion/files` can return
 * `200 {synced:0, errors:[...]}` (e.g. `cannot_create_protected_file_as_pm`
 * when the credential resolved as a PM). We treat synced===0 / errors[] as a
 * failure and print actionable guidance instead of a silent success.
 */
async function runPushAll(ctx: CommandContext): Promise<number> {
  const contextFiles = scanContextFiles(ctx.rootDir);
  const artifacts = scanArtifacts(ctx.rootDir);

  if (contextFiles.length === 0 && artifacts.length === 0) {
    process.stdout.write(
      'mysecond: no local context/ or work output files found to push.\n' +
        '  Run /welcome in Claude Code to create your context files first.\n'
    );
    return 0;
  }

  let failed = false;

  if (contextFiles.length > 0) {
    const res = await contextFilesPush(ctx, contextFiles);
    const errors = res.errors ?? [];
    const accepted = res.synced + res.skipped;
    if (errors.length > 0 || accepted === 0) {
      failed = true;
      process.stderr.write(
        `mysecond: sent ${contextFiles.length} context file(s); server accepted ${res.synced}.\n`
      );
      if (errors.length > 0) {
        for (const e of errors.slice(0, 10)) process.stderr.write(`  - ${e}\n`);
        if (errors.some((e) => e.includes('cannot_create_protected_file_as_pm'))) {
          process.stderr.write(
            '  Your credential resolved as a PM (no admin user), so protected context/ files\n' +
              '  cannot be created. Re-authenticate with an admin device token: `mysecond init --resume`.\n'
          );
        }
      } else {
        process.stderr.write(
          '  The server accepted nothing. Check `mysecond doctor` and that your credential is valid.\n'
        );
      }
    } else {
      // accepted === synced + skipped; report both so a `synced:0, skipped:N`
      // (everything already up to date) success doesn't read as "pushed 0".
      const upToDate = res.skipped > 0 ? `, ${res.skipped} already up to date` : '';
      process.stdout.write(
        `mysecond: pushed ${res.synced} context file(s)${upToDate}.\n`
      );
    }
  }

  if (artifacts.length > 0) {
    const ares = await artifactsSync(ctx, artifacts);
    if (ares.synced > 0) {
      process.stdout.write(`mysecond: pushed ${ares.synced} work artifact(s).\n`);
    } else {
      // ArtifactsResponse carries only { synced } — no errors[]/skipped — so we
      // can't tell "already up to date" from "rejected". Don't hard-fail (that
      // would false-fail on a re-run where artifacts are already synced), but
      // don't claim success either: surface it neutrally. Context-file
      // failures above remain the hard exit-1 gate (that's what strands users).
      process.stderr.write(
        `mysecond: 0 of ${artifacts.length} work artifact(s) were accepted — ` +
          'they may already be up to date, or the push was rejected. ' +
          'Run `mysecond doctor` if you expected them to sync.\n'
      );
    }
  }

  return failed ? 1 : 0;
}

/**
 * `mysecond sync --push-only` — the once-per-turn realtime push used by the
 * Stop / SubagentStop hook. Scans local artifacts + context files and pushes
 * only those whose hash changed since the last recorded push (incremental —
 * the same hash-gating as the SessionStart up-sync). It does NOT pull,
 * reconcile, touch CLAUDE.md, pull base-plugin updates, or run the npm-nag —
 * those belong to the full SessionStart sync, not every turn.
 *
 * It persists ONLY the keys it actually pushed, via the locked updateSyncState,
 * so it never clobbers a concurrent PostToolUse `artifact-sync` write.
 *
 * Best-effort + silent-safe: a push failure is swallowed under --silent (the
 * hook path) and surfaced in interactive mode; the command always returns 0.
 */
export async function runPushOnly(ctx: CommandContext): Promise<number> {
  const state = readSyncState(ctx.rootDir);
  const opts = silentSyncOpts(ctx);

  const pushedArtifacts: Record<string, SyncStateArtifactEntry> = {};
  const pushedContext: Record<string, SyncStateContextEntry> = {};

  // Artifacts (work outputs). scanArtifacts is hardened (size-capped + skips
  // unreadable files) so a single bad file can't fail the whole turn sweep.
  try {
    const artifacts = scanArtifacts(ctx.rootDir);
    const toSync = artifacts.filter((a) => {
      const last = state.artifacts[a.file_path];
      return !last || last.hash !== a.current_hash;
    });
    if (toSync.length > 0) {
      const res = await artifactsSync(ctx, toSync, opts);
      // Record hashes ONLY on a full accept. The artifacts response carries
      // just { synced } (no per-file errors), so a partial accept
      // (synced < count) must not mark un-accepted files as pushed — that would
      // suppress retry until the file changes again. On a partial/failed push
      // we record nothing and the next turn retries.
      //
      // No "already-current → synced:0 → re-push forever" loop: the artifacts
      // endpoint UPSERTS every accepted file (it has no unchanged-skip path), so
      // synced === count on a clean accept. A synced < count therefore means a
      // genuine conflict/error on those files — correct to retry, not record.
      if (res.synced >= toSync.length) {
        const now = new Date().toISOString();
        for (const a of toSync) {
          pushedArtifacts[a.file_path] = { hash: a.current_hash, pushedAt: now };
        }
      }
    }
  } catch (err) {
    if (!ctx.silent) {
      process.stderr.write(
        `mysecond: artifact push-only failed (${err instanceof Error ? err.message : String(err)}).\n`
      );
    }
  }

  // Context files.
  try {
    const files = scanContextFiles(ctx.rootDir);
    const toSync = files.filter((f) => {
      const last = state.contextFiles[f.file_path];
      return !last || last.hash !== f.current_hash;
    });
    if (toSync.length > 0) {
      const res = await contextFilesPush(ctx, toSync, opts);
      // Record only on a clean accept (no per-file errors). synced + skipped =
      // accepted (new/updated + already-current); a non-empty errors[] means
      // the server rejected some, so record nothing and retry next turn rather
      // than marking a rejected file as pushed.
      const errs = res.errors ?? [];
      if (errs.length === 0 && (res.synced > 0 || res.skipped > 0)) {
        const now = new Date().toISOString();
        for (const f of toSync) {
          pushedContext[f.file_path] = { hash: f.current_hash, pushedAt: now };
        }
      }
    }
  } catch (err) {
    if (!ctx.silent) {
      process.stderr.write(
        `mysecond: context push-only failed (${err instanceof Error ? err.message : String(err)}).\n`
      );
    }
  }

  const artifactCount = Object.keys(pushedArtifacts).length;
  const contextCount = Object.keys(pushedContext).length;
  if (artifactCount > 0 || contextCount > 0) {
    // Persist ONLY the keys we pushed, merged onto a freshly-read state under
    // lock — never overwrite hashes a concurrent writer recorded.
    await updateSyncState(ctx.rootDir, (s) => {
      Object.assign(s.artifacts, pushedArtifacts);
      Object.assign(s.contextFiles, pushedContext);
    });
    // stdout so Claude (which reads hook stdout as context) can note the sync.
    // Emitted only when something was actually pushed — the common no-change
    // turn stays silent.
    const parts: string[] = [];
    if (artifactCount > 0) parts.push(`${artifactCount} artifact(s)`);
    if (contextCount > 0) parts.push(`${contextCount} context file(s)`);
    process.stdout.write(`mysecond: pushed ${parts.join(' + ')}.\n`);
  }

  return 0;
}

export async function runSync(
  _args: readonly string[],
  ctx: CommandContext
): Promise<number> {
  if (ctx.apiKey.length === 0) {
    throw MysecondError.invalidApiKey('COMPANION_API_KEY not set');
  }

  // `--push-all`: explicit local→server catch-up, independent of the pull
  // reconcile and the hook side effects. Return early — push-all is a
  // standalone repair, not part of the normal pull flow.
  if (ctx.pushAll) {
    return runPushAll(ctx);
  }

  // `--push-only`: the once-per-turn realtime up-sync used by the Stop /
  // SubagentStop hook. Incremental (changed files only) and standalone — no
  // pull. Return early so a turn-end push never triggers a full re-pull.
  if (ctx.pushOnly) {
    return runPushOnly(ctx);
  }

  maybeNudgeCredsMigration(ctx);

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

  // Workstream H: read install-state BEFORE the cliSync call so we can send
  // the recorded base_plugin_version. Server uses it to decide whether to
  // include base_skills/agents/workflows in the response.
  const installState = readInstallState(ctx.rootDir);

  // CTO P1: context sync failure is partial-success, not a hard install failure.
  // Plugin install already succeeded at this point. Warn loudly + exit 0 so
  // the customer has a working PM OS (minus the context files), and knows to retry.
  // CTO BLOCKING-1: emit sync_failed telemetry with HTTP status for funnel analysis.
  let response: Awaited<ReturnType<typeof cliSync>>;
  try {
    response = await cliSync(ctx, previousPaths, {
      ...cliSyncOpts,
      clientBasePluginVersion: installState.base_plugin_version,
      teamId: readTeamIdFromCreds(ctx.rootDir),
      clientPluginContractVersion: state.installedPluginContractVersion,
    });
  } catch (err) {
    const httpCode = err instanceof MysecondError ? err.exitCode : -1;
    const errMsg = err instanceof Error ? err.message : String(err);
    void emitTelemetry(ctx, 'mysecond.install.sync_failed', {
      slug: state.customerSlug ?? 'unknown',
      http_code: httpCode,
      error: errMsg,
    });
    process.stderr.write(
      `mysecond: Context sync incomplete (${errMsg}).\n` +
      `  Your PM OS is installed but context files are not downloaded yet.\n` +
      `  Run \`mysecond sync\` to retry. If this persists, email hello@mysecond.ai with slug: ${state.customerSlug ?? 'unknown'}.\n`
    );
    // Exit 0 — partial success. Plugin is installed; only context files missing.
    return 0;
  }

  const contextFiles: ContextFile[] = response.context_files ?? response.files ?? [];
  const customSkills = response.custom_skills ?? [];
  const customAgents = response.custom_agents ?? [];
  const customWorkflows = response.custom_workflows ?? [];
  const claudeMdOverride = response.claude_md_override ?? null;
  const deletedPaths = response.deleted_paths ?? [];

  const paths = projectPaths(ctx.rootDir);

  // file_path values from the API are already project-relative (e.g.
  // "context/company.md", "work/specs/outputs/.../prd.md"). Use rootDir as
  // the base — using contextDir prepended an extra "context/" to every path,
  // so work outputs landed under <rootDir>/context/work/... instead of
  // <rootDir>/work/...  (regression introduced when the API started serving
  // work/* and decisions/* alongside context/*).
  for (const file of contextFiles) {
    const localContent = readLocalFile(ctx.rootDir, file.file_path);
    const outcome = resolveConflict({ file, localContent, syncState: state, ctx });
    tally(summary, outcome);
  }

  for (const filePath of deletedPaths) {
    if (deleteLocalFile(ctx.rootDir, filePath)) {
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

  // Workstream H: pull base plugin updates (skills/agents/workflows from
  // mysecond-ai/product-manager-os). The arrays are present only when the
  // server determined we're behind. Per file: overwrite if customer hasn't
  // touched it; silently skip otherwise. Update install-state for every
  // successful overwrite, then persist the new base_plugin_version so the
  // next sync starts from this point. base_plugin_version may legitimately
  // be null on this response (server soft-failed) — only persist when we
  // actually got a SHA back.
  const skillsResult = syncBaseTree(ctx, response.base_skills, installState);
  summary.baseSkillsUpdated += skillsResult.updated;
  summary.baseSkippedDueToCustomization += skillsResult.skipped;

  const agentsResult = syncBaseTree(ctx, response.base_agents, installState);
  summary.baseAgentsUpdated += agentsResult.updated;
  summary.baseSkippedDueToCustomization += agentsResult.skipped;

  const workflowsResult = syncBaseTree(ctx, response.base_workflows, installState);
  summary.baseWorkflowsUpdated += workflowsResult.updated;
  summary.baseSkippedDueToCustomization += workflowsResult.skipped;

  // Persist install-state if anything changed (new files written, hashes
  // updated, or base_plugin_version advanced). Always safe to write — the
  // file shape is stable.
  if (typeof response.base_plugin_version === 'string') {
    installState.base_plugin_version = response.base_plugin_version;
    // Surface the base SHA in the sync summary (observability — Phase 7 of
    // plan i-create-a-deeper-witty-dawn). Set ONLY from a SHA this response
    // actually returned — never from the persisted installState value. On a
    // server soft-fail (base files present, base_plugin_version null/absent)
    // the persisted value is stale; tagging it would point at the wrong base
    // for files just updated from an unknown newer one (codex review). When
    // no SHA comes back, the summary simply omits the base tag.
    summary.basePluginVersion = response.base_plugin_version;
  }
  if (
    skillsResult.updated > 0 ||
    agentsResult.updated > 0 ||
    workflowsResult.updated > 0 ||
    typeof response.base_plugin_version === 'string'
  ) {
    try {
      writeInstallState(ctx.rootDir, installState);
    } catch {
      // Soft-fail: install-state is optimization, not correctness. If we
      // can't write it, next sync re-evaluates from current local SHAs and
      // will likely re-write the same content (idempotent).
    }
  }

  if (claudeMdOverride) {
    mergeClaudeMdOverride(paths.claudeMdPath, claudeMdOverride);
    summary.claudeMdUpdated = true;
  }

  // Workstream B Phase 2, Track C: re-generate the mysecond block from the
  // server-provided resolved_imports list. This ensures every sync reflects
  // the user's actual per-user file set (team-shared + products + personal).
  //
  // Codex P4 — semantics:
  //   - `undefined` (field absent: older server / legacy API key with no
  //     member identity) → no-op, block left as-is.
  //   - an actual array, INCLUDING `[]`, is authoritative → re-splice with
  //     exactly those imports. An empty array clears stale imports rather than
  //     being silently skipped.
  // Codex P5 — only flag "CLAUDE.md updated" when regenerateMysecondBlock
  // reports a real write (it fails closed on missing file / corrupt markers).
  if (Array.isArray(response.resolved_imports)) {
    const wrote = regenerateMysecondBlock(
      paths.claudeMdPath,
      ctx.rootDir,
      response.resolved_imports
    );
    if (wrote) summary.claudeMdUpdated = true;
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

  try {
    summary.contextFilesPushed = await upSyncContextFiles(ctx, state);
  } catch (err) {
    if (!ctx.silent) {
      process.stderr.write(
        `mysecond: context-file up-sync failed (${err instanceof Error ? err.message : String(err)}). Down-sync OK.\n`
      );
    }
  }

  // The 24h gate is honored; actual `npm update -g @mysecond/customer-{slug}`
  // invocation lands when PR 4c provisions the customer plugin slug to local
  // state. Until then the gate stamps the timestamp so the cadence starts
  // from install day AND drives the upgrade-staleness probe (issue #34):
  // fetch the latest published `@mysecond/cli` version once per 24h and
  // cache it in sync-state for `maybePrintUpgradeNag` below.
  //
  // markNpmUpdated stamps regardless of fetch outcome (success or null).
  // Rationale: the SessionStart hook runs on EVERY Claude Code session — a
  // multi-hour npm registry outage would otherwise hammer the registry on
  // every session start. Worst case of stamping-on-failure is a 24h delay
  // before the next retry, acceptable for a nag (vs. a feature). Auto-
  // upgrade follow-up should split `lastNpmUpdateAt` into
  // `lastVersionCheckAt` so success and failure cadences can diverge —
  // tracked in the issue #34 plan's "Foundation for auto-upgrade" section.
  if (shouldRunNpmUpdate(state, ctx)) {
    const latest = await fetchLatestNpmVersion();
    if (latest !== null) state.lastKnownLatestNpmVersion = latest;
    markNpmUpdated(state);
    summary.npmUpdateRan = true;
  }

  state.lastSyncedAt = response.syncedAt;
  writeSyncState(ctx.rootDir, state);

  // Issue #34: emit one stderr line if the running CLI is behind the cached
  // latest version. Self-persisting (own writeSyncState call) so the 24h
  // prompt debounce stamp cannot be lost by call-site ordering mistakes.
  // Called AFTER the writeSyncState above so the same persist isn't done
  // twice in the common (no-nag) case.
  maybePrintUpgradeNag(state, ctx.rootDir);

  // Plugin-refresh nudge: resolve the text now (this persists the 24h debounce
  // stamp + honors force/silence), but DON'T emit here — printSummary emits it
  // below on the right channel. In the SessionStart hook (silent) it rides in the
  // hook JSON's top-level `systemMessage`, which Claude Code shows to the USER
  // directly (plain stdout → additionalContext, which the user never reliably sees).
  const pluginRefreshNudge = resolvePluginRefreshNudge(
    state,
    ctx.rootDir,
    response.latest_plugin_contract_version ?? null
  );

  // Self-heal the "duplicate skills" bug (Finding #2) for EXISTING customers.
  // step-9 (plugin install) is skipped on re-runs once the init ledger is
  // complete, so a customer who onboarded during the 2026-05-04→05
  // multi-category experiment window — and now carries 13 orphaned `pm-*`
  // plugins alongside `pm-os` — would never get cleaned up by `init` alone.
  // `sync` runs on every SessionStart hook, so pruning here auto-heals them on
  // their next session. Scoped strictly to this customer's own slug;
  // best-effort and idempotent — a no-op for the common case where there are
  // no stale plugins. Never fails the sync.
  if (state.customerSlug !== null && state.customerSlug !== undefined && state.customerSlug !== '') {
    try {
      // pruneStalePlugins validates the slug internally — the SessionStart
      // sync path has NO prior validateSlug() on state.customerSlug, so an
      // invalid/corrupt sync-state.json slug is rejected inside (no-op).
      const prune = await pruneStalePlugins(state.customerSlug, { silent: ctx.silent });
      if (!prune.noop && prune.removed.length > 0 && !ctx.silent) {
        process.stderr.write(
          `[mysecond] Removed ${prune.removed.length} stale plugin(s) from a prior install: ${prune.removed.join(', ')}\n`
        );
      }
    } catch {
      // Best-effort: stale-plugin cleanup must never fail a sync.
    }
  }

  // First-sync = no prior server timestamp AND no prior tracked paths. Both
  // checks must use the snapshots captured before any state mutations above.
  const wasFirstSync = priorLastSyncedAt === null && previousPaths.length === 0;
  if (wasFirstSync) {
    await confirmFirstSetup(ctx);
  }

  printSummary(summary, ctx, pluginRefreshNudge);
  return 0;
}
