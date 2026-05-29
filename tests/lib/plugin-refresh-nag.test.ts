import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isPluginContractBehind,
  maybePrintPluginRefreshNudge,
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

describe('maybePrintPluginRefreshNudge', () => {
  let stdoutBuf: string;
  let origWrite: typeof process.stdout.write;
  let tmpRoot: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    // The nudge writes to STDOUT (not stderr): a SessionStart hook's stdout
    // becomes the model's session-start context, which it relays to the user —
    // stderr on exit 0 is silently dropped (sync.ts printSummary CAIO finding).
    stdoutBuf = '';
    origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = ((chunk: string | Uint8Array) => {
      stdoutBuf += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    tmpRoot = mkdtempSync(join(tmpdir(), 'mysecond-prnag-'));
    savedEnv = process.env.MYSECOND_NO_UPGRADE_NAG;
    delete process.env.MYSECOND_NO_UPGRADE_NAG;
    delete process.env.MYSECOND_FORCE_REFRESH_NUDGE;
  });

  afterEach(() => {
    process.stdout.write = origWrite;
    if (savedEnv === undefined) delete process.env.MYSECOND_NO_UPGRADE_NAG;
    else process.env.MYSECOND_NO_UPGRADE_NAG = savedEnv;
  });

  // Marker-based assertions: every nudge line starts with 'mySecond:', so an
  // incidental stdout write from the runner can't pollute the result.
  it('emits nothing when not behind (installed == latest)', () => {
    const s = mkState({ installedPluginContractVersion: '1' });
    maybePrintPluginRefreshNudge(s, tmpRoot, '1');
    expect(stdoutBuf).not.toContain('mySecond:');
    expect(s.lastPluginRefreshPromptAt).toBeNull();
  });

  it('emits nothing when latest is null (old app)', () => {
    const s = mkState({ installedPluginContractVersion: '1' });
    maybePrintPluginRefreshNudge(s, tmpRoot, null);
    expect(stdoutBuf).not.toContain('mySecond:');
  });

  it('emits one stdout line (session-start context) when behind', () => {
    const s = mkState({ installedPluginContractVersion: '1' });
    maybePrintPluginRefreshNudge(s, tmpRoot, '2');
    expect(stdoutBuf).toContain('an update to your PM OS is ready');
    expect(stdoutBuf).toContain('plugin-refresh --force-update');
    expect(stdoutBuf).toContain('start a new session');
    // Exactly one nudge line (count the 'mySecond:' marker).
    expect(stdoutBuf.split('mySecond:').length - 1).toBe(1);
  });

  it('nudges a null-installed (pre-feature cohort) customer', () => {
    const s = mkState({ installedPluginContractVersion: null });
    maybePrintPluginRefreshNudge(s, tmpRoot, '1');
    expect(stdoutBuf).toContain('an update to your PM OS is ready');
  });

  it('stamps lastPluginRefreshPromptAt and persists to disk', () => {
    const s = mkState({ installedPluginContractVersion: '1' });
    writeSyncState(tmpRoot, s);
    maybePrintPluginRefreshNudge(s, tmpRoot, '2');
    expect(s.lastPluginRefreshPromptAt).not.toBeNull();
    expect(readSyncState(tmpRoot).lastPluginRefreshPromptAt).toBe(s.lastPluginRefreshPromptAt);
  });

  it('honors MYSECOND_NO_UPGRADE_NAG=1', () => {
    process.env.MYSECOND_NO_UPGRADE_NAG = '1';
    const s = mkState({ installedPluginContractVersion: '1' });
    maybePrintPluginRefreshNudge(s, tmpRoot, '2');
    expect(stdoutBuf).not.toContain('mySecond:');
    expect(s.lastPluginRefreshPromptAt).toBeNull();
  });

  it('debounces within 24h', () => {
    const recent = new Date(Date.now() - 1000).toISOString();
    const s = mkState({ installedPluginContractVersion: '1', lastPluginRefreshPromptAt: recent });
    maybePrintPluginRefreshNudge(s, tmpRoot, '2');
    expect(stdoutBuf).not.toContain('mySecond:');
  });

  it('re-emits after the 24h debounce expires', () => {
    const old = new Date(Date.now() - TWENTY_FOUR_HOURS_MS - 1000).toISOString();
    const s = mkState({ installedPluginContractVersion: '1', lastPluginRefreshPromptAt: old });
    maybePrintPluginRefreshNudge(s, tmpRoot, '2');
    expect(stdoutBuf).toContain('an update to your PM OS is ready');
  });

  it('leaves in-memory state untouched when disk persist fails (no truth split)', () => {
    const blockedRoot = join(tmpRoot, 'blocked');
    writeFileSync(blockedRoot, 'not-a-directory');
    const s = mkState({ installedPluginContractVersion: '1' });
    maybePrintPluginRefreshNudge(s, blockedRoot, '2');
    expect(stdoutBuf).toContain('an update to your PM OS is ready');
    expect(s.lastPluginRefreshPromptAt).toBeNull();
  });

  // Test affordance: MYSECOND_FORCE_REFRESH_NUDGE=1 lets us SEE the nudge render
  // in a real session on demand — no 24h wait, no contrived versions.
  it('MYSECOND_FORCE_REFRESH_NUDGE=1 emits even when NOT behind, without persisting the debounce stamp', () => {
    process.env.MYSECOND_FORCE_REFRESH_NUDGE = '1';
    const s = mkState({ installedPluginContractVersion: '2' }); // not behind
    maybePrintPluginRefreshNudge(s, tmpRoot, '2');
    expect(stdoutBuf).toContain('an update to your PM OS is ready');
    // Forced trigger must not mutate the real 24h debounce state.
    expect(s.lastPluginRefreshPromptAt).toBeNull();
  });

  it('MYSECOND_FORCE_REFRESH_NUDGE=1 emits even with null latest and inside the 24h debounce', () => {
    process.env.MYSECOND_FORCE_REFRESH_NUDGE = '1';
    const recent = new Date(Date.now() - 1000).toISOString();
    const s = mkState({ installedPluginContractVersion: '1', lastPluginRefreshPromptAt: recent });
    maybePrintPluginRefreshNudge(s, tmpRoot, null);
    expect(stdoutBuf).toContain('an update to your PM OS is ready');
  });
});
