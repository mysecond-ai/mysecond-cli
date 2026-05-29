// Tests for the installedPluginVersion field (back-compat) and updateSyncState
// (Codex blocking #4 — safe concurrent writes). The realtime fix adds a second
// hot writer (Stop `sync --push-only`) alongside PostToolUse `artifact-sync`;
// both go through updateSyncState, which locks + re-reads so neither clobbers
// the other's whole-file replacement.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readSyncState, updateSyncState, writeSyncState } from '../../src/lib/sync-state.js';

function tmpProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'mysecond-state-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  return root;
}

describe('sync-state: installedPluginVersion back-compat', () => {
  it('defaults installedPluginVersion to null for a pre-feature state file', () => {
    const root = tmpProject();
    writeFileSync(
      join(root, '.claude/sync-state.json'),
      JSON.stringify({ customerSlug: 'acme', lastSyncedAt: 'x' }),
    );
    const s = readSyncState(root);
    expect(s.installedPluginVersion).toBeNull();
    expect(s.customerSlug).toBe('acme');
  });
});

describe('updateSyncState (locked read-modify-write)', () => {
  it('merges a field without dropping existing keys', async () => {
    const root = tmpProject();
    const s = readSyncState(root);
    s.customerSlug = 'acme';
    s.artifacts = { 'a.md': { hash: 'h1', pushedAt: 't' } };
    writeSyncState(root, s);

    await updateSyncState(root, (st) => {
      st.installedPluginVersion = '1.2.0';
    });

    const out = readSyncState(root);
    expect(out.installedPluginVersion).toBe('1.2.0');
    expect(out.customerSlug).toBe('acme');
    expect(out.artifacts['a.md']).toBeTruthy();
  });

  it('creates the state file when none exists yet', async () => {
    const root = tmpProject();
    await updateSyncState(root, (st) => {
      st.installedPluginVersion = '9.9.9';
    });
    expect(readSyncState(root).installedPluginVersion).toBe('9.9.9');
  });

  it('concurrent calls do not clobber each other (Codex #4)', async () => {
    const root = tmpProject();
    writeSyncState(root, readSyncState(root));

    await Promise.all([
      updateSyncState(root, (st) => {
        st.artifacts['x.md'] = { hash: 'hx', pushedAt: 't' };
      }),
      updateSyncState(root, (st) => {
        st.contextFiles['y.md'] = { hash: 'hy', pushedAt: 't' };
      }),
    ]);

    const out = readSyncState(root);
    // Both writers' keys survive — the lock + re-read prevented a whole-file
    // overwrite from dropping the other's mutation.
    expect(out.artifacts['x.md']).toBeTruthy();
    expect(out.contextFiles['y.md']).toBeTruthy();
  });
});
