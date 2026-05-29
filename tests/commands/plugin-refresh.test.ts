// Tests for `mysecond plugin-refresh` (runPluginRefresh) — the existing-customer
// delivery path. Verifies version-gating, the null→refresh-once self-heal,
// version persistence on success, and that EVERY failure mode is degradable
// (exit 0, installed version not advanced, working install left intact).
//
// All filesystem + network + spawn boundaries are mocked; marketplace path
// builders are redirected to a per-test temp dir so nothing touches ~/.mysecond.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  pluginTarball: vi.fn(),
  fetchAndExtractPlugin: vi.fn(),
  listPlugins: vi.fn(),
  registerMarketplaceAndInstall: vi.fn(),
  cacheLastKnownGood: vi.fn(),
  atomicRenameDir: vi.fn(),
  marketplaceDir: vi.fn(),
  marketplaceTmpDir: vi.fn(),
  marketplaceTmpJsonPath: vi.fn(),
  pluginTmpExtractDir: vi.fn(),
}));

vi.mock('../../src/lib/api.js', () => ({ pluginTarball: h.pluginTarball }));
vi.mock('../../src/lib/plugin-tarball.js', () => ({ fetchAndExtractPlugin: h.fetchAndExtractPlugin }));
vi.mock('../../src/lib/plugin-register.js', () => ({
  registerMarketplaceAndInstall: h.registerMarketplaceAndInstall,
}));
vi.mock('../../src/lib/last-known-good.js', () => ({ cacheLastKnownGood: h.cacheLastKnownGood }));
vi.mock('../../src/lib/marketplace-lock.js', () => ({
  acquireMarketplaceLock: vi.fn(async () => ({ release: vi.fn(async () => {}) })),
}));
vi.mock('../../src/lib/mysecond-paths.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    listMarketplacePluginsFromExtractDir: h.listPlugins,
    marketplaceDir: h.marketplaceDir,
    marketplaceTmpDir: h.marketplaceTmpDir,
    marketplaceTmpJsonPath: h.marketplaceTmpJsonPath,
    pluginTmpExtractDir: h.pluginTmpExtractDir,
  };
});
vi.mock('../../src/lib/atomic-write.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, atomicRenameDir: h.atomicRenameDir };
});

import { runPluginRefresh } from '../../src/commands/plugin-refresh.js';
import { readSyncState, writeSyncState } from '../../src/lib/sync-state.js';
import type { CommandContext } from '../../src/lib/context.js';

