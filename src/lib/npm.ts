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
// Issue #34 layer (2026-05-26): the gate is now also the cadence for an
// upgrade-staleness probe. `fetchLatestNpmVersion` runs at most once per 24h
// (same gate as the dormant `npm update -g` hook) and the result lands in
// `lastKnownLatestNpmVersion`. `maybePrintUpgradeNag` reads that cache plus
// the running `__VERSION__` and writes one stderr line on session-start when
// the customer is behind. Independent 24h debounce on the prompt itself
// (`lastUpgradePromptAt`) keeps the nag from spamming.

import type { CommandContext } from './context.js';
import type { SyncState } from './sync-state.js';
import { writeSyncState } from './sync-state.js';

declare const __VERSION__: string;

export const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

// Registry probe timeout. 1s covers a healthy registry response in ~all
// conditions and bails fast on captive-portal / corp-proxy / DNS-fail
// scenarios. SessionStart hook has a UI timeout; 2s+ here is visibly slow.
export const REGISTRY_FETCH_TIMEOUT_MS = 1000;

const NPM_REGISTRY_LATEST_URL = 'https://registry.npmjs.org/@mysecond/cli/latest';

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

// ─── Issue #34: upgrade staleness probe + nag ──────────────────────────────

/**
 * Fetch the `latest` dist-tag version of `@mysecond/cli` from npm's public
 * registry. Returns `null` on any failure (network, timeout, malformed JSON,
 * non-200 status, OR a value that doesn't match `x.y.z`) — this is
 * best-effort; sync must never fail because the registry is unreachable.
 * Uses Node 20+ global `fetch` + `AbortSignal`; no subprocess, no auth
 * (public scope).
 *
 * The `x.y.z` validation defends the cache: if `latest` is ever pointed at
 * a prerelease (`1.5.0-beta.1`) or build-tagged version by mistake,
 * caching that string would silently disable the nag for every customer
 * (compareSemver returns 0 for non-conforming inputs). Bailing here lets
 * the next 24h-gated check re-try once the registry is corrected — codex
 * review pass, 2026-05-26.
 */
export async function fetchLatestNpmVersion(): Promise<string | null> {
  try {
    const response = await fetch(NPM_REGISTRY_LATEST_URL, {
      signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as { version?: unknown } | null;
    if (body === null || typeof body.version !== 'string') return null;
    if (!/^\d+\.\d+\.\d+$/.test(body.version)) return null;
    return body.version;
  } catch {
    return null;
  }
}

/**
 * Compare two `x.y.z` strings. Returns -1 if `a < b`, 1 if `a > b`, 0 if
 * equal OR if either input is malformed. Malformed = "not three integers
 * separated by dots" — we deliberately treat pre-release tags
 * (`1.4.10-rc.1`) as malformed because they're not on the `latest` dist-tag
 * today; bailing to 0 makes the nag silently disable in that case rather
 * than firing a false positive.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parsed = (s: string): [number, number, number] | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(s);
    if (m === null) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const pa = parsed(a);
  const pb = parsed(b);
  if (pa === null || pb === null) return 0;
  for (let i = 0; i < 3; i++) {
    const av = pa[i] as number;
    const bv = pb[i] as number;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

/**
 * Write one stderr line if the running CLI is behind the cached latest
 * version. Self-contained — takes `rootDir` and calls `writeSyncState`
 * itself so callers cannot accidentally lose the debounce stamp by
 * forgetting to persist.
 *
 * Skip conditions (any of):
 *   - `MYSECOND_NO_UPGRADE_NAG=1` set in env.
 *   - `state.lastKnownLatestNpmVersion` is null (no probe result yet).
 *   - `compareSemver(__VERSION__, latest) >= 0` — running CLI is at or
 *     ahead of cached latest.
 *   - `state.lastUpgradePromptAt` is within 24h of now.
 *
 * Writes to stderr regardless of `silent` — silent mode IS the Claude Code
 * SessionStart hook, which is precisely where the customer needs the
 * signal. The 24h debounce keeps it tolerable (one line per day max).
 */
export function maybePrintUpgradeNag(state: SyncState, rootDir: string): void {
  if (process.env.MYSECOND_NO_UPGRADE_NAG === '1') return;
  const latest = state.lastKnownLatestNpmVersion;
  if (latest === null || latest.length === 0) return;
  if (compareSemver(__VERSION__, latest) >= 0) return;

  if (state.lastUpgradePromptAt !== null) {
    const last = Date.parse(state.lastUpgradePromptAt);
    if (!Number.isNaN(last) && Date.now() - last < TWENTY_FOUR_HOURS_MS) return;
  }

  process.stderr.write(
    `mysecond: your CLI is ${__VERSION__} (latest ${latest}). ` +
      'Run `npx @mysecond/cli@latest init` to update. ' +
      'Set MYSECOND_NO_UPGRADE_NAG=1 to silence.\n'
  );

  // Persist BEFORE mutating in-memory state. If the write fails, the
  // customer sees the nag again tomorrow — annoying but never broken — and
  // the in-memory `state` stays consistent with disk truth. Without this
  // ordering, a downstream caller that re-reads `state.lastUpgradePromptAt`
  // could believe the prompt was stamped when disk says otherwise (codex
  // review pass, 2026-05-26).
  const stamp = new Date().toISOString();
  const persisted: SyncState = { ...state, lastUpgradePromptAt: stamp };
  try {
    writeSyncState(rootDir, persisted);
    state.lastUpgradePromptAt = stamp;
  } catch {
    // Best-effort persistence. Leave in-memory state unchanged. Never
    // fail sync because of the debounce stamp.
  }
}
