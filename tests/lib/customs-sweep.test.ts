// selectCustomsToSync — the fail-closed customs sweep decision matrix.
//
// A custom is pushed ONLY when its content matches nothing the server is known
// to have for that path (install-state base hash, the context_files channel's
// last cloud/local hash, or a prior sweep push). A never-tracked file is a
// net-new local custom and IS pushed — except under an empty install-state,
// where un-recorded stock can't be told apart from a hand-authored custom, so
// it's skipped to avoid flooding context_files with the stock catalog.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { selectCustomsToSync } from '../../src/commands/sync.js';
import { shortHash } from '../../src/lib/files.js';
import type { InstallState } from '../../src/lib/install-state.js';
import type { SyncState } from '../../src/lib/sync-state.js';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'mysecond-customs-sweep-'));
}

function writeAgent(root: string, name: string, content: string): { path: string; hash: string } {
  mkdirSync(join(root, '.claude/agents'), { recursive: true });
  writeFileSync(join(root, `.claude/agents/${name}.md`), content);
  return { path: `.claude/agents/${name}.md`, hash: shortHash(content) };
}

function emptyState(): SyncState {
  return {
    files: {},
    artifacts: {},
    contextFiles: {},
    customs: {},
    lastSyncedAt: null,
    lastNpmUpdateAt: null,
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
}

function installWith(files: Record<string, string>): InstallState {
  return { base_plugin_version: 'sha', files };
}

function selectedPaths(root: string, state: SyncState, install: InstallState): string[] {
  return selectCustomsToSync(root, state, install).map((f) => f.file_path).sort();
}

describe('selectCustomsToSync', () => {
  it('pushes a net-new custom when install-state is populated (healthy install)', () => {
    const root = tmpProject();
    const cro = writeAgent(root, 'cro', '# CRO reviewer');
    // install-state non-empty (some unrelated stock recorded) → not cold.
    const install = installWith({ '.claude/skills/stock/SKILL.md': 'abc123abc123' });
    expect(selectedPaths(root, emptyState(), install)).toEqual([cro.path]);
  });

  it('SKIPS a never-tracked custom when install-state is EMPTY (cold-state flood guard)', () => {
    const root = tmpProject();
    writeAgent(root, 'cro', '# CRO reviewer');
    // Empty install-state: a not-tracked file could be un-recorded stock — skip.
    expect(selectedPaths(root, emptyState(), installWith({}))).toEqual([]);
  });

  it('SKIPS pristine stock (install-state hash matches current content)', () => {
    const root = tmpProject();
    const cto = writeAgent(root, 'cto', '# CTO reviewer (stock)');
    const install = installWith({ [cto.path]: cto.hash });
    expect(selectedPaths(root, emptyState(), install)).toEqual([]);
  });

  it('pushes a customer-modified stock file (install-state hash differs)', () => {
    const root = tmpProject();
    const cto = writeAgent(root, 'cto', '# CTO reviewer EDITED by the customer');
    // install-state recorded a DIFFERENT (original stock) hash for this path.
    const install = installWith({ [cto.path]: 'deadbeefdead' });
    expect(selectedPaths(root, emptyState(), install)).toEqual([cto.path]);
  });

  it('SKIPS a custom that just arrived via the context_files channel (state.files cloudHash matches)', () => {
    const root = tmpProject();
    const cro = writeAgent(root, 'cro', '# CRO from server');
    const state = emptyState();
    state.files[cro.path] = { localHash: cro.hash, cloudHash: cro.hash, lastSyncedAt: 'now' };
    // install-state non-empty so the cold guard isn't what's skipping it.
    const install = installWith({ '.claude/skills/stock/SKILL.md': 'x'.repeat(12) });
    expect(selectedPaths(root, state, install)).toEqual([]);
  });

  it('SKIPS a custom already pushed by a prior sweep (state.customs hash matches)', () => {
    const root = tmpProject();
    const cro = writeAgent(root, 'cro', '# CRO already pushed');
    const state = emptyState();
    state.customs[cro.path] = { hash: cro.hash, pushedAt: 'now' };
    const install = installWith({ '.claude/skills/stock/SKILL.md': 'x'.repeat(12) });
    expect(selectedPaths(root, state, install)).toEqual([]);
  });

  it('caps the untracked bucket — a flood-sized set of never-tracked customs is skipped (partial-state guard)', () => {
    const root = tmpProject();
    mkdirSync(join(root, '.claude/agents'), { recursive: true });
    for (let i = 0; i < 101; i++) {
      writeFileSync(join(root, `.claude/agents/a${i}.md`), `# agent ${i}`);
    }
    // install-state non-empty (some stock recorded) — so this is NOT the empty
    // cold guard; it's the >MAX_UNTRACKED count backstop against a partial-state
    // stock flood. None of the 101 untracked files should be selected.
    const install = installWith({ '.claude/skills/stock/SKILL.md': 'x'.repeat(12) });
    expect(selectedPaths(root, emptyState(), install)).toEqual([]);
  });

  it('still pushes a tracked EDIT even when the untracked bucket is flooded/capped', () => {
    const root = tmpProject();
    mkdirSync(join(root, '.claude/agents'), { recursive: true });
    for (let i = 0; i < 101; i++) {
      writeFileSync(join(root, `.claude/agents/a${i}.md`), `# agent ${i}`);
    }
    // A customer-edited stock file (tracked in install-state with a different
    // hash) must NOT be capped — edits are bounded by real customizations.
    const cto = writeAgent(root, 'cto', '# CTO edited');
    const install = installWith({
      '.claude/skills/stock/SKILL.md': 'x'.repeat(12),
      [cto.path]: 'origstockhash',
    });
    expect(selectedPaths(root, emptyState(), install)).toEqual([cto.path]);
  });

  it('pushes an EDIT to a context_files-channel custom (local content diverged from cloudHash)', () => {
    const root = tmpProject();
    const cro = writeAgent(root, 'cro', '# CRO locally edited after download');
    const state = emptyState();
    // The server's last-known hash is for the OLD content; local now differs.
    state.files[cro.path] = { localHash: 'oldhashold01', cloudHash: 'oldhashold01', lastSyncedAt: 'now' };
    const install = installWith({ '.claude/skills/stock/SKILL.md': 'x'.repeat(12) });
    expect(selectedPaths(root, state, install)).toEqual([cro.path]);
  });
});
