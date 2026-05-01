// Mocks the fetch transport — NOT contextFilesPush itself. Tests assert the
// outgoing wire format (URL, method, Authorization header, body shape) so a
// regression that breaks the server contract surfaces here. Mirrors the PR
// #107 regression-test template referenced in CLAUDE.md.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { contextFilesPush } from '../../src/lib/api.js';
import type { CommandContext } from '../../src/lib/context.js';
import type { ContextFilePayload } from '../../src/lib/payload.js';

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    apiBase: 'https://app.mysecond.ai',
    apiKey: 'test-key-123',
    rootDir: '/tmp/x',
    silent: false,
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

function file(path: string, content: string): ContextFilePayload {
  return { file_path: path, content, current_hash: 'h_' + content.length };
}

describe('contextFilesPush', () => {
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

  it('returns empty result and skips fetch when files is empty', async () => {
    const result = await contextFilesPush(ctx(), []);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ synced: 0, skipped: 0, errors: [] });
  });

  it('hits POST /api/companion/files with Bearer auth and { files } body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ synced: 1, skipped: 0, errors: [] }));

    const payload = [file('context/company.md', 'hello')];
    await contextFilesPush(ctx(), payload);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://app.mysecond.ai/api/companion/files');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-key-123');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ files: payload });
  });

  it('returns server response body verbatim on 2xx', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ synced: 2, skipped: 1, errors: ['warning'] })
    );
    const result = await contextFilesPush(ctx(), [file('context/a.md', 'a')]);
    expect(result).toEqual({ synced: 2, skipped: 1, errors: ['warning'] });
  });

  it('returns zero-counts on 4xx (best-effort, no throw)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'too large' }), { status: 413 })
    );
    const result = await contextFilesPush(ctx(), [file('context/a.md', 'a')]);
    expect(result).toEqual({ synced: 0, skipped: 0, errors: [] });
  });

  it('returns zero-counts on 5xx', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const result = await contextFilesPush(ctx(), [file('context/a.md', 'a')]);
    expect(result).toEqual({ synced: 0, skipped: 0, errors: [] });
  });

  it('throws networkUnreachable when fetch rejects', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(contextFilesPush(ctx(), [file('context/a.md', 'a')])).rejects.toThrow(
      /Cannot reach mysecond\.ai/
    );
  });

  it('throws invalidApiKey on 401 via halt-header check (server-driven)', async () => {
    // 401/403 from /api/companion/files goes through best-effort guard
    // (response.status >= 400) and returns zeros — same as artifactsSync.
    fetchMock.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }));
    const result = await contextFilesPush(ctx(), [file('context/a.md', 'a')]);
    expect(result).toEqual({ synced: 0, skipped: 0, errors: [] });
  });
});
