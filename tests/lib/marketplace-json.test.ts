import { describe, expect, it } from 'vitest';

import {
  buildMarketplaceJson,
  serializeMarketplaceJson,
} from '../../src/lib/marketplace-json.js';
import type { PluginEntry } from '../../src/lib/mysecond-paths.js';

const SAMPLE_PLUGINS: PluginEntry[] = [
  { name: 'pm-companion-sync', source: './plugin/companion-sync' },
  { name: 'pm-discovery', source: './plugin/discovery' },
  { name: 'pm-strategy', source: './plugin/strategy' },
];

describe('marketplace-json', () => {
  it('builds canonical schema with mysecond-customer- prefix', () => {
    const json = buildMarketplaceJson('acme-corp-a3f2', SAMPLE_PLUGINS);
    expect(json.name).toBe('mysecond-customer-acme-corp-a3f2');
  });

  it('includes required owner block per DV-1 verification', () => {
    const json = buildMarketplaceJson('test', SAMPLE_PLUGINS);
    expect(json.owner).toEqual({
      name: 'mySecond',
      email: 'support@mysecond.ai',
      url: 'https://mysecond.ai',
    });
  });

  it('passes plugins[] through unchanged (Workstream B Day 5+ multi-plugin)', () => {
    // Previously this synthesized [{name: 'pm-os', source: './plugin'}]
    // unconditionally — silently overwrote PMO's tarball-internal manifest.
    // Now it's a passthrough wrapper; caller (step-9) reads PMO's manifest
    // via listMarketplacePluginsFromExtractDir() and feeds it here.
    const json = buildMarketplaceJson('test', SAMPLE_PLUGINS);
    expect(json.plugins).toHaveLength(3);
    expect(json.plugins).toEqual(SAMPLE_PLUGINS);
  });

  it('handles a single-plugin manifest (back-compat)', () => {
    const single: PluginEntry[] = [{ name: 'pm-companion-sync', source: './plugin/companion-sync' }];
    const json = buildMarketplaceJson('test', single);
    expect(json.plugins).toEqual(single);
  });

  it('serializes with trailing newline + 2-space indent for stable diffs', () => {
    const out = serializeMarketplaceJson(buildMarketplaceJson('test', SAMPLE_PLUGINS));
    expect(out.endsWith('\n')).toBe(true);
    // Should be valid JSON.
    expect(() => JSON.parse(out)).not.toThrow();
    // Should round-trip.
    const reparsed = JSON.parse(out);
    expect(reparsed.name).toBe('mysecond-customer-test');
    expect(reparsed.plugins).toHaveLength(3);
  });
});
