// HTTP client wrappers for the mysecond-app companion API.
// Native Node 18+ fetch + Bearer auth from CommandContext. undici (Node's
// default fetch impl) honors HTTPS_PROXY / HTTP_PROXY / NO_PROXY automatically
// per Decision 0-C guardrail #5 — no proxy-config code needed here.

import type { CommandContext } from './context.js';
import { MysecondError } from './errors.js';
import type {
  ArtifactPayload,
  ArtifactsResponse,
  CliSyncResponse,
  ContextFilePayload,
  ContextFilesResponse,
} from './payload.js';
import type { PluginTarballMeta } from './plugin-tarball.js';

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

    // Server-side halt-header (Layer 1 kill switch — EDD §13.2.1, RT-7).
    // EVERY response from /api/companion/* is checked. If the flag is flipped
    // ON server-side, all CLI subcommands exit 7 immediately without performing
    // any local writes. Per CTO-v1.3-Y1 ordering: the halt check MUST happen
    // before any caller writes to disk — enforced by call-sites running this
    // BEFORE side effects.
    if (response.headers.get('X-Mysecond-Halt') === '1') {
      throw MysecondError.rollbackPause();
    }

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
    // Re-throw MysecondError verbatim (e.g., rollbackPause from halt header
    // above) so its exit code propagates to main() catch.
    if (err instanceof MysecondError) throw err;
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
  opts: {
    timeoutMs?: number;
    clientBasePluginVersion?: string | null;
    teamId?: string | null;
    clientPluginContractVersion?: string | null;
  } = {}
): Promise<CliSyncResponse> {
  const query: Record<string, string | undefined> = {};
  // Explicit client-side tenant scoping: send the team_id the install flow
  // recorded in the project-scoped credentials file, when present. The server
  // auto-derives team_id from the credential when this is omitted (see
  // mysecond-app#257 / cli-sync route), so omitting it is a safe no-op for
  // Solo customers, team owners, and upgrade customers whose creds file
  // predates the team-id line.
  if (opts.teamId) {
    query['team_id'] = opts.teamId;
  }
  if (previousPaths.length > 0) {
    query['previous_paths'] = previousPaths.join(',');
  }
  // Workstream H: tell the server which base plugin SHA we're installed at.
  // Server returns base_skills/agents/workflows only when this differs from
  // its current HEAD. New installs (no install-state.json yet) send no value
  // and the server treats that as "fully behind".
  if (opts.clientBasePluginVersion) {
    query['client_base_plugin_version'] = opts.clientBasePluginVersion;
  }
  // Report the plugin contract version we have installed (read from the
  // installed _meta.json) so the server can log fleet visibility. Truthy guard
  // mirrors the others — omit when null so we never send an empty param.
  if (opts.clientPluginContractVersion) {
    query['client_plugin_contract_version'] = opts.clientPluginContractVersion;
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
//
// timeoutMs: SessionStart hook callers should pass SILENT_SYNC_TIMEOUT_MS
// (8s) to avoid stalling Claude Code Desktop launch on a slow server.
// Default 30s for non-silent contexts.
export async function artifactsSync(
  ctx: CommandContext,
  artifacts: readonly ArtifactPayload[],
  opts: { timeoutMs?: number } = {}
): Promise<ArtifactsResponse> {
  if (artifacts.length === 0) return { synced: 0 };
  const response = await companionFetch(ctx, '/api/companion/artifacts', {
    method: 'POST',
    body: { artifacts },
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  if (response.status >= 400) {
    return { synced: 0 };
  }
  return response.body as ArtifactsResponse;
}

// POST /api/companion/files — up-sync context files (company/product/personas/
// competitors/goals + nested under context/). Mirrors artifactsSync semantics:
// best-effort, server returns { synced, skipped, errors }.
//
// timeoutMs: same SessionStart hook contract as artifactsSync — pass
// SILENT_SYNC_TIMEOUT_MS for fast-fail under load.
export async function contextFilesPush(
  ctx: CommandContext,
  files: readonly ContextFilePayload[],
  opts: { timeoutMs?: number } = {}
): Promise<ContextFilesResponse> {
  if (files.length === 0) return { synced: 0, skipped: 0, errors: [] };
  const response = await companionFetch(ctx, '/api/companion/files', {
    method: 'POST',
    body: { files },
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  if (response.status >= 400) {
    return { synced: 0, skipped: 0, errors: [] };
  }
  return response.body as ContextFilesResponse;
}

// Usage-tracking event payload posted by the `emit-event` hook dispatcher.
// Wire shape matches the bash hooks it replaces (emit-event.sh /
// emit-event-slash.sh) and the receiver at mysecond-app /api/hooks/events.
export interface HookEventPayload {
  event_type: 'skill_run' | 'workflow_run' | 'subagent_run' | 'session_start';
  // null for session_start (no name); otherwise the namespace-stripped slug.
  name: string | null;
  session_id: string | null;
  // null for session_start; otherwise the tool_use_id (or a synthetic
  // `prompt-<uuid>` for typed slash commands). Server dedups on
  // (user_id, session_id, tool_call_id) NULLS NOT DISTINCT.
  tool_call_id: string | null;
  cwd: string;
  error: boolean;
  hook_version: 'v1';
}

// POST /api/hooks/events — best-effort usage-tracking emit (team adoption
// dashboard). Returns true on success (204, also tolerate 200), false on any
// failure. This is the TS sibling of the curl in emit-event.sh.
//
// Failure policy (v1: best-effort, no retry queue — matches artifact-sync's
// best-effort model):
//   - 204/200            → success
//   - 401/400            → permanent; drop (caller does NOT retry)
//   - 429 / 5xx / network → drop for v1 (no local queue)
// Short timeout (3s) so a slow/hung network never blocks the hook. Never
// throws — a thrown network error is caught and reported as `false`.
export async function emitHookEvent(
  ctx: CommandContext,
  payload: HookEventPayload
): Promise<boolean> {
  try {
    const response = await companionFetch(ctx, '/api/hooks/events', {
      method: 'POST',
      body: payload,
      timeoutMs: 3_000,
    });
    return response.status === 204 || response.status === 200;
  } catch {
    // Network/timeout (companionFetch throws MysecondError.networkUnreachable
    // on those). Best-effort: drop, no queue.
    return false;
  }
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

// GET /api/companion/install-ready/[slug] — poll until plugin is publishable.
// Spec §6.6 + Appendix A.2. Caller polls every 3s up to 60s ceiling.
export interface InstallReadyReady {
  ready: true;
  version: string;
  install_command: string;
  customer_id: string;
  // RED-TEAM R2 P0-A: pm_name + company_name are SEPARATE server fields.
  // `customer_name` was the v1.4 conflated alias and is retained for back-
  // compat — server may still send it, in which case CLI uses it for both
  // pmName and companyName as a fallback (better than empty).
  pm_name?: string;
  company_name?: string;
  customer_name?: string;
  workspace_scope?: 'solo' | 'team';
  customer_slug?: string;
}

export type InstallReadyStatus =
  | 'provisioning'
  | 'regen_queued'
  | 'regen_in_progress'
  | 'regen_failed'
  | 'access_revoked'
  | 'schema_drift'
  | 're_provisioning';

export interface InstallReadyPending {
  ready: false;
  status: InstallReadyStatus;
  estimated_wait_seconds: number | null;
  customer_id: string;
  pm_name?: string;
  company_name?: string;
  customer_name?: string;
  workspace_scope?: 'solo' | 'team';
  customer_slug?: string;
}

export type InstallReadyResponse = InstallReadyReady | InstallReadyPending;

export async function installReady(ctx: CommandContext, slug: string): Promise<InstallReadyResponse> {
  const path = `/api/companion/install-ready/${encodeURIComponent(slug)}`;
  const response = await companionFetch(ctx, path);
  if (response.status === 401 || response.status === 403) {
    throw MysecondError.invalidApiKey(`HTTP ${response.status} on /install-ready`);
  }
  if (response.status === 404) {
    // Race with webhook — caller's poll loop retries.
    throw new MysecondError(4, 'Plugin not yet provisioned. Retrying…');
  }
  if (response.status >= 500) {
    throw MysecondError.networkUnreachable(`/install-ready returned HTTP ${response.status}`);
  }
  if (response.status >= 400) {
    throw new MysecondError(1, `/install-ready failed (HTTP ${response.status})`);
  }
  return response.body as InstallReadyResponse;
}

// GET /api/companion/plugin-tarball/[slug] — issues signed URL pointing at
// object-storage tarball + SHA + version + expiry. Decision 0-C step 9 (a).
// Auth gate: 401/403 here is the consolidated invalid-key/sub-cancelled/
// plugin-revoked branch (was step 2 in v1.4 npmrc-token path).
export async function pluginTarball(ctx: CommandContext, slug: string): Promise<PluginTarballMeta> {
  const path = `/api/companion/plugin-tarball/${encodeURIComponent(slug)}`;
  const response = await companionFetch(ctx, path);
  if (response.status === 401) {
    throw MysecondError.invalidApiKey(`HTTP 401 on /plugin-tarball`);
  }
  if (response.status === 403) {
    // Server distinguishes via response body: { error: 'subscription_cancelled' | 'plugin_revoked' }
    const body = (response.body ?? {}) as { error?: string };
    if (body.error === 'subscription_cancelled') {
      throw MysecondError.subscriptionCancelled();
    }
    if (body.error === 'plugin_revoked') {
      throw MysecondError.pluginRevoked();
    }
    throw MysecondError.invalidApiKey(`HTTP 403 on /plugin-tarball`);
  }
  if (response.status === 404) {
    throw new MysecondError(4, 'Plugin tarball not yet published. Re-run `mysecond init` in 60s.');
  }
  if (response.status >= 500) {
    throw MysecondError.networkUnreachable(`/plugin-tarball returned HTTP ${response.status}`);
  }
  if (response.status >= 400) {
    throw new MysecondError(1, `/plugin-tarball failed (HTTP ${response.status})`);
  }
  const meta = response.body as PluginTarballMeta;
  // Light shape validation — better to fail loudly than feed garbage to
  // downloadAndVerifyTarball.
  if (typeof meta?.signed_url !== 'string' || typeof meta?.sha256 !== 'string' || typeof meta?.version !== 'string') {
    throw new MysecondError(1, '/plugin-tarball returned malformed response (missing signed_url/sha256/version)');
  }
  return meta;
}

// RED-TEAM R2 P1-D: telemetry stub. PR 4c originally wired ZERO of the spec-
// mandated PostHog events (last_known_good_used, auth_thrash_detected,
// rollback_pause.hit, abandoned_at_step_N, env_var_conflict, etc.). When
// customer 23 emails "init failed", we'd have NO server-side evidence. This
// stub posts {event, properties} to /api/companion/telemetry as fire-and-
// forget — server can be a no-op initially. Failure is silently swallowed
// (telemetry must NEVER break the install flow).
//
// Wired sites in PR 4c (4 highest-value):
//   - mysecond.init.last_known_good_used  → step-9 fallback success
//   - mysecond.init.auth_thrash_detected   → step-9 circuit breaker trip
//   - mysecond.rollback_pause.hit          → companionFetch halt-header above
//   - mysecond.init.abandoned_at_step_N    → init-runner SIGINT handler
//
// More events land in v1.5.1 patch fold (env_var_conflict, env_proxy_detected,
// claude_md.unclosed_fence_detected, support.transport_question_asked).
export async function emitTelemetry(
  ctx: CommandContext,
  event: string,
  properties: Record<string, unknown> = {}
): Promise<void> {
  try {
    await companionFetch(ctx, '/api/companion/telemetry', {
      method: 'POST',
      body: { event, properties, ts: new Date().toISOString() },
      timeoutMs: 3_000, // short — never block install on telemetry
    });
  } catch {
    // Silently swallow. Telemetry failures must NEVER surface to the customer.
  }
}
