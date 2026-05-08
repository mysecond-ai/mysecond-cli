// Integration test for Track T3 (Closure D2) — invited-PM team-join detection.
//
// What this test covers (the "did the env var actually land?" coverage):
//   - Solo customer (workspace_scope=solo) → no MYSECOND_TEAM_JOIN, no
//     MYSECOND_TEAM_* in creds.
//   - Team admin (workspace_scope=team, role=admin) → no MYSECOND_TEAM_JOIN
//     (admins run the admin welcome, not the invited-PM welcome). Team
//     binding lines also OMITTED for admins/HoPs — only invited PMs need the
//     hook (T1) team_id binding to short-circuit team-mode logic.
//   - Invited PM (workspace_scope=team, role=pm) → MYSECOND_TEAM_JOIN=true in
//     settings.json AND MYSECOND_TEAM_ID/MYSECOND_TEAM_SLUG in project-scoped
//     creds.
//   - Removal-from-team recovery: re-running with isTeamJoin=false after a
//     prior team-join run CLEARS MYSECOND_TEAM_JOIN from settings.json.
//
// Test strategy: drive step-5b and step-6 directly with hand-crafted
// `shared` state (no need to mock /whoami — that's covered by the unit
// test in tests/lib/api/whoami.test.ts). This isolates the side-effect
// behavior from network mocking complexity.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { step5b } from '../../src/lib/steps/step-5b.js';
import { step6 } from '../../src/lib/steps/step-6.js';
import { projectHash } from '../../src/lib/project-hash.js';
import type { CommandContext } from '../../src/lib/context.js';
import type { SyncState } from '../../src/lib/sync-state.js';
import type { StepContext } from '../../src/lib/steps/types.js';

const TEST_KEY = 'msd_test_team_join_token';
const TEAM_ID = 'team-uuid-acme-123';
const TEAM_SLUG = 'acme-product';

let originalHome: string;
let tmpRoot: string;
let projectDir: string;

function makeStepCtx(shared: StepContext['shared'] = {}): StepContext {
  const ctx: CommandContext = {
    apiBase: 'https://app.mysecond.ai',
    apiKey: TEST_KEY,
    rootDir: projectDir,
    silent: true, // suppress test output noise
    dryRun: false,
    forceUpdate: false,
    fix: false,
    strategy: 'prompt',
  };
  const state: SyncState = {
    initCompletedSteps: [],
    step9Auth401RetryCount: 0,
  } as SyncState;
  return { ctx, state, shared };
}

function readCreds(): string {
  const credsPath = join(
    tmpRoot,
    '.mysecond',
    'projects',
    projectHash(projectDir),
    'credentials'
  );
  if (!existsSync(credsPath)) return '';
  return readFileSync(credsPath, 'utf8');
}

