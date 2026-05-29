import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { readInstalledPluginContractVersion } from '../../src/lib/plugin-meta.js';

describe('readInstalledPluginContractVersion', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mysecond-meta-'));
  });

  it('reads plugin_contract_version from _meta.json', () => {
    writeFileSync(
      join(dir, '_meta.json'),
      JSON.stringify({ schema_version: '1.1', plugin_contract_version: '2' })
    );
    expect(readInstalledPluginContractVersion(dir)).toBe('2');
  });

  it('returns null when _meta.json is missing', () => {
    expect(readInstalledPluginContractVersion(dir)).toBeNull();
  });

  it('returns null when the field is absent (old tarball, pre-feature)', () => {
    writeFileSync(join(dir, '_meta.json'), JSON.stringify({ schema_version: '1.1' }));
    expect(readInstalledPluginContractVersion(dir)).toBeNull();
  });

  it('returns null on a blank or non-string field', () => {
    writeFileSync(join(dir, '_meta.json'), JSON.stringify({ plugin_contract_version: '' }));
    expect(readInstalledPluginContractVersion(dir)).toBeNull();
    writeFileSync(join(dir, '_meta.json'), JSON.stringify({ plugin_contract_version: 2 }));
    expect(readInstalledPluginContractVersion(dir)).toBeNull();
  });

  it('returns null on malformed JSON (never throws)', () => {
    writeFileSync(join(dir, '_meta.json'), 'not json{');
    expect(readInstalledPluginContractVersion(dir)).toBeNull();
  });
});
