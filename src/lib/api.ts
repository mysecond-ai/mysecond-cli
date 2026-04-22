// HTTP client wrappers for the mysecond-app companion API.
// Native Node 18+ fetch + Bearer auth from CommandContext.

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
  // Default 30s. Callers on hot paths (SessionStart) pass a shorter value to
  // avoid blocking the customer's session start on a slow network.
  timeoutMs?: number;
}

async function companionFetch(
  ctx: CommandContext,
  path: string,
  opts: FetchOptions = {}
): Promise<{ status: number; body: unknown }> {
  const url = new URL(path, ctx.apiBase);
  if (opts.query) {
    for (const [key, value] of Object.entries(opts.query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
  }

  // Node 18.17+ AbortSignal.timeout — replaces manual AbortController + setTimeout.
  // On timeout, the fetch rejects with a TimeoutError (name === 'TimeoutError').
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 30_000);

  try {
    const response = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${ctx.apiKey}`,
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal,
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
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw MysecondError.networkUnreachable(`request to ${path} timed out`);
    }
    throw MysecondError.networkUnreachable(
      err instanceof Error ? err.message : String(err)
    );
  }
}

// GET /api/companion/cli-sync — pull context_files, custom_skills, custom_agents,
// custom_workflows, claude_md_override, deleted_paths.
export async function cliSync(
  ctx: CommandContext,
  previousPaths: readonly string[],
  opts: { timeoutMs?: number } = {}
): Promise<CliSyncResponse> {
  const query: Record<string, string | undefined> = {};
  if (previousPaths.length > 0) {
    query['previous_paths'] = previousPaths.join(',');
  }
  const response = await companionFetch(ctx, '/api/companion/cli-sync', {
    query,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

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

// POST /api/companion/artifacts — up-sync artifact files. Up-sync failure is
// non-fatal: the down-sync result still reaches the customer. Caller decides
// whether to surface the partial-success.
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
    return { synced: 0 };
  }
  return response.body as ArtifactsResponse;
}

// POST /api/setup/confirm — first-sync confirmation. Best-effort; non-critical
// if it fails (web app reconciles on next poll).
export async function confirmFirstSetup(ctx: CommandContext): Promise<boolean> {
  try {
    const response = await companionFetch(ctx, '/api/setup/confirm', { method: 'POST' });
    return response.status < 400;
  } catch {
    return false;
  }
}
