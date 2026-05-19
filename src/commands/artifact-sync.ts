// `mysecond artifact-sync --silent` — PostToolUse dispatcher. EDD §5.5.
// Hook command (per regen worker): `bash -lc 'mysecond artifact-sync --silent'`.
// Tool event arrives as JSON on stdin. Always exits 0 — this is best-effort
// hook plumbing and the customer's tool call shouldn't get blamed for our
// problems.

import { readFileSync, statSync } from 'node:fs';

import { artifactsSync, contextFilesPush } from '../lib/api.js';
import type { CommandContext } from '../lib/context.js';
import { MysecondError } from '../lib/errors.js';
import { relativeFromRoot, shortHash } from '../lib/files.js';
import {
  CONTEXT_PER_FILE_LIMIT,
  buildAuthoredBy,
  classifyArtifactType,
  isContextFile,
  isCustomsArtifact,
  type ArtifactPayload,
  type ContextFilePayload,
} from '../lib/payload.js';
import { readSyncState, writeSyncState } from '../lib/sync-state.js';

interface ToolEvent {
  tool_name?: string;
  tool_input?: { file_path?: string };
}

const MAX_FILE_BYTES = 3_000_000;

// Customs v1 paths (.claude/skills/*, .claude/agents/*, .claude/workflows/*)
// can carry longer bodies + heavier frontmatter than typical context/ files.
// Receiver hard cap (mysecond-app) is 3MB total per batch and ~100KB per file
// for these paths. Pre-filter here to skip a wasted round-trip on outliers.
const CUSTOMS_PER_FILE_LIMIT = 100 * 1024;

// Tools that write files and therefore produce artifacts worth syncing.
// Hard-string list intentionally — see TODO. Worth tracking separately because
// Claude Code may add new write-class tool names (e.g. MultiWrite) that we'd
// silently miss. CAIO-flagged in PR 4b review; matches Anthropic's current
// PostToolUse hook taxonomy as of 2026-04-22.
// TODO: subscribe to Claude Code release notes / changelog and bump this list
// when new write-class tool names are introduced.
const WRITE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit']);

async function readStdin(): Promise<string> {
  let buf = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buf += chunk;
    if (buf.length > MAX_FILE_BYTES * 2) break;
  }
  return buf;
}

function parseEvent(raw: string): ToolEvent | null {
  if (raw.trim().length === 0) return null;
  try {
    return JSON.parse(raw) as ToolEvent;
  } catch {
    return null;
  }
}

export async function runArtifactSync(
  _args: readonly string[],
  ctx: CommandContext
): Promise<number> {
  if (ctx.apiKey.length === 0) return 0;

  const raw = await readStdin();
  const event = parseEvent(raw);
  if (event === null) return 0;
  if (event.tool_name === undefined || !WRITE_TOOLS.has(event.tool_name)) return 0;

  const filePath = event.tool_input?.file_path;
  if (filePath === undefined || filePath.length === 0) return 0;

  const relativePath = relativeFromRoot(ctx.rootDir, filePath);
  if (relativePath === null) return 0;

  // Context-file branch — also handles Customs v1 paths (.claude/skills/*,
  // .claude/agents/*, .claude/workflows/*). Both go through the same
  // contextFilesPush endpoint; the receiver (mysecond-app /api/companion/
  // files) detects origin from the slug + content hash and tags rows for
  // the Custom tab. Checked BEFORE artifact classification so the same
  // file can never be misrouted.
  const customs = isCustomsArtifact(relativePath);
  if (isContextFile(relativePath) || customs) {
    let content: string;
    try {
      const stat = statSync(filePath);
      const limit = customs ? CUSTOMS_PER_FILE_LIMIT : CONTEXT_PER_FILE_LIMIT;
      if (stat.size > limit) return 0;
      content = readFileSync(filePath, 'utf8');
    } catch {
      return 0;
    }
    if (content.length === 0) return 0;

    const hash = shortHash(content);
    const payload: ContextFilePayload = {
      file_path: relativePath,
      content,
      current_hash: hash,
      // Customs v1: stamp authored_by on customs paths only. Receiver
      // normalizes unknown shapes to null; regular context/ writes don't
      // need attribution since they don't feed the Custom-tab funnel.
      ...(customs ? { authored_by: buildAuthoredBy() } : {}),
    };

    try {
      const result = await contextFilesPush(ctx, [payload]);
      // Persist sync-state ONLY on a confirmed push. synced > 0 means insert
      // or update; skipped > 0 means server hash matched (already in sync —
      // record it so SessionStart can de-dupe). Pure-error response leaves
      // state untouched so the next SessionStart up-loop retries.
      if (result.synced > 0 || result.skipped > 0) {
        const state = readSyncState(ctx.rootDir);
        state.contextFiles[relativePath] = { hash, pushedAt: new Date().toISOString() };
        writeSyncState(ctx.rootDir, state);
      }
    } catch (err) {
      // Honor server-side halt header: if the server flipped the rollback-pause
      // kill switch (exitCode 7), exit non-zero so subsequent PostToolUse events
      // also stop. Other errors stay best-effort.
      if (err instanceof MysecondError && err.exitCode === 7) throw err;
      // Best-effort: TODO(telemetry) emit sync.artifactSync.failed PostHog
      // event when telemetry lands. CAIO P1 ask; deferred because the CLI
      // currently has no PostHog wiring (only docs TODOs).
    }
    return 0;
  }

  const artifactType = classifyArtifactType(relativePath);
  if (artifactType === null) return 0;

  let content: string;
  try {
    const stat = statSync(filePath);
    if (stat.size > MAX_FILE_BYTES) return 0;
    content = readFileSync(filePath, 'utf8');
  } catch {
    return 0;
  }

  const payload: ArtifactPayload = {
    file_path: relativePath,
    content,
    current_hash: shortHash(content),
    artifact_type: artifactType,
    pm_name: null,
    skill_slug: null,
    produced_at: new Date().toISOString(),
  };

  try {
    await artifactsSync(ctx, [payload]);
  } catch (err) {
    // Same halt-header propagation as the context branch above. Server kill
    // switch must reach the PostToolUse main() catch so the hook exits non-zero.
    if (err instanceof MysecondError && err.exitCode === 7) throw err;
    // Best-effort: TODO(telemetry) emit PostHog event when telemetry lands.
  }
  return 0;
}
