// `mysecond sync` — pull context/skills/agents/workflows from mysecond.ai,
// push local artifacts back up. EDD §5.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

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
import { markNpmUpdated, shouldRunNpmUpdate } from '../lib/npm.js';
import {
  scanArtifacts,
  scanContextFiles,
  type BasePluginFile,
  type CompanionFile,
  type ContextFile,
} from '../lib/payload.js';
import { pruneStalePlugins } from '../lib/prune-stale-plugins.js';
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
    if (summary.contextFilesPushed > 0) parts.push(`${summary.contextFilesPushed} context files pushed`);
    const conflicts =
      summary.conflictsCloudKept + summary.conflictsLocalKept + summary.conflictsSkipped;
    if (conflicts > 0) parts.push(`${conflicts} conflicts (see .claude/sync-conflicts/)`);
    if (parts.length > 0) {
      out.write(`mysecond: ${parts.join(', ')}\n`);
    }
    // Workstream H: separate one-liner for base plugin updates so Claude (which
    // reads this as session-start context) clearly distinguishes "your customs
    // synced" from "mySecond shipped improvements." Customizations skipped
    // silently — never mentioned. Link to /changelog so the customer can dig in.
    const baseTotal =
      summary.baseSkillsUpdated + summary.baseAgentsUpdated + summary.baseWorkflowsUpdated;
    if (baseTotal > 0) {
      const baseParts: string[] = [];
      if (summary.baseSkillsUpdated > 0) baseParts.push(`${summary.baseSkillsUpdated} skills`);
      if (summary.baseAgentsUpdated > 0) baseParts.push(`${summary.baseAgentsUpdated} agents`);
      if (summary.baseWorkflowsUpdated > 0) baseParts.push(`${summary.baseWorkflowsUpdated} workflows`);
      // Tag the new base SHA — this is the signal for spotting a base-SHA
      // shift between sessions (a multi-session workflow can otherwise observe
      // steps written by different base versions with no way to tell).
      const baseTag = summary.basePluginVersion
        ? ` (base ${summary.basePluginVersion.slice(0, 7)})`
        : '';
      out.write(
        `mysecond: ${baseParts.join(', ')} updated${baseTag} — see https://app.mysecond.ai/changelog\n`,
      );
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

export async function runSync(
  _args: readonly string[],
  ctx: CommandContext
): Promise<number> {
  if (ctx.apiKey.length === 0) {
    throw MysecondError.invalidApiKey('COMPANION_API_KEY not set');
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
  // state. Until then the gate just stamps the timestamp so the cadence starts
  // from install day.
  if (shouldRunNpmUpdate(state, ctx)) {
    markNpmUpdated(state);
    summary.npmUpdateRan = true;
  }

  state.lastSyncedAt = response.syncedAt;
  writeSyncState(ctx.rootDir, state);

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

  printSummary(summary, ctx);
  return 0;
}
