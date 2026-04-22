// 24-hour npm-update timebox per EDD §5.3.
//
// `mysecond sync --silent` runs on every Claude Code SessionStart — could be
// dozens of times per day per customer. Running `npm update -g @mysecond/...`
// every time would flood GitHub Packages, slow session start by 3-10s, and
// trigger "why is Claude Code so slow to start?" complaints.
//
// Rule: cache lastNpmUpdateAt in .claude/sync-state.json. Skip the update if
// less than 24h has passed. `--force-update` bypasses the gate.
//
// PR 4b ships the gate logic + the structured wrapper for the future
// `npm update` invocation. Actual `execa('npm', ...)` + 401 retry per EDD §5.4
// lands when the customer plugin slug is known to the CLI (post-PR-4c, since
// only `mysecond init` provisions the slug into local state). For now the
// timebox is honored as a no-op placeholder so the gate is exercised by tests.

import type { CommandContext } from './context.js';
import type { SyncState } from './sync-state.js';

export const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export function shouldRunNpmUpdate(state: SyncState, ctx: CommandContext): boolean {
  if (ctx.forceUpdate) return true;
  if (state.lastNpmUpdateAt === null) return true;
  const last = Date.parse(state.lastNpmUpdateAt);
  if (Number.isNaN(last)) return true;
  return Date.now() - last >= TWENTY_FOUR_HOURS_MS;
}

export function markNpmUpdated(state: SyncState): void {
  state.lastNpmUpdateAt = new Date().toISOString();
}
