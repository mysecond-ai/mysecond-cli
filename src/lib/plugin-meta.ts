// Read the curated plugin contract version embedded in an extracted/installed
// plugin's `_meta.json` (the app's manifest.ts generateMetaJson writes it at the
// plugin root; the tarball extracts with strip:0 so it sits at the extract-dir
// root). Reading from the extracted BYTES — not a server response — guarantees
// the version we record equals what was ACTUALLY installed, so a stale tarball
// (built before a contract bump) is recorded as its real, older version and the
// nudge keeps firing until the customer truly has the new bytes (no skew bug).
//
// Fail-safe: any problem (missing file, bad JSON, missing/blank field) → null,
// which the nudge treats as "unknown installed version". NEVER throws —
// recording the contract version must never break install/refresh.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readInstalledPluginContractVersion(pluginRootDir: string): string | null {
  try {
    const raw = readFileSync(join(pluginRootDir, '_meta.json'), 'utf8');
    const parsed = JSON.parse(raw) as { plugin_contract_version?: unknown };
    const v = parsed.plugin_contract_version;
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}
