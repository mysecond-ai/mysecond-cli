import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../../src/lib/context.js';
import { markNpmUpdated, shouldRunNpmUpdate, TWENTY_FOUR_HOURS_MS } from '../../src/lib/npm.js';
import type { SyncState } from '../../src/lib/sync-state.js';

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    apiBase: 'https://app.mysecond.ai',
    apiKey: 'k',
    rootDir: '/proj',
    silent: false,
    dryRun: false,
    forceUpdate: false,
    strategy: 'cloud-wins',
    ...overrides,
  };
}

function state(lastNpmUpdateAt: string | null): SyncState {
  return {
    files: {},
    artifacts: {},
    lastSyncedAt: null,
    lastNpmUpdateAt,
  };
}

describe('shouldRunNpmUpdate', () => {
  it('runs on first sync (lastNpmUpdateAt = null)', () => {
    expect(shouldRunNpmUpdate(state(null), ctx())).toBe(true);
  });

  it('skips within the 24h window', () => {
    const recent = new Date(Date.now() - 1000).toISOString();
    expect(shouldRunNpmUpdate(state(recent), ctx())).toBe(false);
  });

  it('runs after the 24h window expires', () => {
    const old = new Date(Date.now() - TWENTY_FOUR_HOURS_MS - 1000).toISOString();
    expect(shouldRunNpmUpdate(state(old), ctx())).toBe(true);
  });

  it('--force-update bypasses the gate', () => {
    const recent = new Date(Date.now() - 1000).toISOString();
    expect(shouldRunNpmUpdate(state(recent), ctx({ forceUpdate: true }))).toBe(true);
  });

  it('treats unparseable timestamps as "should run"', () => {
    expect(shouldRunNpmUpdate(state('not-a-date'), ctx())).toBe(true);
  });
});

describe('markNpmUpdated', () => {
  it('writes a current ISO timestamp', () => {
    const s = state(null);
    const before = Date.now();
    markNpmUpdated(s);
    const after = Date.now();
    expect(s.lastNpmUpdateAt).not.toBeNull();
    const stored = Date.parse(s.lastNpmUpdateAt!);
    expect(stored).toBeGreaterThanOrEqual(before);
    expect(stored).toBeLessThanOrEqual(after);
  });
});