function tmpProject(slug: string | null = 'acme', installedVersion: string | null = null): string {
  const root = mkdtempSync(join(tmpdir(), 'mysecond-refresh-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  const state = readSyncState(root);
  state.customerSlug = slug;
  state.installedPluginVersion = installedVersion;
  writeSyncState(root, state);
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
    pushOnly: false,
    strategy: 'cloud-wins',
    ...overrides,
  };
}

let mpDir: string;

beforeEach(() => {
  for (const fn of [
    h.pluginTarball,
    h.fetchAndExtractPlugin,
    h.listPlugins,
    h.registerMarketplaceAndInstall,
    h.cacheLastKnownGood,
    h.atomicRenameDir,
  ]) {
    fn.mockReset();
  }
  h.fetchAndExtractPlugin.mockResolvedValue(undefined);
  h.listPlugins.mockReturnValue([{ name: 'pm-os' }]);
  h.atomicRenameDir.mockReturnValue(undefined);

  // Redirect all marketplace paths into a fresh temp dir.
  mpDir = mkdtempSync(join(tmpdir(), 'mysecond-mp-'));
  h.marketplaceDir.mockReturnValue(join(mpDir, 'customer'));
  h.marketplaceTmpDir.mockReturnValue(join(mpDir, 'customer.tmp'));
  h.marketplaceTmpJsonPath.mockReturnValue(join(mpDir, 'customer.tmp', '.claude-plugin', 'marketplace.json'));
  h.pluginTmpExtractDir.mockReturnValue(join(mpDir, 'customer.tmp', 'plugin'));
});

afterEach(() => {
  rmSync(mpDir, { recursive: true, force: true });
});

describe('mysecond plugin-refresh', () => {
  it('no-op when already at the latest version (no re-install)', async () => {
    const root = tmpProject('acme', '1.100.0');
    h.pluginTarball.mockResolvedValue({ version: '1.100.0', sha256: 'abc' });
    const code = await runPluginRefresh([], ctx(root));
    expect(code).toBe(0);
    expect(h.registerMarketplaceAndInstall).not.toHaveBeenCalled();
    expect(readSyncState(root).installedPluginVersion).toBe('1.100.0');
  });

  it('refreshes when a newer version is available and persists the installed version', async () => {
    const root = tmpProject('acme', '1.100.0');
    h.pluginTarball.mockResolvedValue({ version: '1.200.0', sha256: 'abc' });
    h.registerMarketplaceAndInstall.mockReturnValue({ outcome: { kind: 'registered' }, failedPlugins: [] });
    const code = await runPluginRefresh([], ctx(root));
    expect(code).toBe(0);
    expect(h.registerMarketplaceAndInstall).toHaveBeenCalledOnce();
    expect(readSyncState(root).installedPluginVersion).toBe('1.200.0');
  });

  it('self-heals: a null installedPluginVersion always refreshes once', async () => {
    const root = tmpProject('acme', null);
    h.pluginTarball.mockResolvedValue({ version: '1.200.0', sha256: 'abc' });
    h.registerMarketplaceAndInstall.mockReturnValue({ outcome: { kind: 'registered' }, failedPlugins: [] });
    await runPluginRefresh([], ctx(root));
    expect(h.registerMarketplaceAndInstall).toHaveBeenCalledOnce();
    expect(readSyncState(root).installedPluginVersion).toBe('1.200.0');
  });

  it('--force-update re-installs even when the version already matches', async () => {
    const root = tmpProject('acme', '1.100.0');
    h.pluginTarball.mockResolvedValue({ version: '1.100.0', sha256: 'abc' });
    h.registerMarketplaceAndInstall.mockReturnValue({ outcome: { kind: 'registered' }, failedPlugins: [] });
    await runPluginRefresh([], ctx(root, { forceUpdate: true }));
    expect(h.registerMarketplaceAndInstall).toHaveBeenCalledOnce();
  });

  it('degradable: register binary_not_found → exit 0, version NOT advanced', async () => {
    const root = tmpProject('acme', '1.100.0');
    h.pluginTarball.mockResolvedValue({ version: '1.200.0', sha256: 'abc' });
    h.registerMarketplaceAndInstall.mockReturnValue({ outcome: { kind: 'binary_not_found' }, failedPlugins: [] });
    const code = await runPluginRefresh([], ctx(root));
    expect(code).toBe(0);
    expect(readSyncState(root).installedPluginVersion).toBe('1.100.0');
  });

  it('degradable: download failure → exit 0, no register, version unchanged', async () => {
    const root = tmpProject('acme', '1.100.0');
    h.pluginTarball.mockResolvedValue({ version: '1.200.0', sha256: 'abc' });
    h.fetchAndExtractPlugin.mockRejectedValue(new Error('sha mismatch'));
    const code = await runPluginRefresh([], ctx(root));
    expect(code).toBe(0);
    expect(h.registerMarketplaceAndInstall).not.toHaveBeenCalled();
    expect(readSyncState(root).installedPluginVersion).toBe('1.100.0');
  });

  it('exit 0 with no register when the version check (pluginTarball) throws', async () => {
    const root = tmpProject('acme', '1.100.0');
    h.pluginTarball.mockRejectedValue(new Error('network'));
    const code = await runPluginRefresh([], ctx(root));
    expect(code).toBe(0);
    expect(h.registerMarketplaceAndInstall).not.toHaveBeenCalled();
  });

  it('exit 0 + no network call when there is no customer slug', async () => {
    const root = tmpProject(null, null);
    const code = await runPluginRefresh([], ctx(root));
    expect(code).toBe(0);
    expect(h.pluginTarball).not.toHaveBeenCalled();
  });

  it('exit 0 + no network call when not authenticated', async () => {
    const root = tmpProject('acme', null);
    const code = await runPluginRefresh([], ctx(root, { apiKey: '' }));
    expect(code).toBe(0);
    expect(h.pluginTarball).not.toHaveBeenCalled();
  });
});
