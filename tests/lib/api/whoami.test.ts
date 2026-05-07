// Unit tests for the shared whoami client (Track T3 / Closure D2).
//
// These tests cover the six failure / success modes the client must
// distinguish between so step-15, step-5b, and step-6 can rely on the
// `ok` + `networkError` semantics. The integration-level "does the env
// var actually land in settings.json" coverage lives in
// tests/integration/team-join.test.ts; here we just exercise the
// fetch wrapper.
//
// Mocking strategy: stub `globalThis.fetch` per-test. AbortSignal.timeout
// is not stubbed because vitest's default fake-timer-off mode preserves
// real timers; tests that need to exercise the timeout path simulate the
// rejection directly (cleaner than racing the 10s real timeout).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchWhoami, isTeamJoin, type WhoamiResponse } from '../../../src/lib/api/whoami.js';

const CTX = { apiBase: 'https://app.mysecond.ai', apiKey: 'msd_test_token' };

function jsonResponse(body: unknown, status = 200): Response {
  // Minimal Response shim — `fetch` callers only inspect status + json().
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchWhoami — server response shapes', () => {
  it('200 with full team-mode payload populates every field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        email: 'alice@acme.com',
        team_id: 'team-uuid-123',
        team_slug: 'acme-product',
        user_id: 'user-uuid-456',
        team_membership_role: 'pm',
        workspace_scope: 'team',
        scopes: ['read', 'write'],
      })
    );

    const result = await fetchWhoami(CTX);

    expect(result.ok).toBe(true);
    expect(result.networkError).toBeUndefined();
    expect(result.email).toBe('alice@acme.com');
    expect(result.team_id).toBe('team-uuid-123');
    expect(result.team_slug).toBe('acme-product');
    expect(result.user_id).toBe('user-uuid-456');
    expect(result.team_membership_role).toBe('pm');
    expect(result.workspace_scope).toBe('team');
    expect(result.scopes).toEqual(['read', 'write']);
  });

  it('200 with Solo payload: workspace_scope=solo, role=null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        email: 'solo@example.com',
        team_id: 'synthetic-team-uuid',
        user_id: 'user-uuid',
        scopes: [],
        workspace_scope: 'solo',
        // team_membership_role intentionally absent — Solo has no membership concept
      })
    );

    const result = await fetchWhoami(CTX);

    expect(result.ok).toBe(true);
    expect(result.workspace_scope).toBe('solo');
    expect(result.team_membership_role).toBeNull();
    expect(result.team_slug).toBeNull();
    expect(isTeamJoin(result)).toBe(false);
  });

  it('200 with pre-T2 minimal payload (missing team_slug / role / workspace_scope)', async () => {
    // Fallback behavior while T2's whoami extension hasn't shipped yet.
    // Client must not throw or null out email / team_id; just leave the
    // missing fields as null and let isTeamJoin return false.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        email: 'pm@team.com',
        team_id: 'team-uuid',
        user_id: 'user-uuid',
        scopes: [],
      })
    );

    const result = await fetchWhoami(CTX);

    expect(result.ok).toBe(true);
    expect(result.email).toBe('pm@team.com');
    expect(result.team_id).toBe('team-uuid');
    expect(result.team_slug).toBeNull();
    expect(result.team_membership_role).toBeNull();
    expect(result.workspace_scope).toBeNull();
    expect(isTeamJoin(result)).toBe(false);
  });

  it('coerces unrecognized role values to null instead of trusting them', async () => {
    // Defense against future server-side role expansions: if the server
    // adds a role like `viewer`, the CLI must default to "not invited PM"
    // rather than treating an unknown role as a team-join. The plan
    // explicitly calls this out as a risk.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        email: 'pm@team.com',
        team_id: 'team-uuid',
        team_membership_role: 'viewer', // not in the v1 enum
        workspace_scope: 'team',
        scopes: [],
      })
    );

    const result = await fetchWhoami(CTX);

    expect(result.team_membership_role).toBeNull();
    expect(isTeamJoin(result)).toBe(false);
  });

  it('coerces unrecognized workspace_scope values to null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        email: 'pm@team.com',
        team_id: 'team-uuid',
        team_membership_role: 'pm',
        workspace_scope: 'enterprise', // not in the v1 enum
        scopes: [],
      })
    );

    const result = await fetchWhoami(CTX);

    expect(result.workspace_scope).toBeNull();
    expect(isTeamJoin(result)).toBe(false);
  });
});

