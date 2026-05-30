import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isPluginContractBehind,
  resolvePluginRefreshNudge,
  TWENTY_FOUR_HOURS_MS,
} from '../../src/lib/plugin-refresh-nag.js';
import { readSyncState, writeSyncState, type SyncState } from '../../src/lib/sync-state.js';

// Structurally-complete SyncState (mirrors npm.test.ts's nagState) so reads of
// other fields never get undefined.
function mkState(overrides: Partial<SyncState> = {}): SyncState {
  return {
    files: {},
    artifacts: {},
    contextFiles: {},
    lastSyncedAt: null,
    lastNpmUpdateAt: null,
    initCompletedSteps: [],
    step9Auth401RetryCount: 0,
    customerId: null,
    workspaceScope: null,
    customerSlug: null,
    lastKnownLatestNpmVersion: null,
    lastUpgradePromptAt: null,
    lastClaudeBinPath: null,
    installedPluginVersion: null,
    installedPluginContractVersion: null,
    lastPluginRefreshPromptAt: null,
    ...overrides,
  };
}

describe('isPluginContractBehind', () => {
  it('null/empty latest (old app) → false', () => {
    expect(isPluginContractBehind('1', null)).toBe(false);
    expect(isPluginContractBehind('1', undefined)).toBe(false);
    expect(isPluginContractBehind('1', '')).toBe(false);
  });

  it('null installed (pre-feature) → true when latest is a valid positive int', () => {
    expect(isPluginContractBehind(null, '1')).toBe(true);
  });

  it('fail-closed for a null install when latest is malformed (Codex review)', () => {
    expect(isPluginContractBehind(null, 'abc')).toBe(false);
    expect(isPluginContractBehind(null, '0')).toBe(false);
    expect(isPluginContractBehind(null, '-1')).toBe(false);
    expect(isPluginContractBehind(null, '1.5')).toBe(false);
  });

  it('fail-closed on non-string inputs — JSON/sync-state can lie at runtime (Codex review)', () => {
    expect(isPluginContractBehind(null, 2 as unknown as string)).toBe(false);
    expect(isPluginContractBehind('1', 2 as unknown as string)).toBe(false);
    expect(isPluginContractBehind(2 as unknown as string, '3')).toBe(false);
  });

  it('installed < latest → true', () => {
    expect(isPluginContractBehind('1', '2')).toBe(true);
  });

  it('installed == latest → false', () => {
    expect(isPluginContractBehind('2', '2')).toBe(false);
  });

  it('installed > latest → false (post-refresh / pinned ahead)', () => {
    expect(isPluginContractBehind('3', '2')).toBe(false);
  });

  it('fail-closed on decimal / non-numeric / non-positive', () => {
    expect(isPluginContractBehind('1.5', '2')).toBe(false);
    expect(isPluginContractBehind('abc', '2')).toBe(false);
    expect(isPluginContractBehind('1', 'abc')).toBe(false);
    expect(isPluginContractBehind('0', '2')).toBe(false);
    expect(isPluginContractBehind('-1', '2')).toBe(false);
  });
});

