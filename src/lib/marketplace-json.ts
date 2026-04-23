// Generate canonical local marketplace.json per EDD §6.7b.
// Schema verified empirically on Ron's Mac 2026-04-22 23:45 UTC (DV-1):
// `name + owner{name,email,url} + plugins[]` is the minimum that
// `claude plugin marketplace add` accepts non-interactively.

import { marketplaceName } from './mysecond-paths.js';

export interface MarketplaceJson {
  name: string;
  owner: {
    name: string;
    email: string;
    url: string;
  };
  plugins: Array<{ name: string; source: string }>;
}

const OWNER = {
  name: 'mySecond',
  email: 'support@mysecond.ai',
  url: 'https://mysecond.ai',
} as const;

export function buildMarketplaceJson(slug: string): MarketplaceJson {
  return {
    name: marketplaceName(slug),
    owner: { ...OWNER },
    plugins: [{ name: 'pm-os', source: './plugin' }],
  };
}

// Serialize with stable formatting so test snapshots are deterministic.
export function serializeMarketplaceJson(json: MarketplaceJson): string {
  return JSON.stringify(json, null, 2) + '\n';
}
