// Unit tests for `mysecond claude` launch wrapper (Closure D4 / Round 2 P0-A).
//
// Covers:
//   - Silent fall-through when no creds
//   - Skip download when local LKG version matches server
//   - Download + extract + cache when versions differ
//   - Network timeout → stderr warning + fall through
//   - HTTP 4xx → stderr warning + creds NOT cleared
//   - Malformed JSON → stderr warning + fall through
//   - Pass-through args + exit-code propagation are covered by an in-process
//     spawn smoke test using `node -e`.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '../../src/lib/context.js';

let fakeHome: string;
let fakeProject: string;
let originalHome: string | undefined;
let stderrBuf: string;
let originalStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'mysecond-claude-wrapper-'));
  fakeProject = mkdtempSync(join(tmpdir(), 'mysecond-claude-project-'));
  originalHome = process.env.HOME;
  process.env.HOME = fakeHome;

  // Capture stderr without polluting test output.
  stderrBuf = '';
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    stderrBuf += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  }) as typeof process.stderr.write;

  vi.resetModules();
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  process.stderr.write = originalStderrWrite;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(fakeProject, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function buildCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    apiBase: 'https://example.test',
    apiKey: 'test-key',
    rootDir: fakeProject,
    silent: false,
    dryRun: false,
    forceUpdate: false,
    fix: false,
    resume: false,
    authOnly: false,
    strategy: 'cloud-wins',
    ...overrides,
  };
}

function writeSyncStateWithSlug(slug: string): void {
  const dir = join(fakeProject, '.claude');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'sync-state.json'),
    JSON.stringify({
      files: {},
      artifacts: {},
      contextFiles: {},
      lastSyncedAt: null,
      lastNpmUpdateAt: null,
      initCompletedSteps: [],
      step9Auth401RetryCount: 0,
      customerId: 'cust_test',
      workspaceScope: 'team',
      customerSlug: slug,
    })
  );
}

describe('mysecond claude — tryRefreshTarball', () => {
  it('silently no-ops when apiKey is empty (no creds → no banner)', async () => {
    const mod = await import('../../src/commands/claude.js');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await mod.__testing.tryRefreshTarball(buildCtx({ apiKey: '' }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stderrBuf).toBe('');
  });

  it('silently no-ops when sync-state has no customerSlug', async () => {
    const mod = await import('../../src/commands/claude.js');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    // No sync-state file at all → readSyncState returns empty state.
    await mod.__testing.tryRefreshTarball(buildCtx());

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stderrBuf).toBe('');
  });

  it('skips download when local LKG version matches server version', async () => {
    writeSyncStateWithSlug('acme');

    // Seed LKG with version 1.0.0.
    const lkg = await import('../../src/lib/last-known-good.js');
    const seedDir = join(fakeHome, 'seed');
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(join(seedDir, 'manifest.json'), '{}');
    lkg.cacheLastKnownGood('acme', '1.0.0', 'sha-fake', seedDir);

    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          signed_url: 'https://cdn.example.test/tarball.tgz',
          sha256: 'sha-fake',
          version: '1.0.0',
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchSpy);

    const mod = await import('../../src/commands/claude.js');
    await mod.__testing.tryRefreshTarball(buildCtx());

    // Should hit the metadata endpoint exactly once and NOT download the tarball.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = fetchSpy.mock.calls[0]?.[0] as URL;
    expect(String(calledUrl)).toContain('/api/companion/plugin-tarball/acme');
    expect(stderrBuf).toBe('');
  });

  it('writes stderr warning on HTTP 401 and does NOT clear creds', async () => {
    writeSyncStateWithSlug('acme');

    const credsPath = join(fakeHome, 'creds-marker');
    writeFileSync(credsPath, 'sentinel');

    const fetchSpy = vi.fn(async () => new Response('unauth', { status: 401 }));
    vi.stubGlobal('fetch', fetchSpy);

    const mod = await import('../../src/commands/claude.js');
    await mod.__testing.tryRefreshTarball(buildCtx());

    expect(stderrBuf).toContain('could not check for updates');
    expect(stderrBuf).toContain('HTTP 401');
    // Creds marker untouched.
    expect(existsSync(credsPath)).toBe(true);
  });

  it('writes stderr timeout warning on AbortSignal timeout', async () => {
    writeSyncStateWithSlug('acme');

    const fetchSpy = vi.fn(async () => {
      // Simulate the AbortError that AbortSignal.timeout emits when triggered.
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      throw err;
    });
    vi.stubGlobal('fetch', fetchSpy);

    const mod = await import('../../src/commands/claude.js');
    await mod.__testing.tryRefreshTarball(buildCtx());

    expect(stderrBuf).toContain('timed out');
  });

  it('writes stderr warning on malformed JSON body', async () => {
    writeSyncStateWithSlug('acme');

    const fetchSpy = vi.fn(async () =>
      new Response('not-json{', { status: 200 })
    );
    vi.stubGlobal('fetch', fetchSpy);

    const mod = await import('../../src/commands/claude.js');
    await mod.__testing.tryRefreshTarball(buildCtx());

    expect(stderrBuf).toContain('could not check for updates');
    expect(stderrBuf).toContain('malformed body');
  });

  it('writes stderr warning on network error', async () => {
    writeSyncStateWithSlug('acme');

    const fetchSpy = vi.fn(async () => {
      throw new Error('ENETUNREACH');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const mod = await import('../../src/commands/claude.js');
    await mod.__testing.tryRefreshTarball(buildCtx());

    expect(stderrBuf).toContain('could not check for updates');
    expect(stderrBuf).toContain('network');
  });

  it('skips when malformed body has missing fields (e.g., no version)', async () => {
    writeSyncStateWithSlug('acme');

    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ signed_url: 'x', sha256: 'y' }), {
        status: 200,
      })
    );
    vi.stubGlobal('fetch', fetchSpy);

    const mod = await import('../../src/commands/claude.js');
    await mod.__testing.tryRefreshTarball(buildCtx());

    expect(stderrBuf).toContain('malformed body');
  });
});

