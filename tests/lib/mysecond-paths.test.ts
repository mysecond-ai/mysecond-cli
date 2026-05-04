import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  installedPluginManifestPath,
  listMarketplacePluginsFromExtractDir,
  isForbiddenProjectDir,
  marketplaceDir,
  marketplaceJsonPath,
  marketplaceName,
  marketplacesRoot,
  marketplaceTmpDir,
  mysecondHome,
  pluginInstallSpec,
} from '../../src/lib/mysecond-paths.js';

describe('mysecond-paths (Decision 0-C cross-platform path handling)', () => {
  it('mysecondHome resolves to ~/.mysecond via os.homedir + path.join', () => {
    expect(mysecondHome()).toBe(join(homedir(), '.mysecond'));
  });

  it('marketplacesRoot is parent of all customer marketplaces', () => {
    expect(marketplacesRoot()).toBe(join(homedir(), '.mysecond', 'marketplaces'));
  });

  it('marketplaceDir uses customer-{slug} naming (no mysecond- prefix on local dir)', () => {
    expect(marketplaceDir('acme-a3f2')).toBe(
      join(homedir(), '.mysecond', 'marketplaces', 'customer-acme-a3f2')
    );
  });

  it('marketplaceTmpDir suffixes with .tmp-{pid} for atomic-rename pattern', () => {
    const path = marketplaceTmpDir('acme', 12345);
    expect(path).toContain('customer-acme.tmp-12345');
  });

  it('marketplaceJsonPath nested under .claude-plugin/ leading-dot dir', () => {
    expect(marketplaceJsonPath('acme')).toBe(
      join(homedir(), '.mysecond', 'marketplaces', 'customer-acme', '.claude-plugin', 'marketplace.json')
    );
  });

  it('marketplaceName uses mysecond-customer- prefix per §6.7b (CAIO P0-2 fix)', () => {
    expect(marketplaceName('acme-a3f2')).toBe('mysecond-customer-acme-a3f2');
  });

  it('pluginInstallSpec uses mysecond-customer- prefix + parameterized plugin name (Workstream B Day 5+ multi-plugin)', () => {
    expect(pluginInstallSpec('acme-a3f2', 'pm-companion-sync')).toBe(
      'pm-companion-sync@mysecond-customer-acme-a3f2'
    );
    expect(pluginInstallSpec('acme-a3f2', 'pm-strategy')).toBe(
      'pm-strategy@mysecond-customer-acme-a3f2'
    );
  });

  it('installedPluginManifestPath uses marketplace-name + parameterized plugin segment (Workstream B Day 5+)', () => {
    // DV-2 captured: `~/.claude/plugins/cache/<marketplace-name>/<plugin-name>/<version>/.claude-plugin/plugin.json`
    // PMO restructured to multi-plugin marketplace; sentinel is now pm-companion-sync.
    expect(installedPluginManifestPath('acme', '1.0.0', 'pm-companion-sync')).toBe(
      join(
        homedir(),
        '.claude',
        'plugins',
        'cache',
        'mysecond-customer-acme',
        'pm-companion-sync',
        '1.0.0',
        '.claude-plugin',
        'plugin.json'
      )
    );
  });

  it('installedPluginManifestPath defaults to sentinel plugin when name omitted', () => {
    // Default arg = SENTINEL_PLUGIN_NAME = pm-companion-sync.
    expect(installedPluginManifestPath('acme', '1.0.0')).toBe(
      join(
        homedir(),
        '.claude',
        'plugins',
        'cache',
        'mysecond-customer-acme',
        'pm-companion-sync',
        '1.0.0',
        '.claude-plugin',
        'plugin.json'
      )
    );
  });

  it('isForbiddenProjectDir rejects /, /etc, ~/.ssh, ~/.claude, ~/.mysecond', () => {
    expect(isForbiddenProjectDir('/')).toBe(true);
    expect(isForbiddenProjectDir('/etc')).toBe(true);
    expect(isForbiddenProjectDir('/System')).toBe(true);
    expect(isForbiddenProjectDir(join(homedir(), '.ssh'))).toBe(true);
    expect(isForbiddenProjectDir(join(homedir(), '.claude'))).toBe(true);
    expect(isForbiddenProjectDir(join(homedir(), '.mysecond'))).toBe(true);
  });

  it('isForbiddenProjectDir allows normal paths', () => {
    expect(isForbiddenProjectDir('/tmp/foo')).toBe(false);
    expect(isForbiddenProjectDir(join(homedir(), 'projects', 'my-pm-os'))).toBe(false);
  });
});

describe('listMarketplacePluginsFromExtractDir (Workstream B Day 5+ multi-plugin)', () => {
  // Each test creates a tmpdir, writes a fixture marketplace.json, and
  // verifies the helper transforms PMO's source paths into the cli's
  // outer marketplace dir layout.
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'mysecond-test-'));
    mkdirSync(join(tmpRoot, '.claude-plugin'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reads PMO manifest + transforms source paths to cli layout', () => {
    writeFileSync(
      join(tmpRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'product-manager-os',
        plugins: [
          { name: 'pm-companion-sync', source: './companion-sync' },
          { name: 'pm-discovery', source: './discovery' },
        ],
      })
    );

    const out = listMarketplacePluginsFromExtractDir(tmpRoot);
    expect(out).toEqual([
      { name: 'pm-companion-sync', source: './plugin/companion-sync' },
      { name: 'pm-discovery', source: './plugin/discovery' },
    ]);
  });

  it('handles source paths without leading ./', () => {
    writeFileSync(
      join(tmpRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'product-manager-os',
        plugins: [{ name: 'pm-foo', source: 'foo' }],
      })
    );

    const out = listMarketplacePluginsFromExtractDir(tmpRoot);
    expect(out).toEqual([{ name: 'pm-foo', source: './plugin/foo' }]);
  });

  it('throws if marketplace.json is missing', () => {
    // No file written.
    expect(() => listMarketplacePluginsFromExtractDir(tmpRoot)).toThrow();
  });

  it('throws if plugins[] is missing or empty', () => {
    writeFileSync(
      join(tmpRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'product-manager-os', plugins: [] })
    );
    expect(() => listMarketplacePluginsFromExtractDir(tmpRoot)).toThrow(/no plugins/);
  });

  it('throws if marketplace.json is malformed JSON', () => {
    writeFileSync(join(tmpRoot, '.claude-plugin', 'marketplace.json'), 'not-json{');
    expect(() => listMarketplacePluginsFromExtractDir(tmpRoot)).toThrow();
  });

  it('filters out malformed plugin entries (missing name or source)', () => {
    writeFileSync(
      join(tmpRoot, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'product-manager-os',
        plugins: [
          { name: 'pm-good', source: './good' },
          { name: 'pm-no-source' }, // missing source
          { source: './no-name' }, // missing name
          null, // null entry
        ],
      })
    );
    const out = listMarketplacePluginsFromExtractDir(tmpRoot);
    expect(out).toEqual([{ name: 'pm-good', source: './plugin/good' }]);
  });
});
