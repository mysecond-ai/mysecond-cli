// `mysecond artifact-sync --silent` — PostToolUse dispatcher.
//
// Invoked by the customer plugin's PostToolUse hook (registered in plugin.json
// by the regen worker per CAIO-Y1 architectural change in PR #78). Hook command
// is `bash -lc 'mysecond artifact-sync --silent'` — Claude Code passes the tool
// event as JSON on stdin.
//
// This replaces the legacy v1.0.0 `ensureArtifactSync()` bash script (which
// `sync-context.js` wrote to `.claude/hooks/artifact-sync.sh`). That entire
// shell-script-on-disk + settings.json hook registration path is gone — plugin
// manifest is now the single source of truth for hook registration.
//
// Contract: never error loudly. The customer is mid-Claude-action when this
// fires. Surface failures via stderr only when `--verbose` is passed (PR 4c
// adds the flag); never block the tool call.

import { artifactsSync } from '../lib/api.js';
import type { CommandContext } from '../lib/context.js';
import { shortHash } from '../lib/files.js';
import { classifyArtifactType, type ArtifactPayload } from '../lib/payload.js';

interface ToolEvent {
  tool_name?: string;
  tool_input?: { file_path?: string };
}

const MAX_FILE_BYTES = 3_000_000;

async function readStdin(): Promise<string> {
  // Node 18+ stdin streams as async iterable.
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
  // Hook protocol: even on errors we exit 0 so Claude Code's tool call doesn't
  // get blamed for our problems. The whole subcommand is best-effort.
  if (ctx.apiKey.length === 0) return 0;

  const raw = await readStdin();
  const event = parseEvent(raw);
  if (event === null) return 0;
  if (event.tool_name !== 'Write') return 0;

  const filePath = event.tool_input?.file_path;
  if (filePath === undefined || filePath.length === 0) return 0;

  // The hook fires from the project dir, so file_path is typically absolute.
  // Convert to project-relative; reject if outside the project tree.
  const rootDir = ctx.rootDir;
  const relativePath = filePath.startsWith(rootDir + '/')
    ? filePath.slice(rootDir.length + 1)
    : filePath.startsWith('/')
    ? null
    : filePath;
  if (relativePath === null) return 0;

  const artifactType = classifyArtifactType(relativePath);
  if (artifactType === null) return 0;

  // Read the file content. If it grew beyond the size guard or disappeared
  // between the Write and the hook firing, skip silently.
  let content: string;
  try {
    const { readFileSync, statSync } = await import('node:fs');
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
    // Best-effort: any network error is swallowed so the next sync picks it up.
  }
  return 0;
}