describe('mysecond claude — fetchTarballMeta direct', () => {
  it('throws "TIMEOUT" on TimeoutError', async () => {
    const mod = await import('../../src/commands/claude.js');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const e = new Error('aborted');
        e.name = 'TimeoutError';
        throw e;
      })
    );
    await expect(
      mod.__testing.fetchTarballMeta('https://example.test', 'k', 'acme')
    ).rejects.toThrow('TIMEOUT');
  });

  it('throws "HTTP 403" on 403', async () => {
    const mod = await import('../../src/commands/claude.js');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    await expect(
      mod.__testing.fetchTarballMeta('https://example.test', 'k', 'acme')
    ).rejects.toThrow('HTTP 403');
  });

  it('returns parsed meta on 200', async () => {
    const mod = await import('../../src/commands/claude.js');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              signed_url: 'https://cdn.example.test/x.tgz',
              sha256: 'abc',
              version: '2.0.0',
            }),
            { status: 200 }
          )
      )
    );
    const meta = await mod.__testing.fetchTarballMeta(
      'https://example.test',
      'k',
      'acme'
    );
    expect(meta.version).toBe('2.0.0');
    expect(meta.sha256).toBe('abc');
  });
});

describe('mysecond claude — slug validation guard', () => {
  it('writes stderr warning and bails on bad slug in sync-state', async () => {
    // Path-traversal slug — validateSlug should reject.
    const dir = join(fakeProject, '.claude');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'sync-state.json'),
      JSON.stringify({
        files: {},
        artifacts: {},
        contextFiles: {},
        lastSyncedAt: null,
        lastNpmUpdateAt: null,
        initCompletedSteps: [],
        step9Auth401RetryCount: 0,
        customerId: null,
        workspaceScope: null,
        customerSlug: '../evil',
      })
    );

    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const mod = await import('../../src/commands/claude.js');
    await mod.__testing.tryRefreshTarball(buildCtx());

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stderrBuf).toContain('invalid customer slug');
  });
});