function readSettings(): { env?: Record<string, string> } {
  const settingsPath = join(projectDir, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return {};
  return JSON.parse(readFileSync(settingsPath, 'utf8'));
}

beforeEach(() => {
  originalHome = process.env.HOME ?? homedir();
  tmpRoot = mkdtempSync(join(tmpdir(), 'cli-team-join-'));
  process.env.HOME = tmpRoot;

  projectDir = mkdtempSync(join(tmpdir(), 'cli-team-join-proj-'));
  // Required for step-6 (writes .claude/settings.json).
  mkdirSync(join(projectDir, '.claude'), { recursive: true });
});

afterEach(() => {
  process.env.HOME = originalHome;
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
  try {
    rmSync(projectDir, { recursive: true, force: true });
  } catch {}
});

describe('Track T3 — Solo customer (no team-join)', () => {
  it('omits MYSECOND_TEAM_JOIN from settings.json and team binding from creds', async () => {
    if (process.platform === 'win32') return; // step-5b skips on Windows
    const sctx = makeStepCtx({
      teamId: 'synthetic-solo-team',
      // No teamSlug, no role, isTeamJoin=false (the canonical Solo shape)
      isTeamJoin: false,
    });

    await step5b(sctx);
    await step6(sctx);

    const creds = readCreds();
    expect(creds).toContain(`COMPANION_API_KEY=${TEST_KEY}`);
    expect(creds).not.toContain('MYSECOND_TEAM_ID');
    expect(creds).not.toContain('MYSECOND_TEAM_SLUG');

    const settings = readSettings();
    expect(settings.env?.SLASH_COMMAND_TOOL_CHAR_BUDGET).toBe('20000');
    expect(settings.env?.MYSECOND_TEAM_JOIN).toBeUndefined();
  });

  it('isTeamJoin=undefined (whoami missing or pre-T2 server) is treated as Solo', async () => {
    if (process.platform === 'win32') return;
    const sctx = makeStepCtx({
      // shared.isTeamJoin intentionally not set — fallback path
    });

    await step5b(sctx);
    await step6(sctx);

    expect(readCreds()).not.toContain('MYSECOND_TEAM_ID');
    expect(readSettings().env?.MYSECOND_TEAM_JOIN).toBeUndefined();
  });
});

describe('Track T3 — team admin (workspace_scope=team, role=admin)', () => {
  it('omits MYSECOND_TEAM_JOIN (admins run admin welcome, not invited-PM welcome)', async () => {
    if (process.platform === 'win32') return;
    // step-15's applyWhoamiToShared computes isTeamJoin=false for admins/HoPs
    // even when team_id / team_slug / workspace_scope=team are set.
    const sctx = makeStepCtx({
      teamId: TEAM_ID,
      teamSlug: TEAM_SLUG,
      teamMembershipRole: 'admin',
      isTeamJoin: false, // <-- the contract from isTeamJoin()
    });

    await step5b(sctx);
    await step6(sctx);

    // Owners get plain creds (no team binding lines): the hook (T1) only
    // needs team_id binding to short-circuit team-mode logic for INVITED
    // PMs. Owners installing fresh use the existing Solo-like contract.
    const creds = readCreds();
    expect(creds).not.toContain('MYSECOND_TEAM_ID');
    expect(creds).not.toContain('MYSECOND_TEAM_SLUG');

    expect(readSettings().env?.MYSECOND_TEAM_JOIN).toBeUndefined();
  });
});

describe('Track T3 — invited PM (workspace_scope=team, role=pm)', () => {
  it('writes MYSECOND_TEAM_JOIN=true to settings.json and binds team_id/team_slug into creds', async () => {
    if (process.platform === 'win32') return;
    const sctx = makeStepCtx({
      teamId: TEAM_ID,
      teamSlug: TEAM_SLUG,
      teamMembershipRole: 'pm',
      isTeamJoin: true,
    });

    await step5b(sctx);
    await step6(sctx);

    // Project-scoped creds carry the binding (P1 Codex requirement — hook
    // verifies team-mode binding from this file rather than inferring).
    const creds = readCreds();
    expect(creds).toContain(`COMPANION_API_KEY=${TEST_KEY}`);
    expect(creds).toContain(`MYSECOND_TEAM_ID=${TEAM_ID}`);
    expect(creds).toContain(`MYSECOND_TEAM_SLUG=${TEAM_SLUG}`);

    // settings.json carries the env-var contract with T4's welcome skill.
    const settings = readSettings();
    expect(settings.env?.MYSECOND_TEAM_JOIN).toBe('true');
    // Co-existence: existing legacy key must still be present.
    expect(settings.env?.SLASH_COMMAND_TOOL_CHAR_BUDGET).toBe('20000');
  });

  it('writes the team binding even when team_slug is missing (graceful pre-T2 fallback)', async () => {
    if (process.platform === 'win32') return;
    // If T2 ships team_membership_role + workspace_scope but not team_slug
    // for some reason, we still bind team_id (the load-bearing field) and
    // skip the slug line cleanly.
    const sctx = makeStepCtx({
      teamId: TEAM_ID,
      teamMembershipRole: 'pm',
      isTeamJoin: true,
    });

    await step5b(sctx);

    const creds = readCreds();
    expect(creds).toContain(`MYSECOND_TEAM_ID=${TEAM_ID}`);
    expect(creds).not.toContain('MYSECOND_TEAM_SLUG');
  });
});

describe('Track T3 — removed-from-team recovery (idempotent flag clear)', () => {
  it('clears MYSECOND_TEAM_JOIN when re-run with isTeamJoin=false', async () => {
    if (process.platform === 'win32') return;

    // First run: invited-PM state lands the env var.
    await step6(
      makeStepCtx({
        teamId: TEAM_ID,
        teamSlug: TEAM_SLUG,
        teamMembershipRole: 'pm',
        isTeamJoin: true,
      })
    );
    expect(readSettings().env?.MYSECOND_TEAM_JOIN).toBe('true');

    // Customer is removed from the team. Next init re-run sees
    // workspace_scope=solo (or 401 → fallback) → isTeamJoin=false. The
    // stale flag must drop or the customer is stuck in team-mode welcome
    // forever even though they're no longer on the team.
    await step6(makeStepCtx({ isTeamJoin: false }));

    expect(readSettings().env?.MYSECOND_TEAM_JOIN).toBeUndefined();
    // Legacy key untouched — we only mutate the team-join flag.
    expect(readSettings().env?.SLASH_COMMAND_TOOL_CHAR_BUDGET).toBe('20000');
  });

  it('preserves customer-authored SLASH_COMMAND_TOOL_CHAR_BUDGET while still writing TEAM_JOIN', async () => {
    if (process.platform === 'win32') return;
    // Pre-existing settings.json with a customer-authored override.
    const settingsPath = join(projectDir, '.claude', 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({ env: { SLASH_COMMAND_TOOL_CHAR_BUDGET: '40000' } }, null, 2) + '\n'
    );

    await step6(
      makeStepCtx({
        teamId: TEAM_ID,
        teamSlug: TEAM_SLUG,
        teamMembershipRole: 'pm',
        isTeamJoin: true,
      })
    );

    const settings = readSettings();
    // Customer-wins on the legacy key (Spec §6.3a).
    expect(settings.env?.SLASH_COMMAND_TOOL_CHAR_BUDGET).toBe('40000');
    // Team-join flag still landed — it's a separate, system-namespaced flag.
    expect(settings.env?.MYSECOND_TEAM_JOIN).toBe('true');
  });
});
