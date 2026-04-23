import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  installedPluginManifestPath,
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

  it('pluginInstallSpec uses mysecond-customer- prefix per CAIO P0-2 fix', () => {
    expect(pluginInstallSpec('acme-a3f2')).toBe('pm-os@mysecond-customer-acme-a3f2');
  });

  it('installedPluginManifestPath uses marketplace-name path segment per DV-2', () => {
    // DV-2 captured: `~/.claude/plugins/cache/<marketplace-name>/pm-os/<version>/.claude-plugin/plugin.json`
    expect(installedPluginManifestPath('acme', '1.0.0')).toBe(
      join(
        homedir(),
        '.claude',
        'plugins',
        'cache',
        'mysecond-customer-acme',
        'pm-os',
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
