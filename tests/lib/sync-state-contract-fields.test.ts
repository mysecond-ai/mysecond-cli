import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { projectPaths } from '../../src/lib/files.js';
import { readSyncState, writeSyncState } from '../../src/lib/sync-state.js';

describe('sync-state contract-version fields (back-compat + round-trip)', () => {
  it('defaults new fields to null when reading an old-shape state file', () => {
    const root = mkdtempSync(join(tmpdir(), 'mysecond-ss-'));
    const p = projectPaths(root).syncStatePath;
    mkdirSync(dirname(p), { recursive: true });
    // Old file with NO installedPluginContractVersion / lastPluginRefreshPromptAt.
    writeFileSync(
      p,
      JSON.stringify({ customerSlug: 'acme', installedPluginVersion: '1.123.0' })
    );

    const s = readSyncState(root);
    expect(s.installedPluginContractVersion).toBeNull();
    expect(s.lastPluginRefreshPromptAt).toBeNull();
    // Existing fields still read through.
    expect(s.customerSlug).toBe('acme');
    expect(s.installedPluginVersion).toBe('1.123.0');
  });

  it('round-trips the new fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'mysecond-ss-'));
    const s = readSyncState(root);
    s.installedPluginContractVersion = '2';
    s.lastPluginRefreshPromptAt = '2026-05-29T00:00:00.000Z';
    writeSyncState(root, s);

    const back = readSyncState(root);
    expect(back.installedPluginContractVersion).toBe('2');
    expect(back.lastPluginRefreshPromptAt).toBe('2026-05-29T00:00:00.000Z');
  });
});
