import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '../../src/lib/context.js';
import {
  compareSemver,
  fetchLatestNpmVersion,
  markNpmUpdated,
  maybePrintUpgradeNag,
  REGISTRY_FETCH_TIMEOUT_MS,
  shouldRunNpmUpdate,
  TWENTY_FOUR_HOURS_MS,
} from '../../src/lib/npm.js';
import { readSyncState, writeSyncState, type SyncState } from '../../src/lib/sync-state.js';

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
  // Structurally complete SyncState so future tests that read other
  // fields don't get `undefined` (CTO review pass, 2026-05-26).
  return {
    files: {},
    artifacts: {},
    contextFiles: {},
    lastSyncedAt: null,
    lastNpmUpdateAt,
    initCompletedSteps: [],
    step9Auth401RetryCount: 0,
    customerId: null,
    workspaceScope: null,
    customerSlug: null,
    lastKnownLatestNpmVersion: null,
    lastUpgradePromptAt: null,
  };
}

/** Fresh structurally-complete SyncState, for nag tests. */
function nagState(overrides: Partial<SyncState> = {}): SyncState {
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
    ...overrides,
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

// ─── Issue #34 — compareSemver ────────────────────────────────────────────

describe('compareSemver', () => {
  it('returns 0 for equal versions', () => {
    expect(compareSemver('1.4.11', '1.4.11')).toBe(0);
  });

  it('returns -1 when a is patch-behind b', () => {
    expect(compareSemver('1.4.10', '1.4.11')).toBe(-1);
  });

  it('returns -1 when a is minor-behind b', () => {
    expect(compareSemver('1.4.11', '1.5.0')).toBe(-1);
  });

  it('returns -1 when a is major-behind b', () => {
    expect(compareSemver('1.4.11', '2.0.0')).toBe(-1);
  });

  it('returns 1 when a is ahead of b', () => {
    expect(compareSemver('1.4.12', '1.4.11')).toBe(1);
  });

  it('returns 0 for any non-x.y.z input (pre-release, missing parts)', () => {
    // Deliberate bail-safe: malformed input disables the nag rather than
    // firing a false positive.
    expect(compareSemver('1.4.11-rc.1', '1.4.11')).toBe(0);
    expect(compareSemver('1.4', '1.4.11')).toBe(0);
    expect(compareSemver('1.4.11', '1.4')).toBe(0);
    expect(compareSemver('', '1.4.11')).toBe(0);
    expect(compareSemver('latest', '1.4.11')).toBe(0);
  });

  it('numeric (not lexicographic) compare on each segment', () => {
    expect(compareSemver('1.10.0', '1.9.99')).toBe(1);
    expect(compareSemver('0.0.10', '0.0.9')).toBe(1);
  });
});

// ─── Issue #34 — fetchLatestNpmVersion ────────────────────────────────────

describe('fetchLatestNpmVersion', () => {
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('returns the version on a 200 response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ version: '1.4.99' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    ) as unknown as typeof fetch;
    expect(await fetchLatestNpmVersion()).toBe('1.4.99');
  });

  it('returns null on a 500 response', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('', { status: 500 })
    ) as unknown as typeof fetch;
    expect(await fetchLatestNpmVersion()).toBeNull();
  });

  it('returns null on a 404 response', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('', { status: 404 })
    ) as unknown as typeof fetch;
    expect(await fetchLatestNpmVersion()).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('not json', { status: 200 })
    ) as unknown as typeof fetch;
    expect(await fetchLatestNpmVersion()).toBeNull();
  });

  it('returns null when version field is missing or non-string', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ name: '@mysecond/cli' }), { status: 200 })
    ) as unknown as typeof fetch;
    expect(await fetchLatestNpmVersion()).toBeNull();
  });

  it('returns null when fetch throws (network failure)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;
    expect(await fetchLatestNpmVersion()).toBeNull();
  });

  it('uses a bounded timeout', async () => {
    // Caller-side AbortSignal.timeout is wired; this asserts the constant
    // exists and is short enough for the SessionStart-hook context.
    expect(REGISTRY_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(2000);
    expect(REGISTRY_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(500);
  });

  it('returns null when fetch exceeds the timeout (AbortSignal triggers)', async () => {
    // Mock fetch that respects the abort signal: it rejects with a
    // DOMException when aborted, matching Node 20+ behavior. This proves
    // the function actually wires the AbortSignal.timeout, not just
    // names a constant. Codex review pass, 2026-05-26.
    globalThis.fetch = vi.fn(async (_url, init) => {
      const signal = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        if (signal !== undefined) {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }
        // Never resolve naturally; rely on the abort.
      });
    }) as unknown as typeof fetch;
    const start = Date.now();
    const result = await fetchLatestNpmVersion();
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    // Should abort within ~timeout + small overhead.
    expect(elapsed).toBeLessThan(REGISTRY_FETCH_TIMEOUT_MS + 500);
  }, 5000);

  it('rejects a successful response whose version is not x.y.z (poisoning guard)', async () => {
    // If npm registry ever returns a prerelease as `latest` (mistake or
    // ops accident), caching that string would silently disable the nag
    // for every older customer. We bail at fetch instead so the next
    // 24h-gated check can retry.
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ version: '1.5.0-beta.1' }), { status: 200 })
    ) as unknown as typeof fetch;
    expect(await fetchLatestNpmVersion()).toBeNull();

    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ version: '1.5.0+build.7' }), { status: 200 })
    ) as unknown as typeof fetch;
    expect(await fetchLatestNpmVersion()).toBeNull();

    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ version: 'latest' }), { status: 200 })
    ) as unknown as typeof fetch;
    expect(await fetchLatestNpmVersion()).toBeNull();

    // Sanity: the canonical x.y.z is still accepted.
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ version: '1.4.99' }), { status: 200 })
    ) as unknown as typeof fetch;
    expect(await fetchLatestNpmVersion()).toBe('1.4.99');
  });
});

