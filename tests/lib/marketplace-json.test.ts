import { describe, expect, it } from 'vitest';

import {
  buildMarketplaceJson,
  serializeMarketplaceJson,
} from '../../src/lib/marketplace-json.js';

describe('marketplace-json', () => {
  it('builds canonical schema with mysecond-customer- prefix', () => {
    const json = buildMarketplaceJson('acme-corp-a3f2');
    expect(json.name).toBe('mysecond-customer-acme-corp-a3f2');
  });

  it('includes required owner block per DV-1 verification', () => {
    const json = buildMarketplaceJson('test');
    expect(json.owner).toEqual({
      name: 'mySecond',
      email: 'support@mysecond.ai',
      url: 'https://mysecond.ai',
    });
  });

  it('declares pm-os plugin with relative ./plugin source per §6.7b', () => {
    const json = buildMarketplaceJson('test');
    expect(json.plugins).toHaveLength(1);
    expect(json.plugins[0]).toEqual({ name: 'pm-os', source: './plugin' });
  });

  it('serializes with trailing newline + 2-space indent for stable diffs', () => {
    const out = serializeMarketplaceJson(buildMarketplaceJson('test'));
    expect(out.endsWith('\n')).toBe(true);
    // Should be valid JSON.
    expect(() => JSON.parse(out)).not.toThrow();
    // Should round-trip.
    const reparsed = JSON.parse(out);
    expect(reparsed.name).toBe('mysecond-customer-test');
  });
});
