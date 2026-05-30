// End-to-end wiring test for the plugin-refresh nudge. Drives the REAL runSync
// with a mocked cli-sync response and asserts the two things unit tests of the
// nudge function alone CANNOT cover — the exact gaps that let the first version
// ship invisible:
//   (a) sync.ts plumbs sync-state.installedPluginContractVersion → the cli-sync
//       query param (the report-up), and
//   (b) the nudge actually reaches STDOUT (the SessionStart context Claude
//       relays) — NOT stderr (which Claude Code silently drops on exit 0).
//
// Mirrors tests/commands/base-sync.test.ts (same runSync + fetch-mock + $HOME
// redirect harness), in silent mode (which is how the SessionStart hook runs).

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runSync } from '../../src/commands/sync.js';
import type { CommandContext } from '../../src/lib/context.js';
import { sha256 } from '../../src/lib/files.js';
import { writeSyncState, type SyncState } from '../../src/lib/sync-state.js';

function tmpProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'mysecond-sync-nudge-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  return root;
}

function ctx(rootDir: string): CommandContext {
  return {
    apiBase: 'https://app.mysecond.ai',
    apiKey: 'test-key',
    rootDir,
    silent: true, // silent === the SessionStart hook context
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
    lastNpmUpdateAt: new Date().toISOString(), // skip the npm registry probe
    initCompletedSteps: [],
    step9Auth401RetryCount: 0,
    customerId: null,
    workspaceScope: null,
    customerSlug: null,
    lastKnownLatestNpmVersion: null,
    lastUpgradePromptAt: null,
    lastClaudeBinPath: null,
    installedPluginVersion: null,
    installedPluginContractVersion: null,
    lastPluginRefreshPromptAt: null,
  };
  writeSyncState(rootDir, { ...base, ...partial });
}

function cliSyncBody(extra: Record<string, unknown>) {
  return {
    context_files: [],
    custom_skills: [],
    custom_agents: [],
    custom_workflows: [],
    base_plugin_version: 'b'.repeat(40),
    syncedAt: new Date().toISOString(),
    ...extra,
  };
}

describe('plugin-refresh nudge — end-to-end via runSync', () => {
  let originalFetch: typeof fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalHome: string | undefined;
  let stdoutBuf: string;
  let origStdout: typeof process.stdout.write;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    originalHome = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), 'mysecond-sync-nudge-home-'));
    stdoutBuf = '';
    origStdout = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = ((c: string | Uint8Array) => {
      stdoutBuf += typeof c === 'string' ? c : c.toString();
      return true;
    }) as typeof process.stdout.write;
    delete process.env.MYSECOND_NO_UPGRADE_NAG;
    delete process.env.MYSECOND_FORCE_REFRESH_NUDGE;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.stdout.write = origStdout;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('reports the installed contract version AND emits the nudge when the server reports a newer one', async () => {
    const root = tmpProject();
    seedState(root, { installedPluginContractVersion: '1' });
    fetchMock.mockResolvedValueOnce(
      jsonResponse(cliSyncBody({ latest_plugin_contract_version: '2' })),
    );

    await runSync([], ctx(root));

    // (a) wiring: sync.ts plumbed sync-state → the cli-sync query param.
    const url = (fetchMock.mock.calls[0] as [URL, RequestInit])[0];
    expect(url.pathname).toBe('/api/companion/cli-sync');
    expect(url.searchParams.get('client_plugin_contract_version')).toBe('1');
    // (b) the nudge is emitted in the SessionStart hook JSON's top-level
    // `systemMessage` — the ONLY channel Claude Code renders directly to the user
    // (plain stdout → additionalContext, which the user never reliably sees).
    const out = JSON.parse(stdoutBuf.trim()) as {
      systemMessage?: string;
      hookSpecificOutput?: { hookEventName?: string };
    };
    expect(out.hookSpecificOutput?.hookEventName).toBe('SessionStart');
    expect(out.systemMessage).toContain('an update to your PM OS is ready');
    expect(out.systemMessage).toContain('plugin-refresh --force-update');
  });

  it('stays silent when already on the latest contract version', async () => {
    const root = tmpProject();
    seedState(root, { installedPluginContractVersion: '2' });
    fetchMock.mockResolvedValueOnce(
      jsonResponse(cliSyncBody({ latest_plugin_contract_version: '2' })),
    );

    await runSync([], ctx(root));
    expect(stdoutBuf).not.toContain('an update to your PM OS is ready');
  });

  it('stays silent against an old app that returns no contract version', async () => {
    const root = tmpProject();
    seedState(root, { installedPluginContractVersion: '1' });
    fetchMock.mockResolvedValueOnce(jsonResponse(cliSyncBody({})));

    await runSync([], ctx(root));
    expect(stdoutBuf).not.toContain('an update to your PM OS is ready');
  });

  // Regression (Codex P2): a conflict notice must NOT corrupt the single hook
  // JSON object the nudge rides in. In silent mode resolveConflict used to write
  // the notice to stdout directly; combined with printSummary's JSON that left
  // stdout unparseable, so Claude Code dropped the top-level systemMessage and
  // the nudge went invisible again — but ONLY for customers who also hit a
  // conflict. The notice is now folded into additionalContext; stdout stays one
  // JSON object and the nudge survives.
  it('keeps stdout a single JSON object (nudge in systemMessage) when a conflict co-occurs', async () => {
    const root = tmpProject();
    // A local context file that diverged from the cloud since the last sync.
    mkdirSync(join(root, 'context'), { recursive: true });
    writeFileSync(join(root, 'context/company.md'), 'LOCAL EDIT', 'utf8');
    // sync-state records an older baseline for BOTH sides, so the incoming cloud
    // version (different hash) + the touched local file = a real conflict.
    seedState(root, {
      installedPluginContractVersion: '1',
      files: {
        'context/company.md': {
          localHash: sha256('OLD'),
          cloudHash: sha256('OLD'),
          lastSyncedAt: '2026-04-29T00:00:00.000Z',
        },
      },
    });
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        cliSyncBody({
          latest_plugin_contract_version: '2',
          context_files: [
            {
              file_path: 'context/company.md',
              content: 'CLOUD EDIT',
              current_hash: sha256('CLOUD EDIT'),
            },
          ],
        }),
      ),
    );

    await runSync([], ctx(root)); // ctx() default strategy is cloud-wins

    // stdout must be exactly ONE parseable JSON object — JSON.parse throws if a
    // plain-text conflict line leaked onto stdout ahead of the hook payload.
    const out = JSON.parse(stdoutBuf.trim()) as {
      systemMessage?: string;
      hookSpecificOutput?: { additionalContext?: string };
    };
    // The nudge survived in the user-visible channel...
    expect(out.systemMessage).toContain('an update to your PM OS is ready');
    // ...and the conflict notice rode along in the model-facing channel (its
    // pre-refactor audience), NOT on raw stdout.
    expect(out.hookSpecificOutput?.additionalContext).toContain(
      'Conflict in context/company.md',
    );
  });
});
