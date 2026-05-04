// Generate canonical local marketplace.json per EDD §6.7b.
// Schema verified empirically on Ron's Mac 2026-04-22 23:45 UTC (DV-1):
// `name + owner{name,email,url} + plugins[]` is the minimum that
// `claude plugin marketplace add` accepts non-interactively.

import { marketplaceName, type PluginEntry } from './mysecond-paths.js';

export interface MarketplaceJson {
  name: string;
  owner: {
    name: string;
    email: string;
    url: string;
  };
  // RED-TEAM R2 P0-B: metadata.description prevents `claude plugin marketplace
  // add` from emitting a "No marketplace description provided" warning to
  // stderr. The warning lands on the customer's terminal between progress
  // lines and the success box — CXO trust hit on a flagship install moment.
  metadata: {
    description: string;
    version: string;
  };
  plugins: PluginEntry[];
}

const OWNER = {
  name: 'mySecond',
  email: 'support@mysecond.ai',
  url: 'https://mysecond.ai',
} as const;

const MARKETPLACE_DESCRIPTION =
  'Your mySecond PM Operating System — context, skills, hooks, and agents tailored to your company.';
const MARKETPLACE_VERSION = '1.0.0';

/**
 * Build the customer-marketplace's outer marketplace.json.
 *
 * Workstream B Day 5+: previously hardcoded `[{name: 'pm-os', source: './plugin'}]`
 * which silently overwrote PMO's tarball-internal manifest. PMO restructured
 * to a multi-plugin marketplace (~11 sub-plugins including the launch-critical
 * `pm-companion-sync`), so a single `pm-os` install was a no-op against the
 * server's actual plugin shape.
 *
 * Source-of-truth is now the PMO tarball's own marketplace.json, read via
 * `listMarketplacePluginsFromExtractDir()` and passed in here. This file
 * becomes a thin wrapper that adds owner/metadata to the plugins[] array.
 */
export function buildMarketplaceJson(
  slug: string,
  plugins: PluginEntry[]
): MarketplaceJson {
  return {
    name: marketplaceName(slug),
    owner: { ...OWNER },
    metadata: {
      description: MARKETPLACE_DESCRIPTION,
      version: MARKETPLACE_VERSION,
    },
    plugins,
  };
}

// Serialize with stable formatting so test snapshots are deterministic.
export function serializeMarketplaceJson(json: MarketplaceJson): string {
  return JSON.stringify(json, null, 2) + '\n';
}
