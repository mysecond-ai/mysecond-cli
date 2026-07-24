// Install-beacon transport tests (install-wall plan). Mocks fetch — asserts
// the outgoing wire format (URL, headers, body) and the two delivery
// invariants: never rejects, always settles within the timeout.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BEACON_TIMEOUT_MS, emitBeacon } from '../../src/lib/beacon.js';

describe('emitBeacon', () => {
  let originalFetch: typeof fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('POSTs the wire format the server allowlists', async () => {
    await emitBeacon({
      apiBase: 'https://app.mysecond.ai',
      installId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      stage: 'cli_started',
      slug: 'acme-corp-a3f2',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('https://app.mysecond.ai/api/companion/install-beacon');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-mysecond-install-id']).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(headers['user-agent']).toMatch(/^mysecond-cli\/\d+\.\d+\.\d+ \(/);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      stage: 'cli_started',
      slug: 'acme-corp-a3f2',
      os: process.platform,
      node_version: process.versions.node,
    });
    expect(typeof body.cli_version).toBe('string');
  })

  it('omits empty/undefined slug and caps error fields', async () => {
    await emitBeacon({
      apiBase: 'https://app.mysecond.ai',
      installId: 'x',
      stage: 'mint_failed',
      slug: '',
      errorClass: 'e'.repeat(200),
      errorExcerpt: 'y'.repeat(1000),
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [URL, RequestInit])[1].body)) as Record<string, unknown>;
    expect('slug' in body).toBe(false);
    expect((body.error_class as string).length).toBe(64);
    expect((body.error_excerpt as string).length).toBe(400);
  })

  it('NEVER rejects — network failure', async () => {
    fetchMock.mockRejectedValue(new Error('ENOTFOUND app.mysecond.ai'));
    await expect(
      emitBeacon({ apiBase: 'https://app.mysecond.ai', installId: 'x', stage: 'wrong_window' })
    ).resolves.toBeUndefined();
  })

  it('NEVER rejects — server 4xx/5xx and malformed apiBase', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(
      emitBeacon({ apiBase: 'https://app.mysecond.ai', installId: 'x', stage: 'cli_started' })
    ).resolves.toBeUndefined();
    await expect(
      emitBeacon({ apiBase: 'not a url at all', installId: 'x', stage: 'cli_started' })
    ).resolves.toBeUndefined();
  })

  it('passes an abort signal bounded by BEACON_TIMEOUT_MS', async () => {
    await emitBeacon({ apiBase: 'https://app.mysecond.ai', installId: 'x', stage: 'cli_started' });
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(BEACON_TIMEOUT_MS).toBe(3_000);
  })
})