describe('fetchWhoami — failure modes', () => {
  it('401 → ok:false, all fields null (caller should clear key)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Unauthorized', { status: 401 })
    );

    const result = await fetchWhoami(CTX);

    expect(result.ok).toBe(false);
    expect(result.email).toBeNull();
    expect(result.team_id).toBeNull();
    expect(result.networkError).toBeUndefined();
  });

  it('500 → ok:false, all fields null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('boom', { status: 500 })
    );

    const result = await fetchWhoami(CTX);

    expect(result.ok).toBe(false);
    expect(result.email).toBeNull();
  });

  it('network error / timeout → ok:true with networkError:true (trust existing key)', async () => {
    // Critical contract from step-15: a transient network failure must
    // NOT cause us to clear the customer's working credential. ok:true +
    // networkError:true tells callers "trust the apiKey, just don't act
    // on team fields".
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('timeout'), { name: 'TimeoutError' })
    );

    const result = await fetchWhoami(CTX);

    expect(result.ok).toBe(true);
    expect(result.networkError).toBe(true);
    expect(result.email).toBeNull();
    expect(result.team_id).toBeNull();
    expect(isTeamJoin(result)).toBe(false);
  });

  it('200 with non-JSON body → ok:true, all fields null (don\'t lock out)', async () => {
    // Server bug or proxy-mangled response. Treat as ok-but-empty rather
    // than clearing the key — same defensive default as networkError.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>oops</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    );

    const result = await fetchWhoami(CTX);

    expect(result.ok).toBe(true);
    expect(result.email).toBeNull();
    expect(isTeamJoin(result)).toBe(false);
  });

  it('200 with non-object JSON body → ok:true, all fields null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse('not-an-object'));

    const result = await fetchWhoami(CTX);

    expect(result.ok).toBe(true);
    expect(result.email).toBeNull();
  });
});

describe('isTeamJoin — detection rule', () => {
  function w(overrides: Partial<WhoamiResponse>): WhoamiResponse {
    return {
      ok: true,
      email: 'pm@team.com',
      team_id: 'team-uuid',
      team_slug: 'acme',
      user_id: 'user-uuid',
      team_membership_role: 'pm',
      is_invited_pm: true,
      workspace_scope: 'team',
      scopes: [],
      ...overrides,
    };
  }

  it('returns true for invited-PM (workspace_scope=team, is_invited_pm=true)', () => {
    expect(isTeamJoin(w({}))).toBe(true);
  });

  it('returns false for team admin (role=admin, is_invited_pm=false)', () => {
    expect(isTeamJoin(w({ team_membership_role: 'admin', is_invited_pm: false }))).toBe(false);
  });

  it('returns false for head_of_product (role=head_of_product, is_invited_pm=false)', () => {
    expect(isTeamJoin(w({ team_membership_role: 'head_of_product', is_invited_pm: false }))).toBe(false);
  });

  it('returns false for Solo (workspace_scope=solo)', () => {
    expect(isTeamJoin(w({ workspace_scope: 'solo', team_membership_role: null, is_invited_pm: false }))).toBe(false);
  });

  it('returns false when is_invited_pm is false (pre-T2 server response)', () => {
    expect(isTeamJoin(w({ is_invited_pm: false, team_membership_role: null }))).toBe(false);
  });

  it('returns false when workspace_scope is null (pre-T2 server response)', () => {
    expect(isTeamJoin(w({ workspace_scope: null, is_invited_pm: false }))).toBe(false);
  });

  it('returns false on whoami failure (ok:false)', () => {
    expect(isTeamJoin(w({ ok: false }))).toBe(false);
  });
});
