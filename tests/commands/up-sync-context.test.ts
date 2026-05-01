// SessionStart up-loop tests for the context-file branch of runSync.
// Mocks the fetch transport — exercises the real construction path of
// scanContextFiles → state filter → contextFilesPush → state mutation.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runSync } from '../../src/commands/sync.js';
import type { CommandContext } from '../../src/lib/context.js';
import { writeSyncState, readSyncState, type SyncState } from '../../src/lib/sync-state.js';

function tmpProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'mysecond-up-sync-context-'));
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

function emptyDownSync(): unknown {
  return {
    context_files: [],
    custom_skills: [],
    custom_agents: [],
    custom_workflows: [],
    claude_md_override: null,
    deleted_paths: [],
    syncedAt: new Date().toISOString(),
  };
}

function seedState(rootDir: string, partial: Partial<SyncState> = {}): void {
  const base: SyncState = {
    files: {},
    artifacts: {},
    contextFiles: {},
    lastSyncedAt: '2026-04-29T00:00:00.000Z',
    lastNpmUpdateAt: new Date().toISOString(),
    initCompletedSteps: [],
    step9Auth401RetryCount: 0,
    customerId: null,
    workspaceScope: null,
    customerSlug: null,
  };
  writeSyncState(rootDir, { ...base, ...partial });
}

describe('upSyncContextFiles via runSync', () => {
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

  it('pushes new context files, recording state on success', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context/personas'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'company-content');
    writeFileSync(join(root, 'context/personas/buyer.md'), 'buyer-content');
    seedState(root);

    fetchMock
      .mockResolvedValueOnce(jsonResponse(emptyDownSync())) // cli-sync GET
      .mockResolvedValueOnce(jsonResponse({ synced: 2, skipped: 0, errors: [] })); // files POST

    const code = await runSync([], ctx(root));
    expect(code).toBe(0);

    const filesCall = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(filesCall[0].pathname).toBe('/api/companion/files');
    const body = JSON.parse(filesCall[1].body as string);
    expect(body.files.map((f: { file_path: string }) => f.file_path).sort()).toEqual([
      'context/company.md',
      'context/personas/buyer.md',
    ]);

    const state = readSyncState(root);
    expect(state.contextFiles['context/company.md']).toBeDefined();
    expect(state.contextFiles['context/personas/buyer.md']).toBeDefined();
  });

  it('skips files whose hash matches the recorded state (idempotent)', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    const content = 'unchanged';
    writeFileSync(join(root, 'context/company.md'), content);

    // shortHash of "unchanged" — capture by running once and reading state, but
    // we just need the matching value. Compute it here to seed state.
    const { shortHash } = await import('../../src/lib/files.js');
    seedState(root, {
      contextFiles: {
        'context/company.md': { hash: shortHash(content), pushedAt: new Date().toISOString() },
      },
    });

    fetchMock.mockResolvedValueOnce(jsonResponse(emptyDownSync()));

    await runSync([], ctx(root));

    // Only one fetch (the cli-sync GET). No files POST because everything matched state.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('records state on skipped (server-side hash match) just like synced', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'hello');
    seedState(root);

    fetchMock
      .mockResolvedValueOnce(jsonResponse(emptyDownSync()))
      .mockResolvedValueOnce(jsonResponse({ synced: 0, skipped: 1, errors: [] }));

    await runSync([], ctx(root));

    const state = readSyncState(root);
    expect(state.contextFiles['context/company.md']).toBeDefined();
  });

  it('does NOT block down-sync when context-file push fails', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'hello');
    seedState(root);

    fetchMock
      .mockResolvedValueOnce(jsonResponse(emptyDownSync()))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));

    const code = await runSync([], ctx(root));
    expect(code).toBe(0);

    const state = readSyncState(root);
    expect(state.contextFiles['context/company.md']).toBeUndefined();
  });

  it('handles missing context/ dir cleanly (no scan = no push)', async () => {
    const root = tmpProject();
    seedState(root);

    fetchMock.mockResolvedValueOnce(jsonResponse(emptyDownSync()));

    const code = await runSync([], ctx(root));
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('artifact failure does not prevent context-file push', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    mkdirSync(join(root, 'specs/outputs'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'hello');
    writeFileSync(join(root, 'specs/outputs/foo.md'), '# PRD');
    seedState(root);

    fetchMock
      .mockResolvedValueOnce(jsonResponse(emptyDownSync())) // cli-sync
      .mockResolvedValueOnce(new Response('boom', { status: 500 })) // artifacts POST fails
      .mockResolvedValueOnce(jsonResponse({ synced: 1, skipped: 0, errors: [] })); // files POST

    await runSync([], ctx(root));

    const state = readSyncState(root);
    expect(state.contextFiles['context/company.md']).toBeDefined();
  });
});