// ─── Issue #34 — maybePrintUpgradeNag ─────────────────────────────────────

describe('maybePrintUpgradeNag', () => {
  let stderrBuf: string;
  let origWrite: typeof process.stderr.write;
  let tmpRoot: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    stderrBuf = '';
    origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown) = ((chunk: string | Uint8Array) => {
      stderrBuf += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    tmpRoot = mkdtempSync(join(tmpdir(), 'mysecond-nag-'));
    savedEnv = process.env.MYSECOND_NO_UPGRADE_NAG;
    delete process.env.MYSECOND_NO_UPGRADE_NAG;
  });

  afterEach(() => {
    process.stderr.write = origWrite;
    if (savedEnv === undefined) delete process.env.MYSECOND_NO_UPGRADE_NAG;
    else process.env.MYSECOND_NO_UPGRADE_NAG = savedEnv;
  });

  it('emits nothing when lastKnownLatestNpmVersion is null', () => {
    const s = nagState();
    maybePrintUpgradeNag(s, tmpRoot);
    expect(stderrBuf).toBe('');
    expect(s.lastUpgradePromptAt).toBeNull();
  });

  it('emits nothing when running CLI matches the latest', () => {
    // __VERSION__ at test time is package.json#version (vitest define).
    const pkgVersion = JSON.parse(readFileSync('./package.json', 'utf-8')).version as string;
    const s = nagState({ lastKnownLatestNpmVersion: pkgVersion });
    maybePrintUpgradeNag(s, tmpRoot);
    expect(stderrBuf).toBe('');
    expect(s.lastUpgradePromptAt).toBeNull();
  });

  it('emits one stderr line when running CLI is behind', () => {
    // 999.0.0 is unambiguously ahead of any real shipping version.
    const s = nagState({ lastKnownLatestNpmVersion: '999.0.0' });
    maybePrintUpgradeNag(s, tmpRoot);
    expect(stderrBuf).toContain('mysecond: your CLI is');
    expect(stderrBuf).toContain('(latest 999.0.0)');
    expect(stderrBuf).toContain('`npx @mysecond/cli@latest init`');
    expect(stderrBuf).toContain('MYSECOND_NO_UPGRADE_NAG=1');
    expect(stderrBuf.endsWith('\n')).toBe(true);
    // Exactly one line.
    expect(stderrBuf.split('\n').filter((l) => l.length > 0)).toHaveLength(1);
  });

  it('stamps lastUpgradePromptAt and persists sync-state to disk', () => {
    const s = nagState({ lastKnownLatestNpmVersion: '999.0.0' });
    // Seed an existing sync-state file so writeSyncState reads/writes
    // through projectPaths normally.
    writeSyncState(tmpRoot, s);
    maybePrintUpgradeNag(s, tmpRoot);
    expect(s.lastUpgradePromptAt).not.toBeNull();
    const persisted = readSyncState(tmpRoot);
    expect(persisted.lastUpgradePromptAt).toBe(s.lastUpgradePromptAt);
  });

  it('honors MYSECOND_NO_UPGRADE_NAG=1', () => {
    process.env.MYSECOND_NO_UPGRADE_NAG = '1';
    const s = nagState({ lastKnownLatestNpmVersion: '999.0.0' });
    maybePrintUpgradeNag(s, tmpRoot);
    expect(stderrBuf).toBe('');
    expect(s.lastUpgradePromptAt).toBeNull();
  });

  it('debounces within 24h (recent prompt = no re-emit)', () => {
    const recent = new Date(Date.now() - 1000).toISOString();
    const s = nagState({
      lastKnownLatestNpmVersion: '999.0.0',
      lastUpgradePromptAt: recent,
    });
    maybePrintUpgradeNag(s, tmpRoot);
    expect(stderrBuf).toBe('');
  });

  it('re-emits after the 24h debounce expires', () => {
    const old = new Date(Date.now() - TWENTY_FOUR_HOURS_MS - 1000).toISOString();
    const s = nagState({
      lastKnownLatestNpmVersion: '999.0.0',
      lastUpgradePromptAt: old,
    });
    maybePrintUpgradeNag(s, tmpRoot);
    expect(stderrBuf).toContain('mysecond: your CLI is');
  });

  it('treats an unparseable lastUpgradePromptAt as expired', () => {
    const s = nagState({
      lastKnownLatestNpmVersion: '999.0.0',
      lastUpgradePromptAt: 'not-a-date',
    });
    maybePrintUpgradeNag(s, tmpRoot);
    expect(stderrBuf).toContain('mysecond: your CLI is');
  });

  it('emits nothing when running CLI is AHEAD of cached latest (post-upgrade)', () => {
    // A customer upgraded past the cached latest version (e.g., manually
    // pinned to a newer tag). Treat as no-op.
    const s = nagState({ lastKnownLatestNpmVersion: '0.0.1' });
    maybePrintUpgradeNag(s, tmpRoot);
    expect(stderrBuf).toBe('');
  });

  it('leaves in-memory state untouched when disk persist fails (no truth split)', () => {
    // Codex review pass: if writeSyncState throws, the in-memory
    // lastUpgradePromptAt must stay null so disk and memory agree. Without
    // this, a downstream caller could re-read `state.lastUpgradePromptAt`
    // and believe the prompt was stamped while disk says otherwise.
    //
    // Force the persist to fail by passing a rootDir whose parent is a
    // file (not a directory) — `mkdirSync(dirname(path), recursive)`
    // inside writeSyncState will throw ENOTDIR.
    const blockedRoot = join(tmpRoot, 'blocked');
    // Write a file at the .claude path so mkdir fails when sync-state
    // tries to create .claude/sync-state.json inside it.
    writeFileSync(blockedRoot, 'not-a-directory');
    const s = nagState({ lastKnownLatestNpmVersion: '999.0.0' });
    maybePrintUpgradeNag(s, blockedRoot);
    // The stderr line still fires (best-effort persistence shouldn't
    // suppress the nag itself).
    expect(stderrBuf).toContain('mysecond: your CLI is');
    // But the in-memory stamp is NOT set, because disk failed.
    expect(s.lastUpgradePromptAt).toBeNull();
  });
});
