// HTTP client wrappers for the mysecond-app companion API.
//
// All calls use Node 18+ native fetch (no node-fetch dep). Authentication via
// Bearer token from CommandContext.apiKey. Network errors and non-2xx responses
// raise typed MysecondError values so callers don't need to inspect HTTP shape.

import type { CommandContext } from './context.js';
import { MysecondError } from './errors.js';
import type {
  ArtifactPayload,
  ArtifactsResponse,
  CliSyncResponse,
} from './payload.js';

interface FetchOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  query?: Record<string, string | undefined>;
  // Reject the request if it doesn't complete within this many milliseconds.
  // Default 30s — long enough for slow networks; short enough to keep
  // SessionStart hooks from blocking session start.
  timeoutMs?: number;
}

interface ApiResponse {
  status: number;
  body: unknown;
}

// Shared low-level fetch — handles timeout, JSON encode/decode, network-error
// translation. Throws MysecondError on network failure; returns { status, body }
// for any HTTP status (callers branch on status themselves).
async function companionFetch(
  ctx: CommandContext,
  path: string,
  opts: FetchOptions = {}
): Promise<ApiResponse> {
  const url = new URL(path, ctx.apiBase);
  if (opts.query) {
    for (const [key, value] of Object.entries(opts.query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);

  try {
    const response = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${ctx.apiKey}`,
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });

    let body: unknown = null;
    const text = await response.text();
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, body };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw MysecondError.networkUnreachable(`request to ${path} timed out`);
    }
    throw MysecondError.networkUnreachable(
      err instanceof Error ? err.message : String(err)
    );
  } finally {
    clearTimeout(timeout);
  }
}

// GET /api/companion/cli-sync — pull context_files, custom_skills, custom_agents,
// custom_workflows, claude_md_override, deleted_paths.
export async function cliSync(
  ctx: CommandContext,
  previousPaths: readonly string[]
): Promise<CliSyncResponse> {
  const query: Record<string, string | undefined> = {};
  if (previousPaths.length > 0) {
    query['previous_paths'] = previousPaths.join(',');
  }
  const response = await companionFetch(ctx, '/api/companion/cli-sync', { query });

  if (response.status === 401 || response.status === 403) {
    throw MysecondError.invalidApiKey(`HTTP ${response.status}`);
  }
  if (response.status >= 400) {
    throw new MysecondError(
      1,
      `cli-sync failed (HTTP ${response.status}). Run \`mysecond sync\` to retry.`
    );
  }
  return response.body as CliSyncResponse;
}

// POST /api/companion/artifacts — up-sync artifact files.
export async function artifactsSync(
  ctx: CommandContext,
  artifacts: readonly ArtifactPayload[]
): Promise<ArtifactsResponse> {
  if (artifacts.length === 0) return { synced: 0 };
  const response = await companionFetch(ctx, '/api/companion/artifacts', {
    method: 'POST',
    body: { artifacts },
  });
  if (response.status >= 400) {
    // Up-sync failure is non-fatal — the legacy code logs and moves on so the
    // down-sync result still reaches the customer. Match that contract by
    // returning synced: 0 and letting the caller decide whether to surface.
    return { synced: 0 };
  }
  return response.body as ArtifactsResponse;
}

// POST /api/setup/confirm — first-sync confirmation. Best-effort; non-critical
// if it fails (web app reconciles on next poll). Returns boolean for telemetry.
export async function confirmFirstSetup(ctx: CommandContext): Promise<boolean> {
  try {
    const response = await companionFetch(ctx, '/api/setup/confirm', { method: 'POST' });
    return response.status < 400;
  } catch {
    return false;
  }
}
