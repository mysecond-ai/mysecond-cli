// Plugin-refresh nudge — the "a plugin update is available, run plugin-refresh"
// notice printed once per SessionStart when the installed plugin's contract
// version is behind the latest the server returns. Mirrors npm.ts's
// maybePrintUpgradeNag 1:1 (the CLI-self-upgrade nag) but on a DIFFERENT axis:
// the plugin cache, not the CLI binary. See ~/.claude/plans/cryptic-puzzling-rainbow.md.

import type { SyncState } from './sync-state.js';
import { writeSyncState } from './sync-state.js';

export const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * Is the installed contract version behind the latest? Fail-CLOSED: any
 * ambiguity returns false (no nudge), so a malformed value never spams.
 *   - latest null/empty/malformed (old app, or bad new-app data) → false
 *   - installed null (pre-feature) AND latest valid → true (behind; the nudge
 *     itself is 24h-debounced, so it shows once/day until they refresh)
 *   - non-positive / non-integer / non-safe-integer either side → false
 */
export function isPluginContractBehind(
  installed: string | null,
  latest: string | null | undefined
): boolean {
  // Runtime type-guard (Codex review): `latest`/`installed` are typed as strings,
  // but they arrive from JSON (the cli-sync response) and sync-state.json with no
  // runtime validation. A non-string value (the app returns `2` not `'2'`, or a
  // corrupted state file) must fail closed — "any ambiguity returns false".
  if (typeof latest !== 'string' || latest.length === 0) return false;
  // Validate `latest` BEFORE the null-installed branch: a malformed latest from a
  // new app (e.g. 'abc', '0', '1.5') must fail closed — no nudge — even for a
  // pre-feature (installed === null) cohort install.
  const l = Number(latest);
  if (!Number.isSafeInteger(l) || l < 1) return false;
  if (installed === null) return true; // pre-feature install + valid latest → behind
  if (typeof installed !== 'string') return false; // corrupted sync-state → fail closed
  const i = Number(installed);
  if (!Number.isSafeInteger(i) || i < 1) return false;
  return i < l;
}

/**
 * Decide whether to show the plugin-refresh nudge; return its text if so, else
 * null. Self-persists the 24h debounce stamp (`lastPluginRefreshPromptAt`) when it
 * decides to show, and reuses `MYSECOND_NO_UPGRADE_NAG` as the single silence knob.
 *
 * Returns the text rather than printing it because the CALLER routes it to the
 * right channel. In the SessionStart hook (silent) it must go in the hook JSON's
 * TOP-LEVEL `systemMessage`, which Claude Code renders DIRECTLY to the user. Plain
 * stdout becomes `additionalContext` — a system reminder Claude reads but the user
 * never reliably sees (verified against the Claude Code hooks docs) — and stderr on
 * exit 0 is dropped outright. Two earlier cuts (stderr, then stdout) were therefore
 * invisible to customers. Separate debounce stamp from `lastUpgradePromptAt` (the
 * npm nag) so the two notices don't suppress each other.
 */
export function resolvePluginRefreshNudge(
  state: SyncState,
  rootDir: string,
  latestContractVersion: string | null | undefined
): string | null {
  // Test affordance: MYSECOND_FORCE_REFRESH_NUDGE=1 returns the nudge
  // UNCONDITIONALLY (skips the behind-check, the 24h debounce, and the silence
  // flag) and does NOT mutate the debounce stamp — so the nudge can be SEEN
  // rendering in a real Claude Code session on demand, without waiting 24h or
  // contriving versions. See TESTING.md "Verify the plugin-refresh nudge".
  const forced = process.env.MYSECOND_FORCE_REFRESH_NUDGE === '1';

  if (!forced) {
    if (process.env.MYSECOND_NO_UPGRADE_NAG === '1') return null;
    if (!isPluginContractBehind(state.installedPluginContractVersion, latestContractVersion)) {
      return null;
    }
    if (state.lastPluginRefreshPromptAt !== null) {
      const last = Date.parse(state.lastPluginRefreshPromptAt);
      if (!Number.isNaN(last) && Date.now() - last < TWENTY_FOUR_HOURS_MS) return null;
    }
  }

  // No trailing newline + no env-var hint: this is a JSON `systemMessage` value
  // (user-facing). We don't advertise MYSECOND_NO_UPGRADE_NAG (cleaner for
  // non-technical PMs; the nudge is 24h-debounced and stops once they refresh).
  const message =
    'mySecond: an update to your PM OS is ready. ' +
    'Paste this into Claude Code to update: ' +
    'npx -y @mysecond/cli@latest plugin-refresh --force-update ' +
    '— then start a new session.';

  // A forced (test) trigger must not touch the real 24h debounce state.
  if (!forced) {
    // Persist the debounce stamp: write a copy first, mutate in-memory only on
    // success, so disk + memory stay consistent if the write fails. Best-effort.
    const stamp = new Date().toISOString();
    const persisted: SyncState = { ...state, lastPluginRefreshPromptAt: stamp };
    try {
      writeSyncState(rootDir, persisted);
      state.lastPluginRefreshPromptAt = stamp;
    } catch {
      // Best-effort persistence. Leave in-memory state unchanged.
    }
  }

  return message;
}
