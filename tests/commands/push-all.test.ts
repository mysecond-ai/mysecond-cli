// Tests for `mysecond sync --push-all` (runSync's pushAll branch).
//
// Unlike the normal up-sync (which is hash-gated, runs only after a successful
// pull, and swallows push failures), --push-all force-pushes ALL local context
// files unconditionally and SURFACES failures. It must not call cli-sync (the
// pull) at all — it returns early.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runSync } from '../../src/commands/sync.js';
import type { CommandContext } from '../../src/lib/context.js';

function tmpProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'mysecond-push-all-'));
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
    pushAll: true,
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

describe('mysecond sync --push-all', () => {
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

  it('force-pushes all context files and returns 0 on success (no pull/cli-sync GET)', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'company-content');
    writeFileSync(join(root, 'context/product.md'), 'product-content');

    fetchMock.mockResolvedValueOnce(jsonResponse({ synced: 2, skipped: 0, errors: [] }));

    const code = await runSync([], ctx(root));
    expect(code).toBe(0);

    // Exactly one call — the /files POST. No cli-sync GET (push-all returns early).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(call[0].pathname).toBe('/api/companion/files');
    const body = JSON.parse(call[1].body as string);
    expect(body.files.map((f: { file_path: string }) => f.file_path).sort()).toEqual([
      'context/company.md',
      'context/product.md',
    ]);
  });

  it('returns 1 and surfaces a protected-file rejection (200 with errors)', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'company-content');

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        synced: 0,
        skipped: 0,
        errors: ['cannot_create_protected_file_as_pm: context/company.md'],
      }),
    );

    const code = await runSync([], ctx(root));
    expect(code).toBe(1);
  })

  it('returns 1 when the server accepts nothing (silent rejection / swallowed 4xx)', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'company-content');

    // contextFilesPush swallows >=400 into { synced:0, skipped:0, errors:[] }.
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));

    const code = await runSync([], ctx(root));
    expect(code).toBe(1);
  })

  it('returns 0 and makes no push call when there is nothing to push', async () => {
    const root = tmpProject();
    const code = await runSync([], ctx(root));
    expect(code).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  })
})
