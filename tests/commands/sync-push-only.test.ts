// Tests for `mysecond sync --push-only` (runSync's pushOnly branch / runPushOnly).
//
// --push-only is the once-per-turn realtime push used by the Stop/SubagentStop
// hook. Unlike a full `sync` it must NEVER pull (no GET /cli-sync); unlike
// --push-all it is hash-gated (only CHANGED files push). It is best-effort:
// always exits 0, persists only the keys it actually pushed.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runSync } from '../../src/commands/sync.js';
import { shortHash } from '../../src/lib/files.js';
import type { CommandContext } from '../../src/lib/context.js';

function tmpProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'mysecond-push-only-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  return root;
}

function ctx(rootDir: string, overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    apiBase: 'https://app.mysecond.ai',
    apiKey: 'test-key',
    rootDir,
    silent: true,
    dryRun: false,
    forceUpdate: false,
    fix: false,
    resume: false,
    authOnly: false,
    pushAll: false,
    pushOnly: true,
    strategy: 'cloud-wins',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function calledPaths(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((c) => (c[0] as URL).pathname);
}

describe('mysecond sync --push-only', () => {
  let originalFetch: typeof fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('pushes changed artifacts + context files and NEVER calls cli-sync (no pull)', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'company-content');
    mkdirSync(join(root, 'work/specs/outputs'), { recursive: true });
    writeFileSync(join(root, 'work/specs/outputs/prd.md'), 'a prd');

    fetchMock.mockImplementation((url: URL) => {
      const p = url.pathname;
      if (p === '/api/companion/artifacts') return Promise.resolve(jsonResponse({ synced: 1 }));
      if (p === '/api/companion/files') {
        return Promise.resolve(jsonResponse({ synced: 1, skipped: 0, errors: [] }));
      }
      throw new Error(`unexpected fetch to ${p}`);
    });

    const code = await runSync([], ctx(root));
    expect(code).toBe(0);

    const paths = calledPaths(fetchMock);
    expect(paths).toContain('/api/companion/artifacts');
    expect(paths).toContain('/api/companion/files');
    // The whole point of --push-only: it must not pull.
    expect(paths).not.toContain('/api/companion/cli-sync');
  });

  it('is incremental — skips files whose hash already matches sync-state', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    const content = 'already-synced';
    writeFileSync(join(root, 'context/company.md'), content);
    // Pre-seed sync-state with the matching hash → nothing to push.
    writeFileSync(
      join(root, '.claude/sync-state.json'),
      JSON.stringify({
        contextFiles: { 'context/company.md': { hash: shortHash(content), pushedAt: '2026-01-01T00:00:00Z' } },
      }),
    );

    const code = await runSync([], ctx(root));
    expect(code).toBe(0);
    // No change → no push, and never a pull.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records pushed hashes in sync-state so the next turn skips them', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'company-content');
    fetchMock.mockResolvedValue(jsonResponse({ synced: 1, skipped: 0, errors: [] }));

    await runSync([], ctx(root));

    const state = JSON.parse(readFileSync(join(root, '.claude/sync-state.json'), 'utf8'));
    expect(state.contextFiles['context/company.md']).toBeTruthy();
  });

  it('is best-effort — returns 0 even when the push fails', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'x');
    fetchMock.mockResolvedValue(new Response('err', { status: 500 }));

    const code = await runSync([], ctx(root));
    expect(code).toBe(0);
  });

  it('no-op (still exit 0, no calls) when there is nothing to push', async () => {
    const root = tmpProject();
    const code = await runSync([], ctx(root));
    expect(code).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  function recordedSection(root: string, key: 'artifacts' | 'contextFiles'): Record<string, unknown> {
    const statePath = join(root, '.claude/sync-state.json');
    if (!existsSync(statePath)) return {};
    return (JSON.parse(readFileSync(statePath, 'utf8'))[key] ?? {}) as Record<string, unknown>;
  }

  // Codex review #3: a partial server accept must NOT record un-accepted files
  // as pushed (the artifacts response has no per-file info, so synced < count
  // means we can't tell which were rejected → record none, retry next turn).
  it('does NOT record artifact hashes on a partial accept (synced < count)', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'work/specs/outputs'), { recursive: true });
    writeFileSync(join(root, 'work/specs/outputs/a.md'), 'aaa');
    writeFileSync(join(root, 'work/specs/outputs/b.md'), 'bbb');
    fetchMock.mockImplementation((url: URL) => {
      if (url.pathname === '/api/companion/artifacts') return Promise.resolve(jsonResponse({ synced: 1 }));
      throw new Error(`unexpected fetch to ${url.pathname}`);
    });

    const code = await runSync([], ctx(root));
    expect(code).toBe(0);
    // Neither file recorded → both retry next turn (no false "pushed").
    expect(recordedSection(root, 'artifacts')).toEqual({});
  });

  it('does NOT record context hashes when the server returns per-file errors', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'company');
    fetchMock.mockImplementation((url: URL) => {
      if (url.pathname === '/api/companion/files') {
        return Promise.resolve(
          jsonResponse({ synced: 0, skipped: 0, errors: ['rejected: context/company.md'] }),
        );
      }
      throw new Error(`unexpected fetch to ${url.pathname}`);
    });

    const code = await runSync([], ctx(root));
    expect(code).toBe(0);
    expect(recordedSection(root, 'contextFiles')).toEqual({});
  });
});
