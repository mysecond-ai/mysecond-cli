// Step 6: Write `.claude/settings.json` env block.
//
// Two keys live here:
//   - SLASH_COMMAND_TOOL_CHAR_BUDGET=20000 (legacy — Spec §6.3a merge rules:
//     single-key update, preserve all other env entries verbatim, customer-
//     authored value wins on conflict).
//   - MYSECOND_TEAM_JOIN=true (Track T3, Closure D2) — set ONLY when step-15's
//     /whoami flagged this user as an invited PM joining an existing team
//     (workspace_scope === "team" AND server-computed is_invited_pm === true,
//     which is role === 'pm' — schema has no 'owner' role).
//     T4's welcome skill reads this to skip the Solo company/product/personas
//     extraction and run a personal-preferences flow instead.
//
// Idempotency invariants (CRITICAL — adversarial review item from plan §Risks):
//   - Adding a customer to a team: re-running init must SET MYSECOND_TEAM_JOIN=true.
//   - Removing a customer from a team: re-running init must CLEAR
//     MYSECOND_TEAM_JOIN. Otherwise stale env state strands the customer in
//     team-join welcome forever even after they're no longer on the team.
//   - Solo customer: never write MYSECOND_TEAM_JOIN at all — leaves the env
//     block clean for grep/audit.
// The flag presence is therefore a function of `shared.isTeamJoin === true`,
// not "set once and forget". This step always writes a new file when the
// merged shape differs from what's on disk, even when the legacy key was
// already present.

import { existsSync, readFileSync } from 'node:fs';

import { atomicWriteFile } from '../atomic-write.js';
import { projectPaths } from '../files.js';

import type { StepFn } from './types.js';

const ENV_KEY = 'SLASH_COMMAND_TOOL_CHAR_BUDGET';
const ENV_VALUE = '20000';
const TEAM_JOIN_KEY = 'MYSECOND_TEAM_JOIN';
const TEAM_JOIN_VALUE = 'true';

interface SettingsShape {
  env?: Record<string, string>;
  [key: string]: unknown;
}

function readSettings(path: string): SettingsShape {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, 'utf8');
    if (raw.trim().length === 0) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as SettingsShape;
  } catch {
    return {};
  }
}

export const step6: StepFn = async ({ ctx, shared }) => {
  const settingsPath = projectPaths(ctx.rootDir).syncStatePath.replace(
    /sync-state\.json$/,
    'settings.json'
  );

  const settings = readSettings(settingsPath);
  const env = { ...(settings.env ?? {}) };

  // ── SLASH_COMMAND_TOOL_CHAR_BUDGET (legacy: customer-wins on conflict) ──
  // Three sub-cases mirror the prior implementation:
  //   1. matching value → no change
  //   2. customer-authored different value → preserve, log, no change
  //   3. unset → write our default
  // Captured as a "did we change anything?" boolean below so the team-join
  // branch can decide whether the file needs a re-write.
  let changed = false;
  if (env[ENV_KEY] === undefined) {
    env[ENV_KEY] = ENV_VALUE;
    changed = true;
  } else if (env[ENV_KEY] !== ENV_VALUE) {
    // Customer-authored different value — preserve, log, continue.
    if (!ctx.silent) {
      process.stderr.write(
        `mysecond: noted .claude/settings.json env.${ENV_KEY}=${env[ENV_KEY]} (customer value preserved over our default ${ENV_VALUE})\n`
      );
    }
  }

  // ── MYSECOND_TEAM_JOIN (Track T3 — bidirectional) ──────────────────────
  // Set when invited-PM, clear otherwise. The "clear otherwise" branch
  // matters for membership-removal recovery: a PM removed from a team should
  // see their MYSECOND_TEAM_JOIN flag drop on the next init re-run so T4's
  // welcome skill stops treating them as team-mode.
  //
  // Caveat — customer-authored value collision: if a customer happens to set
  // MYSECOND_TEAM_JOIN themselves (extremely unlikely; private namespace),
  // we DO NOT preserve it. This is intentional — the env-var contract with
  // T4 is owned by the CLI, not the customer. A customer-authored value
  // would silently corrupt the welcome flow and is out of contract; the
  // canonical SLASH_COMMAND_TOOL_CHAR_BUDGET preserve-customer rule does
  // not extend to system-namespaced flags.
  if (shared.isTeamJoin === true) {
    if (env[TEAM_JOIN_KEY] !== TEAM_JOIN_VALUE) {
      env[TEAM_JOIN_KEY] = TEAM_JOIN_VALUE;
      changed = true;
    }
  } else if (TEAM_JOIN_KEY in env) {
    // Removed-from-team recovery path: drop the stale flag.
    delete env[TEAM_JOIN_KEY];
    changed = true;
  }

  if (!changed) {
    return { step: 6, outcome: { kind: 'completed' } };
  }

  const next: SettingsShape = { ...settings, env };
  atomicWriteFile(settingsPath, JSON.stringify(next, null, 2) + '\n', { mkdirRecursive: true });
  return { step: 6, outcome: { kind: 'completed' } };
};
