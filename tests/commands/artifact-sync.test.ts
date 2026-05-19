// PostToolUse path tests for runArtifactSync, focused on the new context-file
// branch. Mocks the fetch transport and stubs process.stdin so the test
// exercises the real construction path (parses the tool event, walks the
// context-file branch, builds the payload, and calls fetch).

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runArtifactSync } from '../../src/commands/artifact-sync.js';
import type { CommandContext } from '../../src/lib/context.js';
import { readSyncState } from '../../src/lib/sync-state.js';

function tmpProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'mysecond-artifact-sync-'));
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

function stubStdin(payload: string): void {
  const stream = Readable.from([payload]);
  // Match the interface readStdin uses: setEncoding + async iteration.
  (stream as unknown as { setEncoding: (e: string) => void }).setEncoding = () => {};
  Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
}

function toolEvent(toolName: string, filePath: string): string {
  return JSON.stringify({ tool_name: toolName, tool_input: { file_path: filePath } });
}

describe('runArtifactSync — context-file branch', () => {
  let originalFetch: typeof fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalStdin: NodeJS.ReadStream;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    originalStdin = process.stdin;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
  });

  it('exits 0 immediately when apiKey is empty (no fetch)', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'hello');
    stubStdin(toolEvent('Write', join(root, 'context/company.md')));

    const code = await runArtifactSync([], ctx(root, { apiKey: '' }));
    expect(code).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pushes a context file via POST /api/companion/files with correct wire format', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'hello world');
    fetchMock.mockResolvedValueOnce(jsonResponse({ synced: 1, skipped: 0, errors: [] }));
    stubStdin(toolEvent('Write', join(root, 'context/company.md')));

    const code = await runArtifactSync([], ctx(root));
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://app.mysecond.ai/api/companion/files');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      files: [
        {
          file_path: 'context/company.md',
          content: 'hello world',
          current_hash: expect.stringMatching(/^[0-9a-f]{12}$/),
        },
      ],
    });
  });

  it('persists sync-state on successful push so SessionStart can de-dupe', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'hello');
    fetchMock.mockResolvedValueOnce(jsonResponse({ synced: 1, skipped: 0, errors: [] }));
    stubStdin(toolEvent('Edit', join(root, 'context/company.md')));

    await runArtifactSync([], ctx(root));

    const state = readSyncState(root);
    const entry = state.contextFiles['context/company.md'];
    expect(entry).toBeDefined();
    expect(entry?.hash).toMatch(/^[0-9a-f]{12}$/);
    expect(entry?.pushedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('persists sync-state when server reports skipped (hash-match) — keeps state in step', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'hello');
    fetchMock.mockResolvedValueOnce(jsonResponse({ synced: 0, skipped: 1, errors: [] }));
    stubStdin(toolEvent('Write', join(root, 'context/company.md')));

    await runArtifactSync([], ctx(root));

    const state = readSyncState(root);
    expect(state.contextFiles['context/company.md']).toBeDefined();
  });

  it('does NOT persist sync-state when server returns 5xx', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'hello');
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    stubStdin(toolEvent('Write', join(root, 'context/company.md')));

    const code = await runArtifactSync([], ctx(root));
    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const state = readSyncState(root);
    expect(state.contextFiles['context/company.md']).toBeUndefined();
  });

  it('does NOT persist sync-state when network throws', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'hello');
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    stubStdin(toolEvent('Write', join(root, 'context/company.md')));

    const code = await runArtifactSync([], ctx(root));
    expect(code).toBe(0);

    const state = readSyncState(root);
    expect(state.contextFiles['context/company.md']).toBeUndefined();
  });

  it('skips empty context files', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/empty.md'), '');
    stubStdin(toolEvent('Write', join(root, 'context/empty.md')));

    const code = await runArtifactSync([], ctx(root));
    expect(code).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips files larger than 50KB', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/huge.md'), 'x'.repeat(50 * 1024 + 1));
    stubStdin(toolEvent('Write', join(root, 'context/huge.md')));

    await runArtifactSync([], ctx(root));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes nested context paths', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context/personas'), { recursive: true });
    writeFileSync(join(root, 'context/personas/buyer.md'), 'buyer');
    fetchMock.mockResolvedValueOnce(jsonResponse({ synced: 1, skipped: 0, errors: [] }));
    stubStdin(toolEvent('Write', join(root, 'context/personas/buyer.md')));

    await runArtifactSync([], ctx(root));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/companion/files');
  });

  it('does NOT route root-level CLAUDE.md as a context file', async () => {
    const root = tmpProject();
    writeFileSync(join(root, 'CLAUDE.md'), '# project');
    stubStdin(toolEvent('Write', join(root, 'CLAUDE.md')));

    await runArtifactSync([], ctx(root));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does NOT route paths outside context/ even when .md', async () => {
    const root = tmpProject();
    writeFileSync(join(root, 'NOT_CONTEXT.md'), 'x');
    stubStdin(toolEvent('Write', join(root, 'NOT_CONTEXT.md')));

    await runArtifactSync([], ctx(root));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects path-traversal escapes via relativeFromRoot guard', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    // Construct an absolute path OUTSIDE root.
    stubStdin(toolEvent('Write', '/etc/passwd'));

    await runArtifactSync([], ctx(root));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does NOT push for non-write tools (Read/Bash/etc)', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'x');
    stubStdin(toolEvent('Read', join(root, 'context/company.md')));

    await runArtifactSync([], ctx(root));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('frontmatter round-trips byte-identical in payload', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    const content = '---\ntitle: Test\nfoo: bar\n---\n\n# Body\n';
    writeFileSync(join(root, 'context/with-fm.md'), content);
    fetchMock.mockResolvedValueOnce(jsonResponse({ synced: 1, skipped: 0, errors: [] }));
    stubStdin(toolEvent('Write', join(root, 'context/with-fm.md')));

    await runArtifactSync([], ctx(root));
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.files[0].content).toBe(content);
  });

  it('preserves the artifact path: PRD writes still hit /api/companion/artifacts', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'specs/outputs'), { recursive: true });
    const prdPath = join(root, 'specs/outputs/2026-04-30-prd-generator.md');
    writeFileSync(prdPath, '# PRD');
    fetchMock.mockResolvedValueOnce(jsonResponse({ synced: 1 }));
    stubStdin(toolEvent('Write', prdPath));

    await runArtifactSync([], ctx(root));
    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/companion/artifacts');
  });

  it('handles malformed sync-state.json by reinitializing fresh state on success', async () => {
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'x');
    writeFileSync(join(root, '.claude/sync-state.json'), '{not valid json');
    fetchMock.mockResolvedValueOnce(jsonResponse({ synced: 1, skipped: 0, errors: [] }));
    stubStdin(toolEvent('Write', join(root, 'context/company.md')));

    const code = await runArtifactSync([], ctx(root));
    expect(code).toBe(0);

    // Sync-state should now contain the freshly-pushed entry.
    const written = JSON.parse(readFileSync(join(root, '.claude/sync-state.json'), 'utf8'));
    expect(written.contextFiles['context/company.md']).toBeDefined();
  });

  // Follow-up #6 — server kill switch must propagate from the PostToolUse
  // hook so subsequent events also stop. Previously the catch-all swallowed
  // the rollbackPause MysecondError and the hook still returned 0.
  it('re-throws rollbackPause (exitCode 7) on context branch when server returns halt header', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mysecond-pth-halt-'));
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'x');
    fetchMock.mockResolvedValueOnce(
      new Response('{"synced":0}', {
        status: 200,
        headers: { 'X-Mysecond-Halt': '1' },
      })
    );
    stubStdin(toolEvent('Write', join(root, 'context/company.md')));

    await expect(runArtifactSync([], ctx(root))).rejects.toMatchObject({ exitCode: 7 });
  });

  it('re-throws rollbackPause (exitCode 7) on artifact branch when server returns halt header', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mysecond-pth-halt-art-'));
    mkdirSync(join(root, 'specs/outputs'), { recursive: true });
    writeFileSync(join(root, 'specs/outputs/foo.md'), 'x');
    fetchMock.mockResolvedValueOnce(
      new Response('{"synced":0}', {
        status: 200,
        headers: { 'X-Mysecond-Halt': '1' },
      })
    );
    stubStdin(toolEvent('Write', join(root, 'specs/outputs/foo.md')));

    await expect(runArtifactSync([], ctx(root))).rejects.toMatchObject({ exitCode: 7 });
  });
});

