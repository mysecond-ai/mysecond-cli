// `mysecond artifact-sync --silent` — PostToolUse dispatcher. EDD §5.5.
// Hook command (per regen worker): `bash -lc 'mysecond artifact-sync --silent'`.
// Tool event arrives as JSON on stdin. Always exits 0 — this is best-effort
// hook plumbing and the customer's tool call shouldn't get blamed for our
// problems.

import { readFileSync, statSync } from 'node:fs';

import { artifactsSync, contextFilesPush } from '../lib/api.js';
import type { CommandContext } from '../lib/context.js';
import { relativeFromRoot, shortHash } from '../lib/files.js';
import {
  CONTEXT_PER_FILE_LIMIT,
  classifyArtifactType,
  isContextFile,
  type ArtifactPayload,
  type ContextFilePayload,
} from '../lib/payload.js';
import { readSyncState, writeSyncState } from '../lib/sync-state.js';

interface ToolEvent {
  tool_name?: string;
  tool_input?: { file_path?: string };
}

const MAX_FILE_BYTES = 3_000_000;

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

  // Context-file branch — checked BEFORE artifact classification so the same
  // file can never be misrouted (context/foo.md must never be classified as
  // an artifact, even if some future ARTIFACT_DIRS entry overlapped).
  if (isContextFile(relativePath)) {
    let content: string;
    try {
      const stat = statSync(filePath);
      if (stat.size > CONTEXT_PER_FILE_LIMIT) return 0;
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
    } catch {
      // Best-effort: TODO(telemetry) emit PostHog event when telemetry lands.
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
  } catch {
    // Best-effort: TODO(telemetry) emit PostHog event when telemetry lands.
  }
  return 0;
}
