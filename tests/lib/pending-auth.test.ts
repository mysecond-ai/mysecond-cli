// Tests for the v1.4.2 two-command auth flow's pending-auth state module.
// Covers: write+read round-trip, mode 0600 hardening, expiry detection,
// clear, and malformed-state handling.

import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearPendingAuth,
  isPendingAuthExpired,
  pendingAuthSecondsRemaining,
  readPendingAuth,
  writePendingAuth,
  type PendingAuthState,
} from '../../src/lib/pending-auth.js';
import { pendingAuthPath } from '../../src/lib/mysecond-paths.js';

describe('pending-auth state', () => {
  let prevHome: string | undefined;
  let projectDir: string;

  beforeEach(() => {
    prevHome = process.env.HOME;
    // Sandbox HOME so we don't pollute the real ~/.mysecond.
    const sandboxHome = mkdtempSync(join(tmpdir(), 'mysecond-pending-auth-'));
    process.env.HOME = sandboxHome;
    projectDir = mkdtempSync(join(tmpdir(), 'mysecond-project-'));
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
  });

  function sampleState(overrides: Partial<PendingAuthState> = {}): PendingAuthState {
    const minted = new Date('2026-05-05T12:00:00.000Z');
    const expires = new Date(minted.getTime() + 540_000); // +9 min
    return {
      device_code: 'dc-abc-123',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://app.mysecond.ai/device',
      expires_at: expires.toISOString(),
      interval_seconds: 5,
      slug: 'acme-x1',
      minted_at: minted.toISOString(),
      ...overrides,
    };
  }

  it('writes + reads round-trip', () => {
    const state = sampleState();
    writePendingAuth(projectDir, state);
    const read = readPendingAuth(projectDir);
    expect(read).toEqual(state);
  });

  it('persists at chmod 0600', () => {
    writePendingAuth(projectDir, sampleState());
    const path = pendingAuthPath(projectDir);
    const stat = statSync(path);
    // Mask off the file-type bits, only check perms.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('returns null for missing file', () => {
    expect(readPendingAuth(projectDir)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    const path = pendingAuthPath(projectDir);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{not json', { mode: 0o600 });
    expect(readPendingAuth(projectDir)).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    const path = pendingAuthPath(projectDir);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({ user_code: 'ABCD' }), { mode: 0o600 });
    expect(readPendingAuth(projectDir)).toBeNull();
  });

  it('clears the file (idempotent)', () => {
    writePendingAuth(projectDir, sampleState());
    expect(readPendingAuth(projectDir)).not.toBeNull();
    clearPendingAuth(projectDir);
    expect(readPendingAuth(projectDir)).toBeNull();
    // Second call should not throw.
    clearPendingAuth(projectDir);
  });

  it('detects expiry', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(isPendingAuthExpired(sampleState({ expires_at: past }))).toBe(true);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(isPendingAuthExpired(sampleState({ expires_at: future }))).toBe(false);
  });

  it('reports seconds remaining', () => {
    const future = new Date(Date.now() + 120_000).toISOString();
    const remaining = pendingAuthSecondsRemaining(sampleState({ expires_at: future }));
    expect(remaining).toBeGreaterThan(110);
    expect(remaining).toBeLessThanOrEqual(120);
  });

  it('reports 0 for expired state', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(pendingAuthSecondsRemaining(sampleState({ expires_at: past }))).toBe(0);
  });
});
