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

import { runPushOnly, runSync } from '../../src/commands/sync.js';
import { shortHash } from '../../src/lib/files.js';
import { buildContext, parseGlobalFlags, type CommandContext } from '../../src/lib/context.js';
import { installFakeHome, type FakeHome } from '../helpers/fake-home.js';

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

// P1 (2026-07-29, codex pm-os plugin review): the realtime Stop/SubagentStop
// hook invokes the `push` SUBCOMMAND, which dispatches straight to
// runPushOnly — runSync's COMPANION_API_KEY check is never on that path.
// Before the preflight, an installed-but-never-connected machine collected
// changed workspace files and POSTed their paths/contents to the server with
// an empty bearer: the server rejected it, but the workspace data had
// already left the machine (privacy defect; falsified the plugin README's
// "sends nothing without a credential" claim). These tests call runPushOnly
// DIRECTLY, mirroring the `push` subcommand dispatch.
describe('mysecond push (runPushOnly direct) — credential preflight', () => {
  let originalFetch: typeof fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let fake: FakeHome | null = null;
  let savedKey: string | undefined;
  let savedUrl: string | undefined;
  let savedClaudeDir: string | undefined;
  let stdoutBuf: string;
  let stderrBuf: string;
  let origStdoutWrite: typeof process.stdout.write;
  let origStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // Env isolation for the buildContext-based test — a real
    // COMPANION_API_KEY in the runner env would satisfy the preflight for
    // the wrong reason.
    savedKey = process.env.COMPANION_API_KEY;
    savedUrl = process.env.COMPANION_API_URL;
    savedClaudeDir = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.COMPANION_API_KEY;
    delete process.env.COMPANION_API_URL;
    delete process.env.CLAUDE_PROJECT_DIR;
    // Capture output — the no-credential path must be SILENT.
    stdoutBuf = '';
    stderrBuf = '';
    origStdoutWrite = process.stdout.write.bind(process.stdout);
    origStderrWrite = process.stderr.write.bind(process.stderr);
    (process.stdout.write as unknown) = ((chunk: string | Uint8Array) => {
      stdoutBuf += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    (process.stderr.write as unknown) = ((chunk: string | Uint8Array) => {
      stderrBuf += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    if (fake !== null) {
      fake.restore();
      fake = null;
    }
    if (savedKey === undefined) delete process.env.COMPANION_API_KEY;
    else process.env.COMPANION_API_KEY = savedKey;
    if (savedUrl === undefined) delete process.env.COMPANION_API_URL;
    else process.env.COMPANION_API_URL = savedUrl;
    if (savedClaudeDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedClaudeDir;
  });

  it('no credential + changed files → ZERO network calls, silent exit 0', async () => {
    // Sandbox home so getDeviceToken can't resolve the developer's real
    // credentials — this ctx is built manually, but keep the machine state
    // honest anyway.
    fake = installFakeHome('mysecond-push-guard-');
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'never-sent-content');
    mkdirSync(join(root, 'work/specs/outputs'), { recursive: true });
    writeFileSync(join(root, 'work/specs/outputs/prd.md'), 'never-sent-prd');

    const code = await runPushOnly(ctx(root, { apiKey: '' }));

    expect(code).toBe(0);
    // The load-bearing assertion: nothing left the machine. Not "the server
    // rejected it" — the request must never be made.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stdoutBuf).toBe('');
    expect(stderrBuf).toBe('');
  });

  it('with a credential the push fires exactly as before (guard is not over-eager)', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'company-content');
    fetchMock.mockImplementation((url: URL) => {
      if (url.pathname === '/api/companion/files') {
        return Promise.resolve(jsonResponse({ synced: 1, skipped: 0, errors: [] }));
      }
      throw new Error(`unexpected fetch to ${url.pathname}`);
    });

    const code = await runPushOnly(ctx(root));

    expect(code).toBe(0);
    expect(calledPaths(fetchMock)).toContain('/api/companion/files');
  });

  it('the global-file fallback satisfies the preflight — a /mysecond-logged-in machine pushes', async () => {
    // End-to-end for the PR #55 + preflight interaction: no flag, no env,
    // nothing project-scoped — only ~/.mysecond/credentials as `/mysecond`
    // login writes it. buildContext resolves the token via the global-file
    // fallback, so the preflight passes and the push carries that bearer.
    fake = installFakeHome('mysecond-push-guard-');
    const globalDir = join(fake.home, '.mysecond');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, 'credentials'), 'COMPANION_API_KEY=msd_global_login_token\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'company-content');
    fetchMock.mockImplementation((url: URL) => {
      if (url.pathname === '/api/companion/files') {
        return Promise.resolve(jsonResponse({ synced: 1, skipped: 0, errors: [] }));
      }
      throw new Error(`unexpected fetch to ${url.pathname}`);
    });

    const built = buildContext(parseGlobalFlags(['--project-dir', root, '--push-only', '--silent']));
    const code = await runPushOnly(built);

    expect(code).toBe(0);
    const paths = calledPaths(fetchMock);
    expect(paths).toContain('/api/companion/files');
    // The bearer is the global-file token — proof the fallback fed the push.
    const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer msd_global_login_token');
  });
});