describe('runArtifactSync — customs v1 branch (.claude/skills, .claude/agents, .claude/workflows)', () => {
  let originalFetch: typeof fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalStdin: NodeJS.ReadStream;
  const savedSessionId = process.env.CLAUDE_SESSION_ID;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    originalStdin = process.stdin;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
    if (savedSessionId === undefined) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = savedSessionId;
  });

  it('pushes a customer-created skill via POST /api/companion/files with authored_by stamped', async () => {
    const root = tmpProject();
    mkdirSync(join(root, '.claude/skills/my-skill'), { recursive: true });
    writeFileSync(
      join(root, '.claude/skills/my-skill/SKILL.md'),
      '---\nname: my-skill\ndescription: test\n---\n\n# my skill\n'
    );
    process.env.CLAUDE_SESSION_ID = 'sess_e2e_test';
    fetchMock.mockResolvedValueOnce(jsonResponse({ synced: 1, skipped: 0, errors: [] }));
    stubStdin(toolEvent('Write', join(root, '.claude/skills/my-skill/SKILL.md')));

    const code = await runArtifactSync([], ctx(root));
    expect(code).toBe(0);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://app.mysecond.ai/api/companion/files');
    const body = JSON.parse(init.body as string);
    expect(body.files).toHaveLength(1);
    const file = body.files[0];
    expect(file.file_path).toBe('.claude/skills/my-skill/SKILL.md');
    expect(file.authored_by).toEqual({
      kind: 'ai',
      source: 'claude-code',
      identity: 'sess_e2e_test',
    });
  });

  it('falls back to `${model}:${timestamp}` identity when CLAUDE_SESSION_ID is unset', async () => {
    const root = tmpProject();
    mkdirSync(join(root, '.claude/agents'), { recursive: true });
    writeFileSync(join(root, '.claude/agents/reviewer.md'), '# reviewer agent');
    delete process.env.CLAUDE_SESSION_ID;
    process.env.CLAUDE_MODEL = 'claude-sonnet-4-7';
    fetchMock.mockResolvedValueOnce(jsonResponse({ synced: 1, skipped: 0, errors: [] }));
    stubStdin(toolEvent('Write', join(root, '.claude/agents/reviewer.md')));

    await runArtifactSync([], ctx(root));
    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    );
    expect(body.files[0].authored_by.identity).toMatch(/^claude-sonnet-4-7:\d{4}-\d{2}-\d{2}T/);
  });

  it('pushes workflow files nested under .claude/workflows/<slug>/', async () => {
    const root = tmpProject();
    mkdirSync(join(root, '.claude/workflows/launch'), { recursive: true });
    writeFileSync(join(root, '.claude/workflows/launch/step-1.md'), '# step 1');
    process.env.CLAUDE_SESSION_ID = 'sess_workflow';
    fetchMock.mockResolvedValueOnce(jsonResponse({ synced: 1, skipped: 0, errors: [] }));
    stubStdin(toolEvent('Write', join(root, '.claude/workflows/launch/step-1.md')));

    const code = await runArtifactSync([], ctx(root));
    expect(code).toBe(0);
    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    );
    expect(body.files[0].file_path).toBe('.claude/workflows/launch/step-1.md');
    expect(body.files[0].authored_by.kind).toBe('ai');
  });

  it('regular context/ writes do NOT carry an authored_by field', async () => {
    // Sanity guard: stamping authored_by on every context-file push would
    // change the wire format for the existing fleet of context syncs and
    // pollute the receiver's funnel with non-customs rows.
    const root = tmpProject();
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'hello');
    process.env.CLAUDE_SESSION_ID = 'sess_should_not_appear';
    fetchMock.mockResolvedValueOnce(jsonResponse({ synced: 1, skipped: 0, errors: [] }));
    stubStdin(toolEvent('Write', join(root, 'context/company.md')));

    await runArtifactSync([], ctx(root));
    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    );
    expect(body.files[0].authored_by).toBeUndefined();
  });
});
