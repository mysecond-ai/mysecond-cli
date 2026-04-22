import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveConflict } from '../../src/lib/conflict.js';
import type { CommandContext } from '../../src/lib/context.js';
import { sha256, writeLocalFile } from '../../src/lib/files.js';
import type { ContextFile } from '../../src/lib/payload.js';
import type { SyncState } from '../../src/lib/sync-state.js';

function tmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'mysecond-conflict-'));
}

function ctx(rootDir: string, overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    apiBase: 'https://app.mysecond.ai',
    apiKey: 'k',
    rootDir,
    silent: false,
    dryRun: false,
    forceUpdate: false,
    strategy: 'cloud-wins',
    ...overrides,
  };
}

function emptyState(): SyncState {
  return { files: {}, artifacts: {}, lastSyncedAt: null, lastNpmUpdateAt: null };
}

function file(filePath: string, content: string): ContextFile {
  return { file_path: filePath, content, current_hash: sha256(content) };
}

describe('resolveConflict — first-time create', () => {
  it('writes cloud version when local is missing', () => {
    const root = tmpProject();
    const state = emptyState();
    const outcome = resolveConflict({
      file: file('company.md', 'hello'),
      localContent: null,
      syncState: state,
      ctx: ctx(root),
    });
    expect(outcome.kind).toBe('created');
    expect(readFileSync(join(root, 'context/company.md'), 'utf8')).toBe('hello');
    expect(state.files['company.md']).toBeDefined();
  });
});

describe('resolveConflict — no divergence', () => {
  it('reports unchanged when local + cloud match a recorded hash', () => {
    const root = tmpProject();
    writeLocalFile(join(root, 'context'), 'company.md', 'hello');
    const state = emptyState();
    state.files['company.md'] = {
      localHash: sha256('hello'),
      cloudHash: sha256('hello'),
      lastSyncedAt: new Date().toISOString(),
    };
    const outcome = resolveConflict({
      file: file('company.md', 'hello'),
      localContent: 'hello',
      syncState: state,
      ctx: ctx(root),
    });
    expect(outcome.kind).toBe('unchanged');
  });
});

describe('resolveConflict — only cloud changed', () => {
  it('overwrites local with cloud version', () => {
    const root = tmpProject();
    writeLocalFile(join(root, 'context'), 'company.md', 'old');
    const state = emptyState();
    state.files['company.md'] = {
      localHash: sha256('old'),
      cloudHash: sha256('old'),
      lastSyncedAt: new Date().toISOString(),
    };
    const outcome = resolveConflict({
      file: file('company.md', 'new-cloud'),
      localContent: 'old',
      syncState: state,
      ctx: ctx(root),
    });
    expect(outcome.kind).toBe('updated-from-cloud');
    expect(readFileSync(join(root, 'context/company.md'), 'utf8')).toBe('new-cloud');
  });
});

describe('resolveConflict — only local changed', () => {
  it('keeps local untouched and updates the ledger', () => {
    const root = tmpProject();
    writeLocalFile(join(root, 'context'), 'company.md', 'local-edit');
    const state = emptyState();
    state.files['company.md'] = {
      localHash: sha256('original'),
      cloudHash: sha256('original'),
      lastSyncedAt: new Date().toISOString(),
    };
    const outcome = resolveConflict({
      file: file('company.md', 'original'),
      localContent: 'local-edit',
      syncState: state,
      ctx: ctx(root),
    });
    expect(outcome.kind).toBe('kept-local');
    expect(readFileSync(join(root, 'context/company.md'), 'utf8')).toBe('local-edit');
  });
});

describe('resolveConflict — both changed (Option 1 minimum safety net)', () => {
  it('cloud-wins strategy: writes cloud, backs up local, returns conflict-cloud-kept', () => {
    const root = tmpProject();
    writeLocalFile(join(root, 'context'), 'company.md', 'local-edit');
    const state = emptyState();
    state.files['company.md'] = {
      localHash: sha256('original'),
      cloudHash: sha256('original'),
      lastSyncedAt: new Date().toISOString(),
    };
    const outcome = resolveConflict({
      file: file('company.md', 'cloud-edit'),
      localContent: 'local-edit',
      syncState: state,
      ctx: ctx(root, { strategy: 'cloud-wins' }),
    });
    expect(outcome.kind).toBe('conflict-cloud-kept');

    // Local file now contains cloud version
    expect(readFileSync(join(root, 'context/company.md'), 'utf8')).toBe('cloud-edit');

    // Backup file exists in .claude/sync-conflicts/ with the local content
    const backups = readdirSync(join(root, '.claude/sync-conflicts'));
    const localBackup = backups.find((f) => f.includes('-local-'));
    expect(localBackup).toBeDefined();
    expect(readFileSync(join(root, '.claude/sync-conflicts', localBackup!), 'utf8')).toBe(
      'local-edit'
    );
  });

  it('local-wins strategy: keeps local, backs up cloud, returns conflict-local-kept', () => {
    const root = tmpProject();
    writeLocalFile(join(root, 'context'), 'company.md', 'local-edit');
    const state = emptyState();
    state.files['company.md'] = {
      localHash: sha256('original'),
      cloudHash: sha256('original'),
      lastSyncedAt: new Date().toISOString(),
    };
    const outcome = resolveConflict({
      file: file('company.md', 'cloud-edit'),
      localContent: 'local-edit',
      syncState: state,
      ctx: ctx(root, { strategy: 'local-wins' }),
    });
    expect(outcome.kind).toBe('conflict-local-kept');
    expect(readFileSync(join(root, 'context/company.md'), 'utf8')).toBe('local-edit');

    const backups = readdirSync(join(root, '.claude/sync-conflicts'));
    const cloudBackup = backups.find((f) => f.includes('-cloud-'));
    expect(cloudBackup).toBeDefined();
  });

  it('skip strategy: leaves local alone, only saves cloud version for inspection', () => {
    const root = tmpProject();
    writeLocalFile(join(root, 'context'), 'company.md', 'local-edit');
    const state = emptyState();
    state.files['company.md'] = {
      localHash: sha256('original'),
      cloudHash: sha256('original'),
      lastSyncedAt: new Date().toISOString(),
    };
    const outcome = resolveConflict({
      file: file('company.md', 'cloud-edit'),
      localContent: 'local-edit',
      syncState: state,
      ctx: ctx(root, { strategy: 'skip' }),
    });
    expect(outcome.kind).toBe('conflict-skipped');
    expect(readFileSync(join(root, 'context/company.md'), 'utf8')).toBe('local-edit');
  });
});