describe('resolvePluginRefreshNudge', () => {
  let tmpRoot: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'mysecond-prnag-'));
    savedEnv = process.env.MYSECOND_NO_UPGRADE_NAG;
    delete process.env.MYSECOND_NO_UPGRADE_NAG;
    delete process.env.MYSECOND_FORCE_REFRESH_NUDGE;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.MYSECOND_NO_UPGRADE_NAG;
    else process.env.MYSECOND_NO_UPGRADE_NAG = savedEnv;
    delete process.env.MYSECOND_FORCE_REFRESH_NUDGE;
  });

  it('returns null when not behind (installed == latest)', () => {
    const s = mkState({ installedPluginContractVersion: '1' });
    expect(resolvePluginRefreshNudge(s, tmpRoot, '1')).toBeNull();
    expect(s.lastPluginRefreshPromptAt).toBeNull();
  });

  it('returns null when latest is null (old app)', () => {
    const s = mkState({ installedPluginContractVersion: '1' });
    expect(resolvePluginRefreshNudge(s, tmpRoot, null)).toBeNull();
  });

  it('returns the user-facing nudge text when behind (no trailing newline — it is a JSON systemMessage value)', () => {
    const s = mkState({ installedPluginContractVersion: '1' });
    const msg = resolvePluginRefreshNudge(s, tmpRoot, '2');
    expect(msg).not.toBeNull();
    expect(msg).toContain('an update to your PM OS is ready');
    expect(msg).toContain('plugin-refresh --force-update');
    expect(msg).toContain('start a new session');
    expect(msg!.endsWith('\n')).toBe(false);
  });

  it('returns the nudge for a null-installed (pre-feature cohort) customer', () => {
    const s = mkState({ installedPluginContractVersion: null });
    expect(resolvePluginRefreshNudge(s, tmpRoot, '1')).toContain('an update to your PM OS is ready');
  });

  it('stamps lastPluginRefreshPromptAt and persists to disk when it shows', () => {
    const s = mkState({ installedPluginContractVersion: '1' });
    writeSyncState(tmpRoot, s);
    expect(resolvePluginRefreshNudge(s, tmpRoot, '2')).not.toBeNull();
    expect(s.lastPluginRefreshPromptAt).not.toBeNull();
    expect(readSyncState(tmpRoot).lastPluginRefreshPromptAt).toBe(s.lastPluginRefreshPromptAt);
  });

  it('honors MYSECOND_NO_UPGRADE_NAG=1', () => {
    process.env.MYSECOND_NO_UPGRADE_NAG = '1';
    const s = mkState({ installedPluginContractVersion: '1' });
    expect(resolvePluginRefreshNudge(s, tmpRoot, '2')).toBeNull();
    expect(s.lastPluginRefreshPromptAt).toBeNull();
  });

  it('debounces within 24h', () => {
    const recent = new Date(Date.now() - 1000).toISOString();
    const s = mkState({ installedPluginContractVersion: '1', lastPluginRefreshPromptAt: recent });
    expect(resolvePluginRefreshNudge(s, tmpRoot, '2')).toBeNull();
  });

  it('re-emits after the 24h debounce expires', () => {
    const old = new Date(Date.now() - TWENTY_FOUR_HOURS_MS - 1000).toISOString();
    const s = mkState({ installedPluginContractVersion: '1', lastPluginRefreshPromptAt: old });
    expect(resolvePluginRefreshNudge(s, tmpRoot, '2')).toContain('an update to your PM OS is ready');
  });

  it('still returns the nudge but leaves in-memory state untouched when disk persist fails', () => {
    const blockedRoot = join(tmpRoot, 'blocked');
    writeFileSync(blockedRoot, 'not-a-directory');
    const s = mkState({ installedPluginContractVersion: '1' });
    expect(resolvePluginRefreshNudge(s, blockedRoot, '2')).toContain('an update to your PM OS is ready');
    expect(s.lastPluginRefreshPromptAt).toBeNull();
  });

  // Test affordance: MYSECOND_FORCE_REFRESH_NUDGE=1 returns the nudge on demand —
  // no 24h wait, no contrived versions — so we can SEE it render in a real session.
  it('MYSECOND_FORCE_REFRESH_NUDGE=1 returns the nudge even when NOT behind, without persisting the stamp', () => {
    process.env.MYSECOND_FORCE_REFRESH_NUDGE = '1';
    const s = mkState({ installedPluginContractVersion: '2' }); // not behind
    expect(resolvePluginRefreshNudge(s, tmpRoot, '2')).toContain('an update to your PM OS is ready');
    expect(s.lastPluginRefreshPromptAt).toBeNull();
  });

  it('MYSECOND_FORCE_REFRESH_NUDGE=1 returns the nudge even with null latest and inside the 24h debounce', () => {
    process.env.MYSECOND_FORCE_REFRESH_NUDGE = '1';
    const recent = new Date(Date.now() - 1000).toISOString();
    const s = mkState({ installedPluginContractVersion: '1', lastPluginRefreshPromptAt: recent });
    expect(resolvePluginRefreshNudge(s, tmpRoot, null)).toContain('an update to your PM OS is ready');
  });
});
