// Shared whoami client.
//
// Track T3 (Closure D2) — invited-PM team-join detection. Centralizes the
// /api/companion/whoami round-trip that step-15 used to handle inline. By
// moving it here we get:
//   1. A typed contract surface (`WhoamiResponse`) the rest of the CLI
//      can lean on without re-parsing fields ad-hoc.
//   2. A single network/timeout policy (10s, AbortSignal.timeout) shared
//      with future callers (e.g., `mysecond doctor` already pings whoami;
//      future callers should reuse this client instead of re-rolling fetch).
//   3. Test-only seam — `tests/lib/api/whoami.test.ts` mocks `globalThis.fetch`
//      against this single function rather than digging into step-15 internals.
//
// CONTRACT: server may return any of three shapes.
//   - Solo customer: `{email, team_id, user_id, scopes, workspace_scope: "solo"}`
//   - Team owner:   `{email, team_id, ..., workspace_scope: "team", team_slug, team_membership_role: "owner"}`
//   - Invited PM:   `{email, team_id, ..., workspace_scope: "team", team_slug, team_membership_role: "pm" | "admin"}`
//
// `team_slug`, `team_membership_role`, and `workspace_scope` may be missing
// while T2 hasn't shipped the server-side endpoint extension yet. In that
// case all three default to null and the caller's team-join branch becomes
// a safe no-op (Solo welcome runs — explicit fallback per the canonical
// plan section D2). Do NOT throw on missing fields; that would lock invited
// PMs out of install while T2 is still shipping.
//
// FAILURE SEMANTICS:
//   - 200 OK with valid JSON → { ok: true, ...fields }
//   - non-200                → { ok: false, ...nulls }      (caller clears creds, re-auths)
//   - network timeout / DNS  → { ok: true, networkError: true, ...nulls }
//                              Trust existing key (preserves prior step-15 behavior).
//                              isTeamJoin will be false; degrades to Solo welcome.
//   - JSON parse failure     → { ok: true, ...nulls }       (treat as Solo, don't lock out)
//
// The slightly-counterintuitive "networkError" path returns ok:true on
// purpose: callers want to keep the existing apiKey trusted on transient
// blips. It's the same trade step-15's prior fetchWhoami made — codified
// here so any future caller inherits it.

declare const __VERSION__: string;

const WHOAMI_TIMEOUT_MS = 10_000;

export type TeamMembershipRole = 'owner' | 'admin' | 'pm';
export type WorkspaceScope = 'solo' | 'team';

export interface WhoamiResponse {
  /**
   * `true` whenever the caller should trust the current credential.
   * - 200 → true
   * - 4xx/5xx → false (caller should clear key + re-auth)
   * - network error / timeout → true with `networkError: true`
   *   (don't lock out the customer on transient failures)
   */
  ok: boolean;
  /** Set on transient failures so callers can degrade copy / skip writes. */
  networkError?: boolean;
  /** User email. `null` on legacy api-key tokens or pre-T2 server. */
  email: string | null;
  /** Team UUID. `null` only on hard server errors. */
  team_id: string | null;
  /** Team slug. `null` until T2 ships the whoami extension. */
  team_slug: string | null;
  /** User UUID. `null` on legacy api-key tokens. */
  user_id: string | null;
  /**
   * Membership role for the calling user inside `team_id`. `null` until T2
   * ships. Used by Track T3's team-join detection: any non-null role other
   * than `owner` ⇒ invited PM.
   */
  team_membership_role: TeamMembershipRole | null;
  /**
   * `solo` (single-member synthetic team) or `team` (multi-PM team). `null`
   * until T2 ships the whoami extension. Mirrors the `plugin.tier` value
   * also returned by `/api/companion/install-ready` so callers don't need
   * a second round-trip.
   */
  workspace_scope: WorkspaceScope | null;
  /** OAuth-style scope strings. Echoed for debugging; not currently consumed. */
  scopes: readonly string[];
}

/**
 * Detection rule for invited-PM team-join. Centralized here so step-5b /
 * step-6 / step-13 share one source of truth.
 *
 * Returns `true` iff:
 *   - workspace_scope === "team"  (the calling team is on the Team tier)
 *   - team_membership_role is non-null AND not "owner"
 *
 * Owners get the Solo-style welcome (they are the team admin who set
 * everything up). Solo customers and pre-T2 missing-field responses both
 * return `false` — safe-degrade fallback per canonical plan section D2.
 */
export function isTeamJoin(w: WhoamiResponse): boolean {
  if (!w.ok) return false;
  if (w.workspace_scope !== 'team') return false;
  if (w.team_membership_role === null) return false;
  return w.team_membership_role !== 'owner';
}

function nullsResponse(overrides: Partial<WhoamiResponse> = {}): WhoamiResponse {
  return {
    ok: false,
    email: null,
    team_id: null,
    team_slug: null,
    user_id: null,
    team_membership_role: null,
    workspace_scope: null,
    scopes: [],
    ...overrides,
  };
}

function coerceRole(value: unknown): TeamMembershipRole | null {
  if (value === 'owner' || value === 'admin' || value === 'pm') return value;
  return null;
}

function coerceScope(value: unknown): WorkspaceScope | null {
  if (value === 'solo' || value === 'team') return value;
  return null;
}

function coerceString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function coerceScopes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

interface MinimalCtx {
  apiBase: string;
  apiKey: string;
}

/**
 * Probe `/api/companion/whoami` with the current bearer token.
 *
 * Caller responsibility: handle the three failure semantics documented at
 * the top of this file. Specifically: a `false` ok value means "clear key,
 * re-authenticate"; an `ok: true, networkError: true` means "trust the
 * current key, just don't act on team fields".
 */
export async function fetchWhoami(ctx: MinimalCtx): Promise<WhoamiResponse> {
  let url: URL;
  try {
    url = new URL('/api/companion/whoami', ctx.apiBase);
  } catch {
    // Malformed apiBase — extremely defensive, but means we can't even build
    // the request. Treat as transient/unknown so caller doesn't clear the key.
    return nullsResponse({ ok: true, networkError: true });
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        authorization: `Bearer ${ctx.apiKey}`,
        'user-agent': `mysecond-cli/${typeof __VERSION__ === 'string' ? __VERSION__ : 'dev'} (${process.platform}; node-${process.versions.node})`,
      },
      signal: AbortSignal.timeout(WHOAMI_TIMEOUT_MS),
    });
  } catch {
    // Network error / timeout — trust the existing key (preserves the
    // prior step-15 behavior). Email + team unknown; downstream copy
    // falls back to generic.
    return nullsResponse({ ok: true, networkError: true });
  }

  if (response.status !== 200) {
    return nullsResponse({ ok: false });
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    // Body wasn't JSON — server bug or proxy-mangled response. Treat as
    // ok-but-empty rather than clearing the key.
    return nullsResponse({ ok: true });
  }

  if (parsed === null || typeof parsed !== 'object') {
    return nullsResponse({ ok: true });
  }

  const body = parsed as Record<string, unknown>;
  return {
    ok: true,
    email: coerceString(body.email),
    team_id: coerceString(body.team_id),
    team_slug: coerceString(body.team_slug),
    user_id: coerceString(body.user_id),
    team_membership_role: coerceRole(body.team_membership_role),
    workspace_scope: coerceScope(body.workspace_scope),
    scopes: coerceScopes(body.scopes),
  };
}
