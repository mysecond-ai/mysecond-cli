// Workstream H — base plugin update sync tests.
//
// Exercises the real construction path through runSync:
//   1. Read install-state.json
//   2. Send client_base_plugin_version on the cli-sync request
//   3. For each base_skill/agent/workflow in the response, customization-detect
//      against install-state hashes and either overwrite or silently skip
//   4. Persist updated install-state (new hashes + advanced base_plugin_version)
//
// Mocks the fetch transport so we can assert the exact wire format and inject
// any server response shape. Tmp-redirects $HOME so install-state writes don't
// leak into the developer's real ~/.mysecond/projects/.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runSync } from '../../src/commands/sync.js';
import type { CommandContext } from '../../src/lib/context.js';
import { writeSyncState, type SyncState } from '../../src/lib/sync-state.js';
import { shortHash } from '../../src/lib/files.js';
import { readInstallState, getInstallStatePath } from '../../src/lib/install-state.js';

function tmpProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'mysecond-base-sync-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  return root;
}

function ctx(rootDir: string): CommandContext {
  return {
    apiBase: 'https://app.mysecond.ai',
    apiKey: 'test-key',
    rootDir,
    silent: true,
    dryRun: false,
    forceUpdate: false,
    fix: false,
    strategy: 'cloud-wins',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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

const SHA_OLD = 'a'.repeat(40);
const SHA_NEW = 'b'.repeat(40);

describe('Workstream H — base plugin update sync', () => {
  let originalFetch: typeof fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalHome: string | undefined;
  let tmpHome: string;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    // Tmp-redirect $HOME so install-state.json writes don't touch the dev's
    // real ~/.mysecond/projects/ tree. getProjectScopedCredsDir reads
    // os.homedir() which falls back to $HOME on POSIX.
    originalHome = process.env.HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'mysecond-base-sync-home-'));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('sends client_base_plugin_version=null on a fresh install (no install-state.json yet)', async () => {
    const root = tmpProject();
    seedState(root);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        context_files: [],
        custom_skills: [],
        custom_agents: [],
        custom_workflows: [],
        base_plugin_version: SHA_NEW,
        syncedAt: new Date().toISOString(),
      }),
    );

    await runSync([], ctx(root));
    const url = (fetchMock.mock.calls[0] as [URL, RequestInit])[0];
    expect(url.pathname).toBe('/api/companion/cli-sync');
    expect(url.searchParams.get('client_base_plugin_version')).toBe(null);

    // After successful sync we persist the server SHA — next sync will send it.
    const state = readInstallState(root);
    expect(state.base_plugin_version).toBe(SHA_NEW);
    expect(existsSync(getInstallStatePath(root))).toBe(true);
  });

  it('writes new base skills/agents/workflows + records install-time hashes', async () => {
    const root = tmpProject();
    seedState(root);

    const skill = { file_path: '.claude/skills/prd-generator/SKILL.md', content: '# PRD', current_hash: shortHash('# PRD') };
    const agent = { file_path: '.claude/agents/cto.md', content: 'cto body', current_hash: shortHash('cto body') };
    const workflow = { file_path: 'workflows/discovery/workflow.md', content: 'wf body', current_hash: shortHash('wf body') };

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        context_files: [],
        custom_skills: [],
        custom_agents: [],
        custom_workflows: [],
        base_plugin_version: SHA_NEW,
        base_skills: [skill],
        base_agents: [agent],
        base_workflows: [workflow],
        syncedAt: new Date().toISOString(),
      }),
    );

    await runSync([], ctx(root));

    expect(readFileSync(join(root, skill.file_path), 'utf8')).toBe('# PRD');
    expect(readFileSync(join(root, agent.file_path), 'utf8')).toBe('cto body');
    expect(readFileSync(join(root, workflow.file_path), 'utf8')).toBe('wf body');

    const state = readInstallState(root);
    expect(state.base_plugin_version).toBe(SHA_NEW);
    expect(state.files[skill.file_path]).toBe(skill.current_hash);
    expect(state.files[agent.file_path]).toBe(agent.current_hash);
    expect(state.files[workflow.file_path]).toBe(workflow.current_hash);
  });

  it('overwrites un-customized base skill on update (local hash matches install-time hash)', async () => {
    const root = tmpProject();
    seedState(root);

    // Pre-existing install: customer has the OLD prd-generator on disk that
    // matches the install-time hash exactly.
    const skillPath = '.claude/skills/prd-generator/SKILL.md';
    const oldContent = '# PRD v1';
    mkdirSync(join(root, '.claude/skills/prd-generator'), { recursive: true });
    writeFileSync(join(root, skillPath), oldContent);

    // Seed install-state to look like a prior sync at SHA_OLD recorded the
    // file with the matching hash.
    const initialState = readInstallState(root);
    initialState.base_plugin_version = SHA_OLD;
    initialState.files[skillPath] = shortHash(oldContent);
    const { writeInstallState } = await import('../../src/lib/install-state.js');
    writeInstallState(root, initialState);

    const newContent = '# PRD v2 — improved';
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        context_files: [],
        custom_skills: [],
        custom_agents: [],
        custom_workflows: [],
        base_plugin_version: SHA_NEW,
        base_skills: [{ file_path: skillPath, content: newContent, current_hash: shortHash(newContent) }],
        syncedAt: new Date().toISOString(),
      }),
    );

    await runSync([], ctx(root));

    // File overwritten with new content
    expect(readFileSync(join(root, skillPath), 'utf8')).toBe(newContent);
    const state = readInstallState(root);
    expect(state.base_plugin_version).toBe(SHA_NEW);
    expect(state.files[skillPath]).toBe(shortHash(newContent));
  });

  it('SILENTLY skips overwrite when customer has customized the skill (local hash diverges)', async () => {
    const root = tmpProject();
    seedState(root);

    const skillPath = '.claude/skills/prd-generator/SKILL.md';
    const installedContent = '# PRD v1';
    const customizedContent = '# PRD v1 — with my Salesforce taxonomy';
    mkdirSync(join(root, '.claude/skills/prd-generator'), { recursive: true });
    // Customer customized after install: file on disk != install-time hash.
    writeFileSync(join(root, skillPath), customizedContent);
    const initialState = readInstallState(root);
    initialState.base_plugin_version = SHA_OLD;
    initialState.files[skillPath] = shortHash(installedContent);
    const { writeInstallState } = await import('../../src/lib/install-state.js');
    writeInstallState(root, initialState);

    const newServerContent = '# PRD v2';
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        context_files: [],
        custom_skills: [],
        custom_agents: [],
        custom_workflows: [],
        base_plugin_version: SHA_NEW,
        base_skills: [{ file_path: skillPath, content: newServerContent, current_hash: shortHash(newServerContent) }],
        syncedAt: new Date().toISOString(),
      }),
    );

    // Capture stdout to assert nothing about customization reaches the customer.
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runSync([], ctx(root));

    // Customer's edits preserved
    expect(readFileSync(join(root, skillPath), 'utf8')).toBe(customizedContent);

    // Install-time hash not bumped (we didn't write anything)
    const state = readInstallState(root);
    expect(state.files[skillPath]).toBe(shortHash(installedContent));
    // base_plugin_version DOES advance (server is up to date as of this round
    // for everything else — next round the customer can still receive new
    // *other* skills, just not this one until they revert)
    expect(state.base_plugin_version).toBe(SHA_NEW);

    // No mention of the skipped skill in any stdout output.
    const allOut = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(allOut).not.toContain('prd-generator');
    expect(allOut).not.toContain('customized');
    expect(allOut).not.toContain('skipped');
    writeSpy.mockRestore();
  });

  it('omits base sync entirely when server response has no base_* arrays (client up to date)', async () => {
    const root = tmpProject();
    seedState(root);

    // Pre-seed install-state so client sends a real version
    const initialState = readInstallState(root);
    initialState.base_plugin_version = SHA_NEW;
    const { writeInstallState } = await import('../../src/lib/install-state.js');
    writeInstallState(root, initialState);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        context_files: [],
        custom_skills: [],
        custom_agents: [],
        custom_workflows: [],
        base_plugin_version: SHA_NEW,
        // No base_skills / base_agents / base_workflows — server says we're current
        syncedAt: new Date().toISOString(),
      }),
    );

    const url = (fetchMock.mock.calls[0] ?? []) as unknown[];
    await runSync([], ctx(root));
    expect(url).toBeDefined();

    const sentUrl = (fetchMock.mock.calls[0] as [URL, RequestInit])[0];
    expect(sentUrl.searchParams.get('client_base_plugin_version')).toBe(SHA_NEW);

    const state = readInstallState(root);
    expect(state.base_plugin_version).toBe(SHA_NEW);
  });

  it('printSummary surfaces a single one-liner with /changelog link when base updates landed', async () => {
    const root = tmpProject();
    seedState(root);

    const skillPath = '.claude/skills/prd-generator/SKILL.md';
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        context_files: [],
        custom_skills: [],
        custom_agents: [],
        custom_workflows: [],
        base_plugin_version: SHA_NEW,
        base_skills: [{ file_path: skillPath, content: '# PRD', current_hash: shortHash('# PRD') }],
        syncedAt: new Date().toISOString(),
      }),
    );

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runSync([], ctx(root));
    const out = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();

    expect(out).toMatch(/1 skills updated/);
    expect(out).toContain('app.mysecond.ai/changelog');
  });

  it('graceful initialization: no install-state.json yet → first sync writes it without crashing', async () => {
    const root = tmpProject();
    seedState(root);

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        context_files: [],
        custom_skills: [],
        custom_agents: [],
        custom_workflows: [],
        base_plugin_version: SHA_NEW,
        syncedAt: new Date().toISOString(),
      }),
    );

    expect(existsSync(getInstallStatePath(root))).toBe(false);
    const code = await runSync([], ctx(root));
    expect(code).toBe(0);
    expect(existsSync(getInstallStatePath(root))).toBe(true);
  });
});
